import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { verifyToken } from '@/lib/auth/jwt';
import { hashPassword, checkPasswordStrength } from '@/lib/auth/password';
import { findToken, updateUser, deleteUserTokens, bumpSessionVersion, deleteToken } from '@/lib/db/users';
import { db } from '@/lib/db/index';
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

    // Apply the reset ATOMICALLY (spec 4), all in one transaction:
    //  1. CONSUME the one-time reset token via a conditional delete. Only one of
    //     two concurrent requests wins this delete (the row lock serializes them),
    //     so the same reset token can never drive two password changes.
    //  2. Set the new password.
    //  3. Bump session_version — invalidates every previously-issued token via the
    //     version check, so a refresh racing this reset cannot leave a valid session.
    //  4. Delete all remaining tokens (revoke current sessions).
    const passwordHash = await hashPassword(new_password);
    const applied = await db.transaction(async (tx) => {
      const consumed = await deleteToken(reset_token, tx);
      if (!consumed) return false; // already used by a concurrent request
      await updateUser(tokenResult.user.id, { passwordHash }, tx);
      await bumpSessionVersion(tokenResult.user.id, tx);
      await deleteUserTokens(tokenResult.user.id, undefined, tx);
      return true;
    });

    if (!applied) {
      return createErrorResponse('Invalid or expired reset token', 400);
    }

    return NextResponse.json({ status: 'success' });
  } catch (error) {
    console.error('Reset password error:', error);
    return createErrorResponse('Password reset failed', 500);
  }
}
