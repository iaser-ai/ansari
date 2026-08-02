import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { issueTokenPair, markTokenRotated, lookupRefreshToken, maybeSweepExpiredTokens } from '@/lib/db/users';
import { db } from '@/lib/db/index';
import { validateRefreshToken, createErrorResponse } from '@/lib/auth/middleware';

const refreshSchema = z.object({
  refresh_token: z.string().min(1, 'Refresh token is required'),
});

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const parseResult = refreshSchema.safeParse(body);

    if (!parseResult.success) {
      const errors = parseResult.error.issues.map(i => i.message);
      return createErrorResponse(errors.join(', '), 422);
    }

    const { refresh_token } = parseResult.data;

    // Validate the refresh token. The returned user carries the session_version
    // captured NOW; it is embedded in the new tokens below so a password reset
    // racing this refresh invalidates whatever we mint.
    const result = await validateRefreshToken(refresh_token);
    if ('reuse' in result) {
      // A spent (rotated-past-grace) refresh token was replayed. Reject with a
      // generic message and log the event (no user content, no raw token).
      console.warn('Refresh token reuse detected — rejecting.');
      return createErrorResponse('Invalid or expired refresh token', 401);
    }
    if ('error' in result) {
      return createErrorResponse(result.error, 401);
    }

    // Re-confirm, rotate, and issue the new pair ATOMICALLY (spec 4). The lookup
    // is repeated INSIDE the transaction so it is serialized against a concurrent
    // logout/reset that may have revoked the token after the initial validation:
    //  - if the token was revoked in the meantime, the recheck is `not_found` /
    //    `reuse` and we DON'T issue;
    //  - an in-grace rotated token still reads `valid`, so concurrent refreshes
    //    with the same token both succeed (issue #34);
    //  - issuance embeds the version read inside the transaction, which the version
    //    bump on reset/logout still invalidates under any remaining interleaving.
    const pair = await db.transaction(async (tx) => {
      const recheck = await lookupRefreshToken(refresh_token, tx);
      if (recheck.status !== 'valid') return null;
      await markTokenRotated(refresh_token, tx);
      return issueTokenPair(recheck.user.id, recheck.user.sessionVersion, tx);
    });

    if (!pair) {
      return createErrorResponse('Invalid or expired refresh token', 401);
    }

    // Opportunistically prune expired tokens (fire-and-forget, spec 4).
    maybeSweepExpiredTokens();

    // Return new tokens in Ansari's format
    return NextResponse.json({
      access_token: pair.accessToken,
      refresh_token: pair.refreshToken,
      token_type: 'bearer',
    });
  } catch (error) {
    console.error('Token refresh error:', error);
    return createErrorResponse('Token refresh failed', 500);
  }
}
