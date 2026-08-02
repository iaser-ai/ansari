import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { verifyToken } from '@/lib/auth/jwt';
import { hashPassword, checkPasswordStrength } from '@/lib/auth/password';
import { findToken, updateUser, deleteUserTokens } from '@/lib/db/users';
import { createErrorResponse } from '@/lib/auth/middleware';
import { config } from '@/lib/config';

const resetSchema = z.object({
  reset_token: z.string().min(1, 'reset_token is required'),
  new_password: z.string().min(1, 'new_password is required'),
});

export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return createErrorResponse('Invalid request body', 422);
  }

  try {
    const parseResult = resetSchema.safeParse(body);

    if (!parseResult.success) {
      const errors = parseResult.error.issues.map(i => i.message);
      return createErrorResponse(errors.join(', '), 422);
    }

    const { reset_token, new_password } = parseResult.data;

    // Verify JWT signature and expiry
    const jwtSecret = config.auth.jwtSecret;
    const payload = verifyToken(reset_token, jwtSecret);
    if (!payload || payload.type !== 'reset') {
      return createErrorResponse('Invalid or expired reset token', 400);
    }

    // Verify token exists in database (not already used)
    const tokenResult = await findToken(reset_token);
    if (!tokenResult) {
      return createErrorResponse('Invalid or expired reset token', 400);
    }

    // Validate password strength
    const strength = checkPasswordStrength(new_password);
    if (!strength.valid) {
      return createErrorResponse(
        `Password is too weak. ${strength.suggestions.join(' ')}`,
        400
      );
    }

    // Hash new password and update user
    const passwordHash = await hashPassword(new_password);
    await updateUser(tokenResult.user.id, { passwordHash });

    // Invalidate ALL tokens for this user (access + refresh + reset)
    await deleteUserTokens(tokenResult.user.id);

    return NextResponse.json({ status: 'success' });
  } catch (error) {
    console.error('Reset password error:', error);
    return createErrorResponse('Password reset failed', 500);
  }
}
