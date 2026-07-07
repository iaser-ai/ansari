import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { generateToken } from '@/lib/auth/jwt';
import { storeToken, markTokenRotated } from '@/lib/db/users';
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

    // Generate new tokens
    const jwtSecret = process.env.JWT_SECRET!;
    const accessExpiryHours = parseInt(process.env.ACCESS_TOKEN_EXPIRY_HOURS || '2');
    const refreshExpiryHours = parseInt(process.env.REFRESH_TOKEN_EXPIRY_HOURS || '2160');

    const newAccessToken = generateToken(user.id, 'access', accessExpiryHours, jwtSecret);
    const newRefreshToken = generateToken(user.id, 'refresh', refreshExpiryHours, jwtSecret);

    // Store new tokens
    await storeToken({
      userId: user.id,
      token: newAccessToken,
      tokenType: 'access',
      expiresAt: new Date(Date.now() + accessExpiryHours * 60 * 60 * 1000),
    });

    await storeToken({
      userId: user.id,
      token: newRefreshToken,
      tokenType: 'refresh',
      expiresAt: new Date(Date.now() + refreshExpiryHours * 60 * 60 * 1000),
    });

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
