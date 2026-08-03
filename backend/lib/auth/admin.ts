import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, createErrorResponse } from './middleware';
import type { User } from '../../db/schema';

/**
 * Authenticate a request and verify the user is an admin.
 *
 * Admin authorization is gated on the durable `users.is_admin` DB flag (spec 4),
 * NOT on the account's email being in an allowlist. The email allowlist
 * (`ADMIN_EMAILS`) is used only to RESERVE those addresses at registration and to
 * assert at startup that the admin accounts exist — it never grants access on its
 * own, so registering an allowlisted address cannot yield admin.
 *
 * Returns { user } if valid admin, or { error: NextResponse } with 401/403.
 */
export async function requireAdmin(
  request: NextRequest
): Promise<{ user: User } | { error: NextResponse }> {
  const authResult = await authenticateRequest(request);
  if ('error' in authResult) return authResult;

  if (!authResult.user.isAdmin) {
    return {
      error: createErrorResponse('Admin access required', 403),
    };
  }

  return { user: authResult.user };
}
