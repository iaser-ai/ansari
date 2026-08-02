import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { issueTokenPair, markTokenRotated } from '@/lib/db/users';
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

    const { user } = result;

    // Rotate the old token and issue the new pair ATOMICALLY. Rotation keeps the
    // old token valid for a short grace window so concurrent refreshes with the
    // same token still succeed (issue #34); the transaction ensures the mark and
    // the new-pair insert commit together.
    const { accessToken: newAccessToken, refreshToken: newRefreshToken } = await db.transaction(
      async (tx) => {
        await markTokenRotated(refresh_token, tx);
        return issueTokenPair(user.id, user.sessionVersion, tx);
      }
    );

    // Return new tokens in Ansari's format
    return NextResponse.json({
      access_token: newAccessToken,
      refresh_token: newRefreshToken,
      token_type: 'bearer',
    });
  } catch (error) {
    console.error('Token refresh error:', error);
    return createErrorResponse('Token refresh failed', 500);
  }
}
