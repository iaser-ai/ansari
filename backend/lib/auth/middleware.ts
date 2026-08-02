import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { extractBearerToken, verifyToken } from './jwt';
import { findToken } from '@/lib/db/users';
import { config } from '@/lib/config';
import type { User } from '@/db/schema';

export type AuthenticatedRequest = NextRequest & {
  user: User;
};

/**
 * Authenticate a request using the Authorization header
 * Returns the user if valid, or a 401 response
 */
export async function authenticateRequest(
  request: NextRequest
): Promise<{ user: User } | { error: NextResponse }> {
  const authHeader = request.headers.get('Authorization');
  const token = extractBearerToken(authHeader);

  if (!token) {
    return {
      error: NextResponse.json(
        { detail: 'Not authenticated' },
        { status: 401 }
      ),
    };
  }

  // Verify the token signature
  const payload = verifyToken(token, config.auth.jwtSecret);
  if (!payload) {
    return {
      error: NextResponse.json(
        { detail: 'Invalid or expired token' },
        { status: 401 }
      ),
    };
  }

  // Check it's an access token
  if (payload.type !== 'access') {
    return {
      error: NextResponse.json(
        { detail: 'Invalid token type' },
        { status: 401 }
      ),
    };
  }

  // Verify the token exists in DB and is not expired
  const tokenRecord = await findToken(token);
  if (!tokenRecord) {
    return {
      error: NextResponse.json(
        { detail: 'Token not found or expired' },
        { status: 401 }
      ),
    };
  }

  Sentry.setUser({ id: tokenRecord.user.id });
  return { user: tokenRecord.user };
}

/**
 * Validate a refresh token
 * Returns the user if valid
 */
export async function validateRefreshToken(
  refreshToken: string
): Promise<{ user: User } | { error: string }> {
  const payload = verifyToken(refreshToken, config.auth.jwtSecret);
  if (!payload) {
    return { error: 'Invalid or expired refresh token' };
  }

  if (payload.type !== 'refresh') {
    return { error: 'Invalid token type' };
  }

  const tokenRecord = await findToken(refreshToken);
  if (!tokenRecord) {
    return { error: 'Refresh token not found or expired' };
  }

  return { user: tokenRecord.user };
}

/**
 * Create standardized error response matching Ansari's format
 */
export function createErrorResponse(detail: string, status: number = 400): NextResponse {
  return NextResponse.json({ detail }, { status });
}
