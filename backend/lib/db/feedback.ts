import { eq, and } from 'drizzle-orm';
import { db, type Executor } from './index';
import { feedback, type Feedback, type NewFeedback } from '@/db/schema';

// Helpers take a trailing `exec` (issue #20) so callers can compose multi-step
// writes into one `db.transaction`. Default is the module-level `db`.

export async function createFeedback(data: NewFeedback, exec: Executor = db): Promise<Feedback> {
  const result = await exec.insert(feedback).values(data).returning();
  return result[0];
}

export async function findFeedbackByMessage(
  messageId: string,
  userId: string,
  exec: Executor = db
): Promise<Feedback | undefined> {
  const result = await exec
    .select()
    .from(feedback)
    .where(and(eq(feedback.messageId, messageId), eq(feedback.userId, userId)))
    .limit(1);
  return result[0];
}
