import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { resolveUser } from '@/lib/auth/resolve-user';
import { AuthServiceUnavailableError } from '@/lib/auth-service/client';
import {
  LEGACY_DETAIL,
    mintJwt,
  signIn,
  tooManyRequestsResponse,
  unavailableResponse,
} from '@/lib/auth-service/legacy';
import { limitLegacyRoute } from '@/lib/auth-service/limits';
import { createErrorResponse } from '@/lib/error-response';
import { safeErrorMeta } from '@/lib/log';

// Legacy login over apps/auth (spec 300, plan phase 8): sign in, exchange the
// session for a JWT, and read the names from the app row (created on first use
// when it is missing). access_token is the JWT; refresh_token is the session
// token, which /refresh_token exchanges for the next JWT.

const loginSchema = z.object({
  email: z.string().email('Invalid email format'),
  password: z.string().min(1, 'Password is required'),
});

export async function POST(request: NextRequest) {
  const limited = limitLegacyRoute(request, 'login');
  if (limited) return limited;

  try {
    const body = await request.json();
    const parseResult = loginSchema.safeParse(body);
    if (!parseResult.success) {
      const errors = parseResult.error.issues.map((i) => i.message);
      return createErrorResponse(errors.join(', '), 422);
    }

    const result = await signIn(parseResult.data);
    if (result.kind === 'invalid') return createErrorResponse(LEGACY_DETAIL.invalidCredentials, 401);
    if (result.kind === 'rate_limited') return tooManyRequestsResponse(result.retryAfter);

    const accessToken = await mintJwt(result.sessionToken);
    if (!accessToken) throw new AuthServiceUnavailableError(401);

    const resolved = await resolveUser(result.userId, accessToken);
    if (resolved.kind === 'unavailable') return unavailableResponse();
    // An account apps/api refuses (a tombstone, an email conflict) cannot log in.
    if (resolved.kind === 'refused') return createErrorResponse(LEGACY_DETAIL.invalidCredentials, 401);

    return NextResponse.json({
      status: 'success',
      access_token: accessToken,
      refresh_token: result.sessionToken,
      token_type: 'bearer',
      first_name: resolved.user.firstName || '',
      last_name: resolved.user.lastName || '',
    });
  } catch (error) {
    if (error instanceof AuthServiceUnavailableError) {
      console.error('Login: apps/auth unavailable', { status: error.status });
      return unavailableResponse();
    }
    console.error('Login error:', safeErrorMeta(error));
    return createErrorResponse('Login failed', 500);
  }
}
