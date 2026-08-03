import { eq, and, desc } from 'drizzle-orm';
import { db, type Executor } from './index';
import {
  threads,
  messages,
  type Thread,
  type NewThread,
  type Message,
  type NewMessage,
} from '@/db/schema';

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

export async function findMessagesByThread(threadId: string, exec: Executor = db): Promise<Message[]> {
  return exec
    .select()
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
): Promise<{ thread: Thread; messages: Message[] } | undefined> {
  const thread = await findThreadById(threadId, userId, exec);
  if (!thread) return undefined;

  const threadMessages = await findMessagesByThread(threadId, exec);
  return { thread, messages: threadMessages };
}
