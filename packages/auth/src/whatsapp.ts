// The WhatsApp token exchange's decision (spec 329), without HTTP: resolve or
// create the BSUID's user, then, under a lock on that user's row, check
// eligibility and ban, write the session and sign.
// apps/auth's POST /api/whatsapp/session calls these after the key check and
// the per-user budget.
//
// A WhatsApp user is one auth user with no credential, found by its
// `{ providerId: 'whatsapp', accountId: <BSUID> }` account row, never by email
// or phone number. The BSUID is stored raw in `account.account_id` and nowhere
// else, and is never logged or returned. No phone number is stored anywhere
// (spec 329 §5, owner amendment 2): the route accepts and ignores it.
//
// The lock is `FOR NO KEY UPDATE`: it serializes exchanges for one user and
// waits out a ban or a role change (plain row updates), but not the `KEY SHARE`
// lock a session insert's foreign key takes, so no write, even on another
// connection, waits on the exchange's own lock (probe 4). Signing happens
// AFTER the commit: it reads `jwks` through the pool, and inside the
// transaction it would hold one connection while waiting for another, which
// starves the pool under load (probe 4, E2).
import { randomUUID } from 'node:crypto';

import { generateRandomString } from 'better-auth/crypto';
import { and, desc, eq, gte, sql } from 'drizzle-orm';

import type { Db } from './db';
import type { Auth } from './index';
import { JWT_LIFETIME_SECONDS, SESSION_LIFETIME_SECONDS } from './lifetimes';
import { EXCHANGE_LOCK_TIMEOUT, EXCHANGE_STATEMENT_TIMEOUT, SESSION_MARGIN } from './limits';
import { whatsappAddress } from './reserved';
import { account, session, users } from './schema';
import { isBanned, USER_ROLE } from './users';

/** The account provider that marks a WhatsApp user. Better Auth has no such provider, so no one signs in with it. */
export const WHATSAPP_PROVIDER_ID = 'whatsapp';

/** `users.registered_via` for a WhatsApp user. */
export const WHATSAPP_REGISTERED_VIA = 'whatsapp';

/** The display name of every WhatsApp user. */
export const WHATSAPP_USER_NAME = 'WhatsApp user';

/** `unique(provider_id, account_id)`: one user per BSUID under concurrency. */
const BSUID_CONSTRAINT = 'account_provider_id_account_id_unique';

const UNIQUE_VIOLATION = '23505';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/** The BSUID's user, by its `whatsapp` account row. */
async function findWhatsappUserId(db: Db, bsuid: string): Promise<string | undefined> {
  const [row] = await db
    .select({ userId: account.userId })
    .from(account)
    .where(and(eq(account.providerId, WHATSAPP_PROVIDER_ID), eq(account.accountId, bsuid)));
  return row?.userId;
}

/** True for a unique violation on `constraint`, raised directly or as a query error's cause. */
function isUniqueViolation(err: unknown, constraint: string): boolean {
  for (const e of [err, (err as { cause?: unknown } | null)?.cause]) {
    const { code, constraint: name } = (e ?? {}) as { code?: unknown; constraint?: unknown };
    if (code === UNIQUE_VIOLATION && name === constraint) return true;
  }
  return false;
}

export type ResolvedWhatsappUser = { userId: string; created: boolean };

/** Test seams: run between the lookup and the create, to force a concurrent winner. */
export type ResolveSeams = { beforeCreate?: () => Promise<void> };

/**
 * The BSUID's user, created with its `whatsapp` account row in one
 * transaction when there is none. The user's id is generated here, so the
 * address (`whatsapp-<id>@noreply.askansari.ai`) is unique by construction.
 * Of two concurrent creates for one BSUID, the loser's insert fails on
 * `unique(provider_id, account_id)`, rolls back, and returns the winner.
 */
export async function resolveOrCreateWhatsappUser(
  db: Db,
  bsuid: string,
  seams: ResolveSeams = {}
): Promise<ResolvedWhatsappUser> {
  const existing = await findWhatsappUserId(db, bsuid);
  if (existing) return { userId: existing, created: false };
  await seams.beforeCreate?.();

  const userId = randomUUID();
  try {
    await db.transaction(async (tx) => {
      await tx.insert(users).values({
        id: userId,
        name: WHATSAPP_USER_NAME,
        email: whatsappAddress(userId),
        role: USER_ROLE,
        registeredVia: WHATSAPP_REGISTERED_VIA,
      });
      await tx.insert(account).values({
        providerId: WHATSAPP_PROVIDER_ID,
        accountId: bsuid,
        userId,
      });
    });
    return { userId, created: true };
  } catch (err) {
    if (!isUniqueViolation(err, BSUID_CONSTRAINT)) throw err;
    const winner = await findWhatsappUserId(db, bsuid);
    if (!winner) throw err;
    return { userId: winner, created: false };
  }
}

/** Why a user behind a `whatsapp` row may not get a token. Logged with the user id; never the BSUID. */
export type IneligibleReason =
  /** Not exactly one account row, the `whatsapp` row for this BSUID. */
  | 'accounts'
  /** The address is not this user's `whatsapp-<id>@noreply.askansari.ai`. */
  | 'address'
  | 'registered_via'
  /**
   * The role is anything but exactly `user` (an allowlist: better-auth's admin
   * plugin reads a comma-separated `user,admin` as admin, and roles are free text).
   */
  | 'role';

export type WhatsappTokenRequest = {
  userId: string;
  bsuid: string;
};

export type WhatsappTokenOutcome =
  | { kind: 'issued'; token: string; sessionId: string }
  /** The ban was in force under the lock; every session of the user was deleted. */
  | { kind: 'banned' }
  /** A row a person could not have made is behind this BSUID: no token until an operator repairs it. */
  | { kind: 'ineligible'; reason: IneligibleReason }
  /** Deleted between resolve and lock; the next message creates a new user. */
  | { kind: 'user-gone' };

type Decision =
  | { kind: 'session'; sessionId: string }
  | Exclude<WhatsappTokenOutcome, { kind: 'issued' }>;

type TokenTimes = { iat: number; exp: number };

/**
 * The exchange's whole decision, in the caller's transaction, under a
 * `FOR NO KEY UPDATE` lock on the user's row: the user re-read, eligibility,
 * the ban and the session. Nothing here signs or spends a
 * rate-limit budget.
 */
async function decideUnderLock(
  tx: Tx,
  { userId, bsuid }: WhatsappTokenRequest,
  { exp }: TokenTimes,
  now: Date
): Promise<Decision> {
  await tx.execute(sql`SELECT set_config('lock_timeout', ${`${EXCHANGE_LOCK_TIMEOUT}ms`}, true)`);
  await tx.execute(
    sql`SELECT set_config('statement_timeout', ${`${EXCHANGE_STATEMENT_TIMEOUT}ms`}, true)`
  );
  const [user] = await tx.select().from(users).where(eq(users.id, userId)).for('no key update');
  if (!user) return { kind: 'user-gone' };

  const accounts = await tx
    .select({ providerId: account.providerId, accountId: account.accountId })
    .from(account)
    .where(eq(account.userId, userId));
  const [only] = accounts;
  if (accounts.length !== 1 || only?.providerId !== WHATSAPP_PROVIDER_ID || only.accountId !== bsuid) {
    return { kind: 'ineligible', reason: 'accounts' };
  }
  if (user.email !== whatsappAddress(userId)) return { kind: 'ineligible', reason: 'address' };
  if (user.registeredVia !== WHATSAPP_REGISTERED_VIA) return { kind: 'ineligible', reason: 'registered_via' };
  if (user.role !== USER_ROLE) return { kind: 'ineligible', reason: 'role' };

  if (isBanned(user, now)) {
    await tx.delete(session).where(eq(session.userId, userId));
    return { kind: 'banned' };
  }

  const mustOutlive = new Date(exp * 1000 + SESSION_MARGIN);
  const [live] = await tx
    .select({ id: session.id })
    .from(session)
    .where(and(eq(session.userId, userId), gte(session.expiresAt, mustOutlive)))
    .orderBy(desc(session.expiresAt))
    .limit(1);
  if (live) return { kind: 'session', sessionId: live.id };

  // A session as better-auth's own createSession writes one without a request:
  // its 32-character [A-Za-z0-9] token (a 30-day bearer credential), empty IP
  // address and user agent, and the configured lifetime.
  await tx.delete(session).where(eq(session.userId, userId));
  const [created] = await tx
    .insert(session)
    .values({
      token: generateRandomString(32, 'a-z', 'A-Z', '0-9'),
      expiresAt: new Date(now.getTime() + SESSION_LIFETIME_SECONDS * 1000),
      createdAt: now,
      updatedAt: now,
      ipAddress: '',
      userAgent: '',
      userId,
    })
    .returning({ id: session.id });
  if (!created) throw new Error('session insert returned no row');
  return { kind: 'session', sessionId: created.id };
}

/**
 * Decide under the user's lock, commit, then sign `{sub, sid, iat, exp}` with
 * the jwt plugin, passing `iat` and `exp` explicitly so the claim set equals
 * `/api/auth/token`'s. At signing time the session outlives the token: its
 * `expiresAt` was checked against this `exp` before the commit. A lock or
 * statement timeout, an outage or a signing failure throws (a 500); a session
 * written before a signing failure stays and is reused next time.
 */
export async function issueWhatsappToken(
  auth: Auth,
  db: Db,
  request: WhatsappTokenRequest
): Promise<WhatsappTokenOutcome> {
  const now = new Date();
  const iat = Math.floor(now.getTime() / 1000);
  const times = { iat, exp: iat + JWT_LIFETIME_SECONDS };
  const decision = await db.transaction((tx) => decideUnderLock(tx, request, times, now));
  if (decision.kind !== 'session') return decision;

  const { token } = await auth.api.signJWT({
    body: { payload: { sub: request.userId, sid: decision.sessionId, ...times } },
  });
  return { kind: 'issued', token, sessionId: decision.sessionId };
}
