import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, createErrorResponse } from './middleware';
import { config } from '../config';
import type { User } from '../../db/schema';

/**
 * Check if an email is in the admin whitelist.
 * Comparison is case-insensitive per RFC 5321.
 */
export function isAdmin(email: string): boolean {
  return config.admin.emails.includes(email.toLowerCase());
}

/**
 * Authenticate a request and verify the user is an admin.
 * Returns { user } if valid admin, or { error: NextResponse } with 401/403.
 */
export async function requireAdmin(
  request: NextRequest
): Promise<{ user: User } | { error: NextResponse }> {
  const authResult = await authenticateRequest(request);
  if ('error' in authResult) return authResult;

  if (!isAdmin(authResult.user.email)) {
    return {
      error: createErrorResponse('Admin access required', 403),
    };
  }

  return { user: authResult.user };
}
