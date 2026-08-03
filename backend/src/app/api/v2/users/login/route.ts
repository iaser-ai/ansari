import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { verifyPassword } from '@/lib/auth/password';
import { findUserByEmail, issueTokenPair, maybeSweepExpiredTokens } from '@/lib/db/users';
import { createErrorResponse } from '@/lib/auth/middleware';

const loginSchema = z.object({
  email: z.string().email('Invalid email format'),
  password: z.string().min(1, 'Password is required'),
});

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const parseResult = loginSchema.safeParse(body);

    if (!parseResult.success) {
      const errors = parseResult.error.issues.map(i => i.message);
      return createErrorResponse(errors.join(', '), 422);
    }

    const { email, password } = parseResult.data;

    // Find user
    const user = await findUserByEmail(email);
    if (!user) {
      // Use generic message to prevent user enumeration
      return createErrorResponse('Invalid email or password', 401);
    }

    // Verify password
    const validPassword = await verifyPassword(password, user.passwordHash);
    if (!validPassword) {
      return createErrorResponse('Invalid email or password', 401);
    }

    // Issue tokens (single consolidated generate-and-store helper). Embed the
    // user's current session_version so a later password reset invalidates them.
    const { accessToken, refreshToken } = await issueTokenPair(user.id, user.sessionVersion);

    // Opportunistically prune expired tokens (fire-and-forget, spec 4).
    maybeSweepExpiredTokens();

    // Return tokens in Ansari's format (frontend expects status and user info)
    return NextResponse.json({
      status: 'success',
      access_token: accessToken,
      refresh_token: refreshToken,
      token_type: 'bearer',
      first_name: user.firstName || '',
      last_name: user.lastName || '',
    });
  } catch (error) {
    console.error('Login error:', error);
    return createErrorResponse('Login failed', 500);
  }
}
