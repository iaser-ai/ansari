import { eq, and, desc } from 'drizzle-orm';
import * as Sentry from '@sentry/nextjs';
import { db, type Executor } from './index';
import {
  threads,
  messages,
  toolCallOrphans,
  type Thread,
  type NewThread,
  type Message,
  type NewMessage,
  type ToolCallOrphan,
  type NewToolCallOrphan,
  type ToolCallRecord,
} from '@/db/schema';

/**
 * Message row as returned by the thread-listing read helpers
 * (findMessagesByThread / getThreadWithMessages): every column EXCEPT
 * `tool_calls` (spec 73). The projection is structural contract safety — the
 * thread GET, share snapshot, and history-replay paths all read through these
 * helpers and never select the tool records, so the frozen API shape cannot
 * leak them — and avoids detoasting ~7 KB median of jsonb per assistant row on
 * every turn's history load just to discard it. The single-message lookups
 * (findMessageById / findMessageInOwnedThread) still return full rows; they
 * feed feedback ownership checks, not API serialization. Analytics reads
 * select from `messages` directly.
 */
export type MessageRow = Omit<Message, 'toolCalls'>;

// Explicit projection for the read helpers. Adding a column to the schema does
// NOT add it here — that is the point; extend deliberately.
const messageReadColumns = {
  id: messages.id,
  threadId: messages.threadId,
  role: messages.role,
  content: messages.content,
  agentName: messages.agentName,
  source: messages.source,
  client: messages.client,
  inputTokens: messages.inputTokens,
  outputTokens: messages.outputTokens,
  thinkingTokens: messages.thinkingTokens,
  totalTokens: messages.totalTokens,
  // raw_payload stays: turn-2+ history replay needs it (issue #70).
  rawPayload: messages.rawPayload,
  createdAt: messages.createdAt,
};

// Every helper takes a trailing `exec` (issue #20) so callers can compose
// multi-step writes — including reads that must see uncommitted writes — into
// one `db.transaction`. Default is the module-level `db` (standalone behavior).

// Thread operations

export async function findThreadsByUser(userId: string, exec: Executor = db): Promise<Thread[]> {
  return exec
    .select()
    .from(threads)
    .where(eq(threads.userId, userId))
    .orderBy(desc(threads.updatedAt));
}

export async function findThreadById(
  id: string,
  userId?: string,
  exec: Executor = db
): Promise<Thread | undefined> {
  const conditions = userId
    ? and(eq(threads.id, id), eq(threads.userId, userId))
    : eq(threads.id, id);

  const result = await exec.select().from(threads).where(conditions).limit(1);
  return result[0];
}

export async function createThread(
  data: {
    userId: string;
    name?: string;
    source?: string;
    client?: string | null;
  },
  exec: Executor = db
): Promise<Thread> {
  const result = await exec
    .insert(threads)
    .values({
      userId: data.userId,
      name: data.name,
      source: data.source || 'web',
      // Use ?? null (not || 'web'): an absent header must persist NULL, and the
      // helper already returns null/'invalid', so no empty-string fallthrough.
      client: data.client ?? null,
    })
    .returning();
  return result[0];
}

export async function updateThread(
  id: string,
  userId: string,
  data: { name?: string },
  exec: Executor = db
): Promise<Thread | undefined> {
  const result = await exec
    .update(threads)
    .set({
      ...data,
      updatedAt: new Date(),
    })
    .where(and(eq(threads.id, id), eq(threads.userId, userId)))
    .returning();
  return result[0];
}

export async function deleteThread(id: string, userId: string, exec: Executor = db): Promise<boolean> {
  const result = await exec
    .delete(threads)
    .where(and(eq(threads.id, id), eq(threads.userId, userId)))
    .returning();
  return result.length > 0;
}

// Message operations

export async function findMessagesByThread(threadId: string, exec: Executor = db): Promise<MessageRow[]> {
  return exec
    .select(messageReadColumns)
    .from(messages)
    .where(eq(messages.threadId, threadId))
    .orderBy(messages.createdAt);
}

export async function createMessage(data: NewMessage, exec: Executor = db): Promise<Message> {
  // Also update the thread's updatedAt
  await exec
    .update(threads)
    .set({ updatedAt: new Date() })
    .where(eq(threads.id, data.threadId));

  const result = await exec.insert(messages).values(data).returning();
  return result[0];
}

/**
 * Persist tool dispatch records for a turn that produced NO assistant message
 * row (spec 73): facilitator error, empty final, or mcp-complete's 502.
 *
 * Unlike createMessage, this must NOT touch threads.updatedAt: an orphan write
 * is bookkeeping for a failed turn, and a bumped updated_at would change the
 * thread GET response — the write must be invisible in thread metadata too.
 */
export async function createToolCallOrphan(
  data: NewToolCallOrphan,
  exec: Executor = db
): Promise<ToolCallOrphan> {
  const result = await exec.insert(toolCallOrphans).values(data).returning();
  return result[0];
}

/**
 * Route-facing wrapper for the error/empty-final paths (spec 73): persist the
 * turn's tool records as an orphan row, or nothing when the turn dispatched no
 * tools. Never throws — a bookkeeping failure must not mask or delay the
 * user-facing error already on the wire — and logs only {name, code} (a raw
 * driver error can embed user content).
 */
export async function persistOrphanToolCalls(data: {
  threadId: string;
  reason: NewToolCallOrphan['reason'];
  source: string;
  client: string | null;
  toolCalls: ToolCallRecord[] | undefined;
}): Promise<void> {
  if (!data.toolCalls || data.toolCalls.length === 0) return;
  try {
    await createToolCallOrphan({
      threadId: data.threadId,
      reason: data.reason,
      source: data.source,
      client: data.client,
      toolCalls: data.toolCalls,
    });
  } catch (error) {
    const e = error as { name?: string; code?: string };
    const summary = {
      threadId: data.threadId,
      reason: data.reason,
      recordCount: data.toolCalls.length,
      name: e?.name,
      code: e?.code,
    };
    console.error('[tool-calls] orphan persist failed', summary);
    // A lost orphan row is exactly the undercount this column exists to remove —
    // surface it, at warning level (the user-facing error already fired).
    Sentry.captureMessage('tool-calls orphan persist failed', { level: 'warning', extra: summary });
  }
}

export async function findMessageById(
  id: string,
  threadId?: string,
  exec: Executor = db
): Promise<Message | undefined> {
  const conditions = threadId
    ? and(eq(messages.id, id), eq(messages.threadId, threadId))
    : eq(messages.id, id);

  const result = await exec.select().from(messages).where(conditions).limit(1);
  return result[0];
}

/**
 * Resolve a message ONLY when it belongs to `threadId` AND that thread is owned
 * by `userId` (spec 4). A single owner-scoped join closes the feedback IDOR: a
 * caller cannot attach feedback to — or probe the existence of — another user's
 * thread/message. Returns undefined for a nonexistent, foreign-owned, or
 * mismatched target alike, so the caller can return one uniform response and the
 * endpoint is not an existence oracle.
 */
export async function findMessageInOwnedThread(
  messageId: string,
  threadId: string,
  userId: string,
  exec: Executor = db
): Promise<Message | undefined> {
  const result = await exec
    .select({ message: messages })
    .from(messages)
    .innerJoin(threads, eq(messages.threadId, threads.id))
    .where(
      and(
        eq(messages.id, messageId),
        eq(messages.threadId, threadId),
        eq(threads.userId, userId)
      )
    )
    .limit(1);
  return result[0]?.message;
}

// Get thread with all messages
export async function getThreadWithMessages(
  threadId: string,
  userId: string,
  exec: Executor = db
): Promise<{ thread: Thread; messages: MessageRow[] } | undefined> {
  const thread = await findThreadById(threadId, userId, exec);
  if (!thread) return undefined;

  const threadMessages = await findMessagesByThread(threadId, exec);
  return { thread, messages: threadMessages };
}
