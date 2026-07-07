import { pgTable, uuid, text, timestamp, index } from 'drizzle-orm/pg-core';
import { users } from './users';

export const threads = pgTable('threads', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  name: text('name'),
  source: text('source').default('web'),
  // Per-request client attribution from the X-Ansari-Client header (spec 56).
  // Nullable, no default: absent header => NULL (unchanged behavior); a malformed
  // header is stored as the sentinel 'invalid'. Orthogonal to `source`.
  client: text('client'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
}, (table) => [
  index('idx_threads_user').on(table.userId, table.updatedAt),
]);

export type Thread = typeof threads.$inferSelect;
export type NewThread = typeof threads.$inferInsert;
