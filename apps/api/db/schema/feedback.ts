import { pgTable, uuid, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { users } from './users';
import { threads } from './threads';
import { messages } from './messages';

export const feedback = pgTable('feedback', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  threadId: uuid('thread_id').references(() => threads.id, { onDelete: 'cascade' }).notNull(),
  messageId: uuid('message_id').references(() => messages.id, { onDelete: 'cascade' }).notNull(),
  feedbackClass: text('feedback_class').notNull(),
  comment: text('comment'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (table) => [
  // One row per (user, message, class) — both the ON CONFLICT target for the
  // POST /api/v2/feedback upsert and the at-rest dedup guarantee (issue #87).
  // feedback_class stays in the key so thumbs_up/thumbs_down/report coexist.
  uniqueIndex('idx_feedback_user_message_class').on(
    table.userId,
    table.messageId,
    table.feedbackClass
  ),
]);

export type Feedback = typeof feedback.$inferSelect;
export type NewFeedback = typeof feedback.$inferInsert;
