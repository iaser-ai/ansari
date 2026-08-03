import { eq, and, lt, gt, or, isNull, sql } from 'drizzle-orm';
import { db } from './index';
import { users, tokens, type User, type NewUser, type Token, type NewToken } from '@/db/schema';
import { hashToken, generateToken } from '@/lib/auth/jwt';
import { config } from '@/lib/config';
import { SYSTEM_ACCOUNTS, type SystemKey } from '@/lib/auth/system-accounts';

// Grace window during which a rotated refresh token stays valid. Lets the
// concurrent refreshes a SPA fires on access-token expiry all succeed instead
// of racing to delete the token and logging the user out (issue #34).
export const REFRESH_TOKEN_GRACE_MS = 60 * 1000;

// A database executor: either the module-level `db` or a transaction handle
// passed to `db.transaction(async (tx) => ...)`. Token helpers accept this so a
// caller (e.g. atomic refresh rotation) can run them inside one transaction.
// Defined here in Phase 2 (config/token consolidation); Phase 7 threads a `tx`
// through the rotation/reset path. Until then every caller passes the default `db`.
type Executor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

// User operations

export async function findUserByEmail(email: string): Promise<User | undefined> {
  const result = await db.select().from(users).where(eq(users.email, email.toLowerCase())).limit(1);
  return result[0];
}

/**
 * Resolve a system account by its durable `system_key` (spec 4) — never by email.
 * Returns undefined if no row carries that key (a pre-registered look-alike, which
 * has `system_key = NULL`, is therefore never resolved as a system account).
 */
export async function findSystemUser(systemKey: SystemKey): Promise<User | undefined> {
  const result = await db.select().from(users).where(eq(users.systemKey, systemKey)).limit(1);
  return result[0];
}

/**
 * Resolve, or lazily provision, the system account for `systemKey`. The created
 * row is identified by `system_key` (unregisterable) and carries a `nologin`
 * password hash so it can never be logged into.
 *
 * If the canonical system email is already held by a NON-system account
 * (pre-registration / hijack — the vulnerability spec 4 closes), provisioning
 * fails fast with an operator-actionable error rather than misrouting system data
 * or looping. The migration's inspect-before-apply step prevents this in practice.
 */
/**
 * True for a Postgres unique-constraint violation (SQLSTATE 23505). Walks the
 * `.cause` chain because drizzle wraps the driver error (the pg/pglite error,
 * which carries `code`, is nested under `.cause`).
 */
export function isUniqueViolation(err: unknown): boolean {
  let e: unknown = err;
  for (let depth = 0; depth < 5 && e && typeof e === 'object'; depth++) {
    if ((e as { code?: unknown }).code === '23505') return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

export async function getOrCreateSystemUser(systemKey: SystemKey): Promise<User> {
  const existing = await findSystemUser(systemKey);
  if (existing) return existing;

  const account = SYSTEM_ACCOUNTS[systemKey];
  try {
    const result = await db
      .insert(users)
      .values({
        email: account.email,
        passwordHash: 'nologin',
        firstName: account.firstName,
        lastName: account.lastName,
        source: systemKey,
        systemKey,
      })
      .returning();
    return result[0];
  } catch (err) {
    // Only a unique-constraint violation is an expected, interpretable failure
    // here. Anything else (DB outage, permission, schema error) must propagate
    // unchanged rather than be misreported as an occupied system email.
    if (!isUniqueViolation(err)) throw err;

    // A unique violation is one of two cases:
    //  - system_key race: a concurrent request created the row first → re-read by key.
    const raced = await findSystemUser(systemKey);
    if (raced) return raced;
    //  - the email is held by a non-system row (hijack): cannot proceed safely.
    throw new Error(
      `System account '${systemKey}' cannot be provisioned: its address is already held by a ` +
        `non-system account. Remediate the occupying row before deploy (migration inspect-before-apply step).`
    );
  }
}

export async function findUserById(id: string): Promise<User | undefined> {
  const result = await db.select().from(users).where(eq(users.id, id)).limit(1);
  return result[0];
}

export async function createUser(data: {
  email: string;
  passwordHash: string;
  firstName?: string;
  lastName?: string;
  source?: string;
  registeredVia?: string | null;
}): Promise<User> {
  const result = await db
    .insert(users)
    .values({
      email: data.email.toLowerCase(),
      passwordHash: data.passwordHash,
      firstName: data.firstName,
      lastName: data.lastName,
      source: data.source || 'web',
      // ?? null: absent header persists NULL (account not attributed to a client).
      registeredVia: data.registeredVia ?? null,
    })
    .returning();
  return result[0];
}

export async function updateUser(
  id: string,
  data: Partial<Pick<User, 'email' | 'passwordHash' | 'firstName' | 'lastName'>>,
  exec: Executor = db
): Promise<User | undefined> {
  const result = await exec
    .update(users)
    .set({
      ...data,
      email: data.email?.toLowerCase(),
      updatedAt: new Date(),
    })
    .where(eq(users.id, id))
    .returning();
  return result[0];
}

/**
 * Increment a user's session/credential version (spec 4). Bumped by password
 * reset inside the reset transaction so every previously-issued token — whose
 * embedded session_version is now stale — fails validation. Pass `exec` to run
 * it in the same transaction as the token revocation.
 */
export async function bumpSessionVersion(id: string, exec: Executor = db): Promise<void> {
  await exec
    .update(users)
    .set({ sessionVersion: sql`${users.sessionVersion} + 1`, updatedAt: new Date() })
    .where(eq(users.id, id));
}

export async function deleteUser(id: string): Promise<boolean> {
  const result = await db.delete(users).where(eq(users.id, id)).returning();
  return result.length > 0;
}

// Token operations

export async function storeToken(
  data: {
    userId: string;
    token: string;
    tokenType: 'access' | 'refresh' | 'reset';
    expiresAt: Date;
  },
  exec: Executor = db
): Promise<Token> {
  const result = await exec
    .insert(tokens)
    .values({
      userId: data.userId,
      tokenHash: hashToken(data.token),
      tokenType: data.tokenType,
      expiresAt: data.expiresAt,
    })
    .returning();
  return result[0];
}

/**
 * Issue a fresh access + refresh token pair for a user, storing both (hashed).
 * The single generate-and-store site for the login/register/refresh routes,
 * sourcing the JWT secret and expiries from validated `config.auth` (not
 * process.env). Pass `exec` to run the inserts inside a transaction (Phase 7).
 */
export async function issueTokenPair(
  userId: string,
  sessionVersion: number,
  exec: Executor = db
): Promise<{ accessToken: string; refreshToken: string }> {
  const { jwtSecret, accessTokenExpiryHours, refreshTokenExpiryHours } = config.auth;

  // sessionVersion is passed in (captured by the caller at authorization time),
  // never re-read here — see the refresh route's atomic-rotation comment.
  const accessToken = generateToken(userId, 'access', accessTokenExpiryHours, jwtSecret, sessionVersion);
  const refreshToken = generateToken(userId, 'refresh', refreshTokenExpiryHours, jwtSecret, sessionVersion);

  const now = Date.now();
  await storeToken(
    {
      userId,
      token: accessToken,
      tokenType: 'access',
      expiresAt: new Date(now + accessTokenExpiryHours * 60 * 60 * 1000),
    },
    exec
  );
  await storeToken(
    {
      userId,
      token: refreshToken,
      tokenType: 'refresh',
      expiresAt: new Date(now + refreshTokenExpiryHours * 60 * 60 * 1000),
    },
    exec
  );

  return { accessToken, refreshToken };
}

export async function findToken(token: string): Promise<(Token & { user: User }) | undefined> {
  const tokenHash = hashToken(token);
  const now = new Date();
  const graceCutoff = new Date(now.getTime() - REFRESH_TOKEN_GRACE_MS);
  // A token is valid while unexpired AND either never rotated (rotated_at IS
  // NULL — always true for access tokens, which never rotate) or rotated within
  // the grace window.
  const result = await db
    .select()
    .from(tokens)
    .innerJoin(users, eq(tokens.userId, users.id))
    .where(
      and(
        eq(tokens.tokenHash, tokenHash),
        gt(tokens.expiresAt, now),
        or(isNull(tokens.rotatedAt), gt(tokens.rotatedAt, graceCutoff))
      )
    )
    .limit(1);

  if (result.length === 0) return undefined;
  return {
    ...result[0].tokens,
    user: result[0].users,
  };
}

/**
 * Mark a refresh token as rotated, starting its grace window. Pinned to the
 * FIRST rotation (`rotated_at IS NULL` guard) so repeated concurrent refreshes
 * can't slide the window forward and keep a spent token alive indefinitely.
 */
export async function markTokenRotated(token: string, exec: Executor = db): Promise<boolean> {
  const tokenHash = hashToken(token);
  const result = await exec
    .update(tokens)
    .set({ rotatedAt: new Date() })
    .where(and(eq(tokens.tokenHash, tokenHash), isNull(tokens.rotatedAt)))
    .returning();
  return result.length > 0;
}

/**
 * Refresh-token lookup with rotated-reuse detection (spec 4). Distinguishes:
 *  - `valid`     — unexpired and either never rotated or rotated within the grace
 *                  window (lets concurrent refreshes both succeed, issue #34);
 *  - `reuse`     — a retained row that was rotated MORE than the grace window ago
 *                  but has not yet reached natural expiry: a spent token being
 *                  replayed → reject + log (the caller does the logging);
 *  - `not_found` — unknown hash, or past natural expiry (the sweep may reclaim it).
 * Unlike `findToken`, this keys on `token_type = 'refresh'` and returns the user
 * so the caller can check `session_version`.
 */
export type RefreshLookup =
  | { status: 'valid'; user: User }
  | { status: 'reuse'; userId: string }
  | { status: 'not_found' };

export async function lookupRefreshToken(token: string, exec: Executor = db): Promise<RefreshLookup> {
  const tokenHash = hashToken(token);
  const now = new Date();
  const graceCutoff = new Date(now.getTime() - REFRESH_TOKEN_GRACE_MS);

  const result = await exec
    .select()
    .from(tokens)
    .innerJoin(users, eq(tokens.userId, users.id))
    .where(and(eq(tokens.tokenHash, tokenHash), eq(tokens.tokenType, 'refresh')))
    .limit(1);

  if (result.length === 0) return { status: 'not_found' };
  const { tokens: tok, users: user } = result[0];

  // Past natural expiry → gone (indistinguishable from unknown; the sweep reclaims it).
  if (tok.expiresAt <= now) return { status: 'not_found' };
  // Never rotated, or rotated within the grace window → still valid.
  if (tok.rotatedAt === null || tok.rotatedAt > graceCutoff) return { status: 'valid', user };
  // Rotated before the grace window closed, but retained (not yet expired) → reuse.
  // Carry the user id so the caller can log which account's token was replayed.
  return { status: 'reuse', userId: user.id };
}

export async function deleteToken(token: string, exec: Executor = db): Promise<boolean> {
  const tokenHash = hashToken(token);
  const result = await exec.delete(tokens).where(eq(tokens.tokenHash, tokenHash)).returning();
  return result.length > 0;
}

export async function deleteUserTokens(
  userId: string,
  tokenType?: 'access' | 'refresh' | 'reset',
  exec: Executor = db
): Promise<number> {
  const where = tokenType
    ? and(eq(tokens.userId, userId), eq(tokens.tokenType, tokenType))
    : eq(tokens.userId, userId);

  const result = await exec.delete(tokens).where(where).returning();
  return result.length;
}

export async function deleteExpiredTokens(): Promise<number> {
  const now = new Date();
  // Delete ONLY tokens past their natural expiry (spec 4). A rotated refresh token
  // whose grace window has closed but which has NOT yet expired is deliberately
  // RETAINED so its replay is still detectable as reuse (lookupRefreshToken →
  // 'reuse') rather than reading as an unknown/forged token.
  const result = await db.delete(tokens).where(lt(tokens.expiresAt, now)).returning();
  return result.length;
}

// Probability that a token-issuing request opportunistically sweeps expired tokens.
const EXPIRED_SWEEP_PROBABILITY = 0.02;

/**
 * Opportunistically (low probability, fire-and-forget) sweep past-expiry tokens so
 * the `tokens` table doesn't grow unbounded (spec 4). No cron — the sweep piggybacks
 * on token-issuing requests. Non-blocking: it never awaits and swallows errors, so a
 * sweep failure cannot affect the auth response. Uses the global `db`, independent of
 * any caller transaction.
 */
export function maybeSweepExpiredTokens(): void {
  if (Math.random() < EXPIRED_SWEEP_PROBABILITY) {
    deleteExpiredTokens().catch((err) => {
      console.error('Opportunistic token sweep failed:', err instanceof Error ? err.message : err);
    });
  }
}
