import { NextRequest, NextResponse } from 'next/server';
import type { User } from '@/db/schema';
import { AuthServiceUnavailableError, getAuthAccount } from '@/lib/auth-service/client';
import { bearerToken, requireUser } from './require-user';

/** The role apps/auth's role script grants (packages/auth `ADMIN_ROLE`). */
const ADMIN_ROLE = 'admin';

/**
 * The admin routes' guard (spec 300, "Two databases" rule 6), paired with
 * `requireUser`. The legacy guard of the same name read `is_admin` and is gone.
 * The role lives only in the auth database, so every admin request asks
 * apps/auth for it, with the admin's own JWT (owner amendment 2026-10-17): a
 * demotion, a ban or a revoked session takes effect on the very next request,
 * while the JWT is still valid. When apps/auth cannot answer, the route fails
 * closed with 503 and never grants access.
 */
export async function requireAdmin(
  request: NextRequest
): Promise<{ user: User } | { error: NextResponse }> {
  const authResult = await requireUser(request);
  if ('error' in authResult) return authResult;

  // requireUser has verified this bearer; it is the admin's own JWT.
  const jwt = bearerToken(request.headers.get('Authorization')) as string;
  let role;
  try {
    role = await getAuthAccount(authResult.user.id, jwt);
  } catch (err) {
    if (!(err instanceof AuthServiceUnavailableError)) throw err;
    console.warn('admin role check failed', { userId: authResult.user.id, status: err.status });
    return {
      error: NextResponse.json({ detail: 'Authentication service unavailable' }, { status: 503 }),
    };
  }

  if (!role || role.banned || role.role !== ADMIN_ROLE) {
    return { error: NextResponse.json({ detail: 'Admin access required' }, { status: 403 }) };
  }
  return { user: authResult.user };
}
