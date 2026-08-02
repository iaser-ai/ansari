import { eq, and, lt, gt, or, isNull, isNotNull } from 'drizzle-orm';
import { db } from './index';
import { users, tokens, type User, type NewUser, type Token, type NewToken } from '@/db/schema';
import { hashToken, generateToken } from '@/lib/auth/jwt';
import { config } from '@/lib/config';

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
  data: Partial<Pick<User, 'email' | 'passwordHash' | 'firstName' | 'lastName'>>
): Promise<User | undefined> {
  const result = await db
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
  exec: Executor = db
): Promise<{ accessToken: string; refreshToken: string }> {
  const { jwtSecret, accessTokenExpiryHours, refreshTokenExpiryHours } = config.auth;

  const accessToken = generateToken(userId, 'access', accessTokenExpiryHours, jwtSecret);
  const refreshToken = generateToken(userId, 'refresh', refreshTokenExpiryHours, jwtSecret);

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
export async function markTokenRotated(token: string): Promise<boolean> {
  const tokenHash = hashToken(token);
  const result = await db
    .update(tokens)
    .set({ rotatedAt: new Date() })
    .where(and(eq(tokens.tokenHash, tokenHash), isNull(tokens.rotatedAt)))
    .returning();
  return result.length > 0;
}

export async function deleteToken(token: string): Promise<boolean> {
  const tokenHash = hashToken(token);
  const result = await db.delete(tokens).where(eq(tokens.tokenHash, tokenHash)).returning();
  return result.length > 0;
}

export async function deleteUserTokens(userId: string, tokenType?: 'access' | 'refresh' | 'reset'): Promise<number> {
  let query = db.delete(tokens).where(eq(tokens.userId, userId));

  if (tokenType) {
    query = db.delete(tokens).where(and(eq(tokens.userId, userId), eq(tokens.tokenType, tokenType)));
  }

  const result = await query.returning();
  return result.length;
}

export async function deleteExpiredTokens(): Promise<number> {
  const now = new Date();
  const graceCutoff = new Date(now.getTime() - REFRESH_TOKEN_GRACE_MS);
  // Remove tokens that are past their expiry, plus rotated refresh tokens whose
  // grace window has closed (they can no longer authenticate anything).
  const result = await db
    .delete(tokens)
    .where(
      or(
        lt(tokens.expiresAt, now),
        and(isNotNull(tokens.rotatedAt), lt(tokens.rotatedAt, graceCutoff))
      )
    )
    .returning();
  return result.length;
}
