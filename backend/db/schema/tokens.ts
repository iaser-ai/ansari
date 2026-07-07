import { pgTable, uuid, text, timestamp, index } from 'drizzle-orm/pg-core';
import { users } from './users';

export const tokens = pgTable('tokens', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  tokenType: text('token_type').notNull(), // 'access', 'refresh', 'reset'
  tokenHash: text('token_hash').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  // Set when a refresh token is rotated. During the grace window the token
  // stays valid so concurrent refreshes don't fail (see issue #34).
  rotatedAt: timestamp('rotated_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (table) => [
  index('idx_tokens_hash').on(table.tokenHash),
  index('idx_tokens_user_type').on(table.userId, table.tokenType),
]);

export type Token = typeof tokens.$inferSelect;
export type NewToken = typeof tokens.$inferInsert;
