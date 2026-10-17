import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { AuthServiceUnavailableError } from '@/lib/auth-service/client';
import {
    requestPasswordReset,
  tooManyRequestsResponse,
  unavailableResponse,
} from '@/lib/auth-service/legacy';
import { limitLegacyRoute } from '@/lib/auth-service/limits';
import { createErrorResponse } from '@/lib/error-response';
import { safeErrorMeta } from '@/lib/log';

// Legacy reset request over apps/auth (spec 300, plan phase 8). apps/auth
// sends the legacy-shaped link, and answers every email alike, with one rate
// budget for known and unknown addresses. An apps/auth outage is a 503 (the
// same for every address); any other failure still answers success, as today,
// so the route never tells whether an address exists.

const requestSchema = z.object({
  email: z.string().email('Invalid email format'),
});

export async function POST(request: NextRequest) {
  const limited = limitLegacyRoute(request, 'request_password_reset');
  if (limited) return limited;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return createErrorResponse('Invalid request body', 422);
  }

  const parseResult = requestSchema.safeParse(body);
  if (!parseResult.success) {
    const errors = parseResult.error.issues.map((i) => i.message);
    return createErrorResponse(errors.join(', '), 422);
  }

  try {
    const result = await requestPasswordReset(parseResult.data.email);
    if (result.kind === 'rate_limited') return tooManyRequestsResponse(result.retryAfter);
  } catch (error) {
    // An outage is the same for every address, so the 503 tells nothing about
    // which exist; the layer never lets a dead apps/auth look like success.
    if (error instanceof AuthServiceUnavailableError) {
      console.error('Request password reset: apps/auth unavailable', { status: error.status });
      return unavailableResponse();
    }
    console.error('Request password reset error:', safeErrorMeta(error));
  }
  return NextResponse.json({ status: 'success' });
}
