/**
 * TARGET-SIDE: inserts one user's threads and messages into THIS repo's `threads` /
 * `messages` tables inside a caller-supplied transaction. Rows are marked
 * `source='legacy'` — the read-only marker that dedup and `delete-readonly` key on.
 *
 * This is one of the modules that gets REWRITTEN for the next use (ansari-multisage →
 * Better Auth): the target tables and their column set change.
 *
 * Column inventory: every column this schema has gained since the original script's
 * schema copy (migrations 0002–0008) is listed at the insert sites below as a
 * `TODO(port)` — NOT populated, NOT verified. The README carries the same table.
 *
 * Part of a PARTIAL PORT — NOT VERIFIED AGAINST THE CURRENT SCHEMA — NOT FOR PROD.
 */
import type { Executor } from '../../../lib/db/index';
import { threads, messages } from '../../../db/schema';
import { filterMessage } from '../source/content-filter';
import type { SourceThread } from '../types';
import type { ThreadMapping } from '../mapping-writer';

export interface MigrateThreadsResult {
  threadsInserted: number;
  messagesInserted: number;
  messagesFiltered: number;
  threadsSkipped: number;
  threadMappings: ThreadMapping[];
}

export async function migrateThreadsForUser(
  mongoUserId: string,
  postgresUserId: string,
  sourceThreads: SourceThread[],
  tx: Executor,
  options: { dryRun: boolean },
): Promise<MigrateThreadsResult> {
  const result: MigrateThreadsResult = {
    threadsInserted: 0,
    messagesInserted: 0,
    messagesFiltered: 0,
    threadsSkipped: 0,
    threadMappings: [],
  };

  for (const thread of sourceThreads) {
    // Filter messages BEFORE inserting the thread so an all-filtered thread never
    // leaves an empty row behind.
    const filteredMessages = thread.messages
      .map((msg) => filterMessage(msg))
      .filter((m): m is NonNullable<typeof m> => m !== null);

    result.messagesFiltered += thread.messages.length - filteredMessages.length;

    // Skip empty threads
    if (filteredMessages.length === 0) {
      console.warn(`  [thread] Skipping empty thread "${thread.name}" (all messages filtered)`);
      result.threadsSkipped++;
      continue;
    }

    if (options.dryRun) {
      console.log(`  [DRY RUN] Would insert thread "${thread.name}" with ${filteredMessages.length} messages`);
      result.threadsInserted++;
      result.messagesInserted += filteredMessages.length;
      continue;
    }

    // Insert thread. Timestamps come from the source (NOT lib/db/threads.createThread,
    // which stamps now()); `createdAt` is the dedup key for re-runs.
    const [insertedThread] = await tx
      .insert(threads)
      .values({
        userId: postgresUserId,
        name: thread.name,
        source: 'legacy',
        createdAt: thread.createdAt,
        updatedAt: thread.updatedAt,
        // TODO(port): threads.client (0002) — per-request X-Ansari-Client attribution;
        // the legacy source has no equivalent. Left at its default (NULL). Unverified.
      })
      .returning({ id: threads.id });

    // Insert filtered messages (NOT lib/db/threads.createMessage, which bumps the
    // thread's updated_at).
    for (const msg of filteredMessages) {
      await tx.insert(messages).values({
        threadId: insertedThread.id,
        role: msg.role,
        content: msg.content,
        agentName: null,
        source: 'legacy',
        createdAt: msg.createdAt ?? thread.createdAt,
        // TODO(port): messages.client (0002) — no per-request client in the source.
        //   Left at default (NULL).
        // TODO(port): messages.input_tokens / output_tokens / thinking_tokens /
        //   total_tokens — no usage accounting in the source. Left at default (NULL).
        // TODO(port): messages.raw_payload (0004) — Gemini replay payload; the source
        //   has none. Left at default (NULL).
        // TODO(port): messages.tool_calls (0007) — legacy tool_use/tool_result blocks
        //   are DROPPED by source/content-filter.ts, not converted to ToolCallRecord
        //   (which needs status/duration_ms the source lacks). Left at default (NULL,
        //   which is the schema's "turn invoked no tools" value — never []).
        // TODO(port): messages.model_provider / model_id (0008) — provenance of the
        //   legacy turn is unknown. Left at default (NULL).
      });
    }

    result.threadsInserted++;
    result.messagesInserted += filteredMessages.length;
    result.threadMappings.push({
      type: 'thread',
      mongoId: thread.mongoId,
      postgresId: insertedThread.id,
      userId: postgresUserId,
      messageCount: filteredMessages.length,
    });
  }

  return result;
}
