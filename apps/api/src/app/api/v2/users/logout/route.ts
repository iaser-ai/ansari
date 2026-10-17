import { NextRequest, NextResponse } from 'next/server';
import { requireUser, bearerToken } from '@/lib/auth/require-user';
import { AuthServiceUnavailableError } from '@/lib/auth-service/client';
import { revokeSessions, unavailableResponse } from '@/lib/auth-service/legacy';
import { createErrorResponse } from '@/lib/error-response';
import { safeErrorMeta } from '@/lib/log';

// Legacy logout over apps/auth (spec 300, plan phase 8; G-3): the legacy client
// sends only its JWT, and logout ends EVERY session of the user, as today, at
// apps/auth's account endpoint, asked with that JWT. A token whose session has
// already ended is refused there, and here with the legacy 401. A JWT already
// issued stays valid until its exp (15 minutes, the accepted window).

export async function POST(request: NextRequest) {
  try {
    const authResult = await requireUser(request);
    if ('error' in authResult) return authResult.error;

    const jwt = bearerToken(request.headers.get('Authorization')) as string;
    if (!(await revokeSessions(jwt))) return createErrorResponse('Token not found or expired', 401);
    return NextResponse.json({ message: 'Successfully logged out' });
  } catch (error) {
    if (error instanceof AuthServiceUnavailableError) {
      console.error('Logout: apps/auth unavailable', { status: error.status });
      return unavailableResponse();
    }
    console.error('Logout error:', safeErrorMeta(error));
    return createErrorResponse('Logout failed', 500);
  }
}
