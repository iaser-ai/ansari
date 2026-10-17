import { pgTable, uuid, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').unique().notNull(),
  firstName: text('first_name'),
  lastName: text('last_name'),
  source: text('source').default('web'),
  // Account-level client attribution: which client the account registered
  // through, from the X-Ansari-Client header at register time (spec 56).
  // Nullable, no default: absent header => NULL. Separate from `source`.
  registeredVia: text('registered_via'),
  // Non-registerable marker identifying a system account (spec 4). NULL for real users;
  // 'ai-skill' / 'leaderboard' for the two system identities. System-user lookup keys on
  // this, not on email, so a pre-registered look-alike can never receive system data.
  systemKey: text('system_key'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
}, (table) => [
  // Unique so each system identity maps to exactly one row. Postgres treats NULLs as
  // distinct, so the many real users (system_key NULL) do not collide.
  uniqueIndex('idx_users_system_key').on(table.systemKey),
]);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
