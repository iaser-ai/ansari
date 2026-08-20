import { eq } from 'drizzle-orm';
import { db } from './index';
import { shares, threads, messages, type Share, type NewShare, type ThreadSnapshot } from '@/db/schema';

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

  // Get all messages
  const threadMessages = await db
    .select()
    .from(messages)
    .where(eq(messages.threadId, threadId))
    .orderBy(messages.createdAt);

  // Create snapshot
  const snapshot: ThreadSnapshot = {
    threadName: thread[0].name,
    messages: threadMessages.map((m) => ({
      role: m.role,
      content: m.content,
      createdAt: m.createdAt?.toISOString() || new Date().toISOString(),
    })),
  };

  // Store share
  return createShare({
    threadId,
    content: snapshot,
  });
}
