import { pgTable, uuid, timestamp } from 'drizzle-orm/pg-core';

/**
 * Tombstones for deleted accounts (spec 300). `DELETE /v2/users/me` deletes
 * the `users` row and writes the tombstone in one app-database transaction,
 * then asks apps/auth to delete the auth user and records `auth_deleted_at`.
 *
 * A tombstoned id is never re-created by the app-row profile path, and a
 * request carrying one gets 401. A row with `auth_deleted_at` NULL marks an
 * auth-side delete still owed. The id only: no personal data is kept.
 *
 * No foreign key to `users`: the row it names is gone by design.
 */
export const deletedUsers = pgTable('deleted_users', {
  id: uuid('id').primaryKey(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }).notNull().defaultNow(),
  authDeletedAt: timestamp('auth_deleted_at', { withTimezone: true }),
});

export type DeletedUser = typeof deletedUsers.$inferSelect;
export type NewDeletedUser = typeof deletedUsers.$inferInsert;
