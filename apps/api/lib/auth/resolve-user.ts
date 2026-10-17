import * as Sentry from '@sentry/nextjs';
import { and, eq, isNull } from 'drizzle-orm';
import { db } from '@/lib/db/index';
import { findUserById, insertAppUserRow, isUniqueViolation } from '@/lib/db/users';
import { deletedUsers, users, type User } from '@/db/schema';
import { isSystemAddress } from '@/lib/auth/system-accounts';
import {
  AuthServiceUnavailableError,
  deleteAuthUser,
  getAuthAccount,
} from '@/lib/auth-service/client';
import { safeErrorMeta } from '@/lib/log';

/**
 * A verified JWT's `sub` → the user's `public.users` row (spec 300, "Two
 * databases" rules 2, 3 and 5), in this order:
 *
 * 1. A row: the user (one indexed read, every request in steady state).
 * 2. No row and a tombstone: the account was deleted. Retry the auth-side
 *    delete if it is still owed, then refuse. A tombstoned id is never
 *    re-created, and never has a row.
 * 3. No row: the user signed up directly at apps/auth (or a layer insert
 *    failed). Fetch the profile from apps/auth's account endpoint, with the
 *    user's own JWT (owner amendment 2026-10-17), and insert the row
 *    with the same id, `ON CONFLICT (id) DO NOTHING`, so concurrent first
 *    requests create one row. An email on the reserved system domain, or one
 *    another row already holds (a system row included), is refused with no row
 *    written, an ids-only log and a Sentry alert.
 * 4. apps/auth does not know the id, or the token's session has ended: refuse.
 *
 * `unavailable` means apps/auth could not answer step 3; callers fail closed.
 */
export type ResolveResult =
  | { kind: 'user'; user: User }
  | { kind: 'refused' }
  | { kind: 'unavailable' };

const REFUSED: ResolveResult = { kind: 'refused' };

/** Rolls the first-use insert back when a delete committed while it ran. */
class TombstonedDuringInsert extends Error {}

type RefusalReason = 'reserved-domain' | 'system-email' | 'email-conflict';

/** Ids only: the email that collided is personal data and never logged. */
function alertRefusal(reason: RefusalReason, sub: string, holderId: string | null): ResolveResult {
  const ids = { sub, holderId };
  console.warn(`app row refused (${reason})`, ids);
  Sentry.captureMessage(`auth user has no app row: ${reason}`, {
    level: 'error',
    tags: { reason },
    extra: ids,
  });
  return REFUSED;
}

/**
 * Finish a delete whose auth half failed (rule 5). Best effort: the request is
 * refused either way, and the next request carrying this `sub`, a retry of
 * `DELETE me`, or the operator's completion script tries again.
 */
async function completePendingDelete(sub: string, jwt: string): Promise<void> {
  try {
    await deleteAuthUser(sub, jwt);
    await db
      .update(deletedUsers)
      .set({ authDeletedAt: new Date() })
      .where(and(eq(deletedUsers.id, sub), isNull(deletedUsers.authDeletedAt)));
  } catch (err) {
    const status = err instanceof AuthServiceUnavailableError ? err.status : null;
    console.warn('pending auth delete not completed', { sub, status, ...safeErrorMeta(err) });
  }
}

/** Who holds `email` in `public.users`, if anyone. */
async function emailHolder(email: string) {
  const rows = await db
    .select({ id: users.id, systemKey: users.systemKey })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);
  return rows[0];
}

/**
 * The refusal for an email that is taken, or null when it is free (or held by
 * this very id, which a concurrent first request has just inserted).
 */
async function refusalForHolder(email: string, sub: string): Promise<ResolveResult | null> {
  const holder = await emailHolder(email);
  if (!holder || holder.id === sub) return null;
  return alertRefusal(holder.systemKey ? 'system-email' : 'email-conflict', sub, holder.id);
}

export async function resolveUser(sub: string, jwt: string): Promise<ResolveResult> {
  // The app row first: it is every request in steady state, one indexed read.
  // A tombstoned id never has a row (DELETE me removes the row and writes the
  // tombstone in one transaction; the first-use insert below re-reads the
  // tombstone in its own transaction and rolls back; the orphan cleanup does
  // both together), so a row present means not deleted.
  const existing = await findUserById(sub);
  if (existing) return { kind: 'user', user: existing };

  // No row: a deleted account (refuse, and finish a pending auth-side delete)
  // or a first use. The tombstone is read only here.
  const [tombstone] = await db
    .select()
    .from(deletedUsers)
    .where(eq(deletedUsers.id, sub))
    .limit(1);
  if (tombstone) {
    if (!tombstone.authDeletedAt) await completePendingDelete(sub, jwt);
    return REFUSED;
  }

  let profile;
  try {
    profile = await getAuthAccount(sub, jwt);
  } catch (err) {
    if (err instanceof AuthServiceUnavailableError) {
      console.warn('profile fetch failed', { sub, status: err.status });
      return { kind: 'unavailable' };
    }
    throw err;
  }
  if (!profile) return REFUSED;

  const email = profile.email.trim().toLowerCase();
  if (isSystemAddress(email)) return alertRefusal('reserved-domain', sub, null);
  const taken = await refusalForHolder(email, sub);
  if (taken) return taken;

  // A concurrent `DELETE me` must not be undone. A tombstone check inside the
  // INSERT is not enough under READ COMMITTED: the INSERT can take its
  // snapshot before the delete commits, wait on the row the delete removes,
  // then insert after the tombstone is in. So the insert and a tombstone read
  // share one transaction; the read is a new statement, sees any tombstone
  // committed by then, and rolls the insert back.
  try {
    await db.transaction(async (tx) => {
      await insertAppUserRow(
        {
          id: sub,
          email,
          firstName: profile.first_name,
          lastName: profile.last_name,
          registeredVia: profile.registered_via,
        },
        tx
      );
      const [tombstoned] = await tx
        .select({ id: deletedUsers.id })
        .from(deletedUsers)
        .where(eq(deletedUsers.id, sub))
        .limit(1);
      if (tombstoned) throw new TombstonedDuringInsert();
    });
  } catch (err) {
    if (err instanceof TombstonedDuringInsert) return REFUSED;
    if (!isUniqueViolation(err)) throw err;
    // The email was taken between the check and the insert.
    return (await refusalForHolder(email, sub)) ?? alertRefusal('email-conflict', sub, null);
  }

  const created = await findUserById(sub);
  return created ? { kind: 'user', user: created } : REFUSED;
}
