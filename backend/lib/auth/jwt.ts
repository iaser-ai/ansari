import jwt from 'jsonwebtoken';
import crypto from 'crypto';

export type TokenType = 'access' | 'refresh' | 'reset';

export interface TokenPayload {
  user_id: string;
  type: TokenType;
  // Per-user session/credential version at issue time (spec 4). Checked on
  // validation against the user's current session_version so a password reset
  // (which bumps the version) invalidates every previously-issued token. Absent
  // on tokens minted before this field existed → treated as version 0.
  session_version?: number;
  iat: number;
  exp: number;
}

/**
 * Generate a JWT token
 * Matches Ansari's token structure: HS256 with user_id, type, and session_version claims
 */
export function generateToken(
  userId: string,
  tokenType: TokenType,
  expiryHours: number,
  secret: string,
  sessionVersion: number
): string {
  const payload: Omit<TokenPayload, 'iat' | 'exp'> = {
    user_id: userId,
    type: tokenType,
    session_version: sessionVersion,
  };

  return jwt.sign(payload, secret, {
    algorithm: 'HS256',
    expiresIn: `${expiryHours}h`,
  });
}

/**
 * Verify and decode a JWT token
 * Returns the payload if valid, null if invalid
 */
export function verifyToken(token: string, secret: string): TokenPayload | null {
  try {
    const payload = jwt.verify(token, secret, {
      algorithms: ['HS256'],
    }) as TokenPayload;
    return payload;
  } catch {
    return null;
  }
}

/**
 * Decode a token without verification (for debugging)
 */
export function decodeToken(token: string): TokenPayload | null {
  try {
    return jwt.decode(token) as TokenPayload;
  } catch {
    return null;
  }
}

/**
 * Hash a token for storage (we don't store raw tokens in DB)
 */
export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/**
 * Extract token from Authorization header
 * Expects: "Bearer <token>"
 */
export function extractBearerToken(authHeader: string | null): string | null {
  if (!authHeader) return null;
  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer') return null;
  return parts[1];
}
