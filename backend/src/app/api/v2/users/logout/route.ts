import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, createErrorResponse } from '@/lib/auth/middleware';
import { deleteUserTokens, bumpSessionVersion } from '@/lib/db/users';
import { db } from '@/lib/db/index';

export async function POST(request: NextRequest) {
  try {
    // Resolve the user from the access token. authenticateRequest returns a 401
    // for a missing, invalid, wrong-type, or unknown token — preserving the
    // existing auth-failure contract.
    const authResult = await authenticateRequest(request);
    if ('error' in authResult) return authResult.error;

    // Full, all-device logout (spec 4). In one transaction: bump session_version
    // AND delete all tokens. The version bump is what closes the logout-vs-refresh
    // race — a refresh that validated just before this commit and mints a new pair
    // embeds the PRE-logout version, which then fails the version check (same
    // mechanism reset uses). Deleting the tokens revokes all current sessions.
    await db.transaction(async (tx) => {
      await bumpSessionVersion(authResult.user.id, tx);
      await deleteUserTokens(authResult.user.id, undefined, tx);
    });

    return NextResponse.json({ message: 'Successfully logged out' });
  } catch (error) {
    console.error('Logout error:', error);
    return createErrorResponse('Logout failed', 500);
  }
}
