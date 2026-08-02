import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { issueTokenPair, markTokenRotated } from '@/lib/db/users';
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

    // Validate the refresh token
    const result = await validateRefreshToken(refresh_token);
    if ('error' in result) {
      return createErrorResponse(result.error, 401);
    }

    const { user } = result;

    // Rotate the old refresh token: keep it valid for a short grace window so
    // concurrent refreshes with the same token still succeed (issue #34).
    await markTokenRotated(refresh_token);

    // Issue new tokens (single consolidated generate-and-store helper)
    const { accessToken: newAccessToken, refreshToken: newRefreshToken } =
      await issueTokenPair(user.id);

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
