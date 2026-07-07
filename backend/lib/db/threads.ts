import { eq, and, desc } from 'drizzle-orm';
import { db } from './index';
import {
  threads,
  messages,
  type Thread,
  type NewThread,
  type Message,
  type NewMessage,
} from '@/db/schema';

// Thread operations

export async function findThreadsByUser(userId: string): Promise<Thread[]> {
  return db
    .select()
    .from(threads)
    .where(eq(threads.userId, userId))
    .orderBy(desc(threads.updatedAt));
}

export async function findThreadById(id: string, userId?: string): Promise<Thread | undefined> {
  const conditions = userId
    ? and(eq(threads.id, id), eq(threads.userId, userId))
    : eq(threads.id, id);

  const result = await db.select().from(threads).where(conditions).limit(1);
  return result[0];
}

export async function createThread(data: {
  userId: string;
  name?: string;
  source?: string;
  client?: string | null;
}): Promise<Thread> {
  const result = await db
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
  data: { name?: string }
): Promise<Thread | undefined> {
  const result = await db
    .update(threads)
    .set({
      ...data,
      updatedAt: new Date(),
    })
    .where(and(eq(threads.id, id), eq(threads.userId, userId)))
    .returning();
  return result[0];
}

export async function deleteThread(id: string, userId: string): Promise<boolean> {
  const result = await db
    .delete(threads)
    .where(and(eq(threads.id, id), eq(threads.userId, userId)))
    .returning();
  return result.length > 0;
}

// Message operations

export async function findMessagesByThread(threadId: string): Promise<Message[]> {
  return db
    .select()
    .from(messages)
    .where(eq(messages.threadId, threadId))
    .orderBy(messages.createdAt);
}

export async function createMessage(data: NewMessage): Promise<Message> {
  // Also update the thread's updatedAt
  await db
    .update(threads)
    .set({ updatedAt: new Date() })
    .where(eq(threads.id, data.threadId));

  const result = await db.insert(messages).values(data).returning();
  return result[0];
}

export async function findMessageById(
  id: string,
  threadId?: string
): Promise<Message | undefined> {
  const conditions = threadId
    ? and(eq(messages.id, id), eq(messages.threadId, threadId))
    : eq(messages.id, id);

  const result = await db.select().from(messages).where(conditions).limit(1);
  return result[0];
}

// Get thread with all messages
export async function getThreadWithMessages(
  threadId: string,
  userId: string
): Promise<{ thread: Thread; messages: Message[] } | undefined> {
  const thread = await findThreadById(threadId, userId);
  if (!thread) return undefined;

  const threadMessages = await findMessagesByThread(threadId);
  return { thread, messages: threadMessages };
}
