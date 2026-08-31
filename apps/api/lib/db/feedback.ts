import { eq, and, sql } from 'drizzle-orm';
import { db, type Executor } from './index';
import { feedback, type Feedback, type NewFeedback } from '@/db/schema';

// Helpers take a trailing `exec` (issue #20) so callers can compose multi-step
// writes into one `db.transaction`. Default is the module-level `db`.

// Idempotent per (user, message, class) via ON CONFLICT on
// idx_feedback_user_message_class (issue #87): a repeat POST updates the
// existing row instead of minting a new one. The COALESCE(NULLIF(...)) guard
// is load-bearing — a bare repeat POST (empty/absent comment) must never wipe
// a previously saved comment. created_at stays first-touch.
export async function upsertFeedback(data: NewFeedback, exec: Executor = db): Promise<Feedback> {
  const result = await exec
    .insert(feedback)
    .values(data)
    .onConflictDoUpdate({
      target: [feedback.userId, feedback.messageId, feedback.feedbackClass],
      set: {
        comment: sql`COALESCE(NULLIF(excluded."comment", ''), ${feedback.comment})`,
      },
    })
    .returning();
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
