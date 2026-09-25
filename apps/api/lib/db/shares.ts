import { eq } from 'drizzle-orm';
import { db } from './index';
import { shares, threads, messages, type Share, type NewShare, type ThreadSnapshot } from '@/db/schema';
import { findCitableDocumentsByThread } from './citable-documents';

export async function createShare(data: NewShare): Promise<Share> {
  const result = await db.insert(shares).values(data).returning();
  return result[0];
}

export async function findShareById(id: string): Promise<Share | undefined> {
  const result = await db.select().from(shares).where(eq(shares.id, id)).limit(1);
  return result[0];
}

export async function createThreadSnapshot(
  threadId: string,
  userId: string
): Promise<Share | undefined> {
  // Find the thread
  const thread = await db
    .select()
    .from(threads)
    .where(eq(threads.id, threadId))
    .limit(1);

  if (!thread[0] || thread[0].userId !== userId) {
    return undefined;
  }

  // Get all messages — explicit projection of ONLY the snapshot's fields.
  // tool_calls / raw_payload are internal columns that must never enter a
  // serialized snapshot (spec 73): not selecting them makes that structural.
  // Citable documents come from lib/db/citable-documents.ts below, which
  // returns derived blocks only (spec 168).
  const threadMessages = await db
    .select({
      // Lookup key for the citable documents only — never written to the snapshot.
      id: messages.id,
      role: messages.role,
      content: messages.content,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .where(eq(messages.threadId, threadId))
    // Same thread order as findMessagesByThread, id breaking created_at ties (spec 168).
    .orderBy(messages.createdAt, messages.id);

  // Citable sources are derived once, now, and copied into the snapshot
  // (spec 168), so the public share endpoints never read tool_calls. Only the
  // derived blocks come back from the helper — never the raw records.
  const documentsByMessage = new Map(
    (await findCitableDocumentsByThread(threadId)).map((e) => [e.messageId, e.documents])
  );

  // Create snapshot
  const snapshot: ThreadSnapshot = {
    threadName: thread[0].name,
    messages: threadMessages.map((m) => {
      const documents = documentsByMessage.get(m.id);
      return {
        role: m.role,
        content: m.content,
        createdAt: m.createdAt?.toISOString() || new Date().toISOString(),
        ...(documents ? { documents } : {}),
      };
    }),
  };

  // Store share
  return createShare({
    threadId,
    content: snapshot,
  });
}
