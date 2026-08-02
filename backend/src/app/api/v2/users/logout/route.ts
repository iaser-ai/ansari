import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, createErrorResponse } from '@/lib/auth/middleware';
import { deleteUserTokens } from '@/lib/db/users';

export async function POST(request: NextRequest) {
  try {
    // Resolve the user from the access token. authenticateRequest returns a 401
    // for a missing, invalid, wrong-type, or unknown token — preserving the
    // existing auth-failure contract.
    const authResult = await authenticateRequest(request);
    if ('error' in authResult) return authResult.error;

    // Full, all-device logout (spec 4): revoke ALL of the user's tokens so the
    // 90-day refresh token cannot outlive logout. The request carries only the
    // access token and there is no per-session grouping, so logout is global.
    await deleteUserTokens(authResult.user.id);

    return NextResponse.json({ message: 'Successfully logged out' });
  } catch (error) {
    console.error('Logout error:', error);
    return createErrorResponse('Logout failed', 500);
  }
}
