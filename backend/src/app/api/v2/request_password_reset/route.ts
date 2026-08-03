import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { generateToken } from '@/lib/auth/jwt';
import { findUserByEmail, storeToken, deleteUserTokens } from '@/lib/db/users';
import { createErrorResponse } from '@/lib/auth/middleware';
import { sendPasswordResetEmail } from '@/lib/email';
import { config } from '@/lib/config';

const RESET_TOKEN_EXPIRY_HOURS = 1;

const requestSchema = z.object({
  email: z.string().email('Invalid email format'),
});

export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return createErrorResponse('Invalid request body', 422);
  }

  const parseResult = requestSchema.safeParse(body);
  if (!parseResult.success) {
    const errors = parseResult.error.issues.map(i => i.message);
    return createErrorResponse(errors.join(', '), 422);
  }

  try {
    const { email } = parseResult.data;

    const user = await findUserByEmail(email);
    if (user) {
      const jwtSecret = config.auth.jwtSecret;

      // Delete any existing reset tokens for this user
      await deleteUserTokens(user.id, 'reset');

      // Generate new reset token. Reset tokens are validated by DB existence +
      // type, not by session_version, so the embedded version is informational.
      const resetToken = generateToken(user.id, 'reset', RESET_TOKEN_EXPIRY_HOURS, jwtSecret, user.sessionVersion);

      // Store token hash in database
      await storeToken({
        userId: user.id,
        token: resetToken,
        tokenType: 'reset',
        expiresAt: new Date(Date.now() + RESET_TOKEN_EXPIRY_HOURS * 60 * 60 * 1000),
      });

      // Send email (fire-and-forget)
      sendPasswordResetEmail(email, resetToken)
        .then((result) => {
          if (!result.success) {
            console.error('Password reset email failed:', result.error);
          }
        })
        .catch((err) => {
          console.error('Password reset email unexpected error:', err instanceof Error ? err.message : err);
        });
    }

    // Always return success regardless of whether email exists
    return NextResponse.json({ status: 'success' });
  } catch (error) {
    // Return success even on unexpected errors to prevent user enumeration
    console.error('Request password reset error:', error);
    return NextResponse.json({ status: 'success' });
  }
}
