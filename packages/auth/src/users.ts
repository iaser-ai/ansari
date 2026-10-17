// Direct reads and operator writes on `auth.users` that are not better-auth
// endpoints: apps/auth's account endpoints, its boot assertion, and the
// operator scripts (grant-admin, ban-user). The admin plugin's HTTP surface is
// blocked (spec 300), so roles and bans are set here, out of band.
//
// Emails are matched normalized, the way better-auth stores them.
import { and, asc, eq, gt } from 'drizzle-orm';

import type { Db } from './db';
import { normalizeEmail } from './reserved';
import { session, users } from './schema';

export const ADMIN_ROLE = 'admin';
/** The admin plugin's default role. */
export const USER_ROLE = 'user';

export type UserRecord = typeof users.$inferSelect;

export async function findUserById(db: Db, id: string): Promise<UserRecord | undefined> {
  const [user] = await db.select().from(users).where(eq(users.id, id));
  return user;
}

export async function findUserByEmail(db: Db, email: string): Promise<UserRecord | undefined> {
  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.email, normalizeEmail(email)));
  return user;
}

/**
 * True while session `sessionId` exists, belongs to `userId` and has not
 * expired: a JWT's `sid` is still a live session (sign-out, revocation, a
 * password reset and deletion all remove the row).
 */
export async function isSessionLive(
  db: Db,
  sessionId: string,
  userId: string,
  now: Date = new Date()
): Promise<boolean> {
  const rows = await db
    .select({ id: session.id })
    .from(session)
    .where(and(eq(session.id, sessionId), eq(session.userId, userId), gt(session.expiresAt, now)))
    .limit(1);
  return rows.length === 1;
}

/** True while a ban is in force: until `ban_expires`, or for good when it is unset. */
export function isBanned(
  user: Pick<UserRecord, 'banned' | 'banExpires'>,
  now: Date = new Date()
): boolean {
  return user.banned === true && (!user.banExpires || user.banExpires > now);
}

export class UserNotFoundError extends Error {
  constructor() {
    super('No auth user has this email');
    this.name = 'UserNotFoundError';
  }
}

/**
 * Set a user's role by email. Never creates a user and never touches a
 * credential: the account must already exist (signed up, or copied at the
 * cutover). Returns the user's id.
 */
export async function setRoleByEmail(db: Db, email: string, role: string): Promise<string> {
  const [updated] = await db
    .update(users)
    .set({ role })
    .where(eq(users.email, normalizeEmail(email)))
    .returning({ id: users.id });
  if (!updated) throw new UserNotFoundError();
  return updated.id;
}

/** Every user with role = 'admin', by email, for the admin audit. */
export async function listAdmins(db: Db): Promise<{ id: string; email: string }[]> {
  return db
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(eq(users.role, ADMIN_ROLE))
    .orderBy(asc(users.email));
}

export type BanOptions = { reason?: string | null; expiresAt?: Date | null };

/**
 * Ban a user and delete every session of theirs, in one transaction. The
 * admin plugin then refuses their sign-in, and no session is left to mint a
 * JWT. Returns the number of sessions deleted.
 */
export async function banUserByEmail(
  db: Db,
  email: string,
  options: BanOptions = {}
): Promise<number> {
  return db.transaction(async (tx) => {
    const [banned] = await tx
      .update(users)
      .set({
        banned: true,
        banReason: options.reason ?? null,
        banExpires: options.expiresAt ?? null,
      })
      .where(eq(users.email, normalizeEmail(email)))
      .returning({ id: users.id });
    if (!banned) throw new UserNotFoundError();
    const deleted = await tx
      .delete(session)
      .where(eq(session.userId, banned.id))
      .returning({ id: session.id });
    return deleted.length;
  });
}

/** Lift a ban: clears `banned`, `ban_reason` and `ban_expires`. */
export async function unbanUserByEmail(db: Db, email: string): Promise<void> {
  const [updated] = await db
    .update(users)
    .set({ banned: false, banReason: null, banExpires: null })
    .where(eq(users.email, normalizeEmail(email)))
    .returning({ id: users.id });
  if (!updated) throw new UserNotFoundError();
}
