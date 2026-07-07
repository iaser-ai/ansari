import { eq, and, lt, gt, or, isNull, isNotNull } from 'drizzle-orm';
import { db } from './index';
import { users, tokens, type User, type NewUser, type Token, type NewToken } from '@/db/schema';
import { hashToken } from '@/lib/auth/jwt';

// Grace window during which a rotated refresh token stays valid. Lets the
// concurrent refreshes a SPA fires on access-token expiry all succeed instead
// of racing to delete the token and logging the user out (issue #34).
export const REFRESH_TOKEN_GRACE_MS = 60 * 1000;

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

export async function storeToken(data: {
  userId: string;
  token: string;
  tokenType: 'access' | 'refresh' | 'reset';
  expiresAt: Date;
}): Promise<Token> {
  const result = await db
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
