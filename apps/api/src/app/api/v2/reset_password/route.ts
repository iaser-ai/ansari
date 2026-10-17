import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { AuthServiceUnavailableError } from '@/lib/auth-service/client';
import {
  LEGACY_DETAIL,
    resetPassword,
  tooManyRequestsResponse,
  unavailableResponse,
} from '@/lib/auth-service/legacy';
import { limitLegacyRoute } from '@/lib/auth-service/limits';
import { createErrorResponse } from '@/lib/error-response';
import { safeErrorMeta } from '@/lib/log';

// Legacy reset over apps/auth (spec 300, plan phase 8). apps/auth checks the
// token before the strength (the legacy order), consumes it atomically, and
// revokes every session of the user (revokeSessionsOnPasswordReset).

const resetSchema = z.object({
  reset_token: z.string().min(1, 'reset_token is required'),
  new_password: z
    .string()
    .min(1, 'new_password is required')
    .max(128, 'new_password must be at most 128 characters'),
});

export async function POST(request: NextRequest) {
  const limited = limitLegacyRoute(request, 'reset_password');
  if (limited) return limited;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return createErrorResponse('Invalid request body', 422);
  }

  try {
    const parseResult = resetSchema.safeParse(body);
    if (!parseResult.success) {
      const errors = parseResult.error.issues.map((i) => i.message);
      return createErrorResponse(errors.join(', '), 422);
    }

    const { reset_token, new_password } = parseResult.data;
    const result = await resetPassword(reset_token, new_password);
    if (result.kind === 'invalid_token') return createErrorResponse(LEGACY_DETAIL.invalidResetToken, 400);
    if (result.kind === 'weak') return createErrorResponse(result.detail, 400);
    if (result.kind === 'rate_limited') return tooManyRequestsResponse(result.retryAfter);

    return NextResponse.json({ status: 'success' });
  } catch (error) {
    if (error instanceof AuthServiceUnavailableError) {
      console.error('Reset password: apps/auth unavailable', { status: error.status });
      return unavailableResponse();
    }
    console.error('Reset password error:', safeErrorMeta(error));
    return createErrorResponse('Password reset failed', 500);
  }
}
