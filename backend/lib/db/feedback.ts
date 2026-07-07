import { eq, and } from 'drizzle-orm';
import { db } from './index';
import { feedback, type Feedback, type NewFeedback } from '@/db/schema';

export async function createFeedback(data: NewFeedback): Promise<Feedback> {
  const result = await db.insert(feedback).values(data).returning();
  return result[0];
}

export async function findFeedbackByMessage(
  messageId: string,
  userId: string
): Promise<Feedback | undefined> {
  const result = await db
    .select()
    .from(feedback)
    .where(and(eq(feedback.messageId, messageId), eq(feedback.userId, userId)))
    .limit(1);
  return result[0];
}
