import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db/index';
import { users } from '@/db/schema';
import { insertAppUserRow } from '@/lib/db/users';
import { CLIENT_HEADER, getClientId } from '@/lib/attribution';
import { AuthServiceUnavailableError } from '@/lib/auth-service/client';
import {
  LEGACY_DETAIL,
    mintJwt,
  signUp,
  tooManyRequestsResponse,
  unavailableResponse,
} from '@/lib/auth-service/legacy';
import { limitLegacyRoute } from '@/lib/auth-service/limits';
import { createErrorResponse } from '@/lib/error-response';
import { safeErrorMeta } from '@/lib/log';

// Legacy register over apps/auth (spec 300, plan phase 8). The order is the
// legacy one, so registration is no oracle: validation (422, here) → reserved
// or taken (one identical 409) → strength (400) → create. apps/auth enforces
// the reserved/taken → strength part, including the system domain; this route
// also refuses an address any `public.users` row holds (a system account's, or
// a leftover), before apps/auth sees it.
// The newsletter opt-in is forwarded; apps/auth subscribes.

const registerSchema = z.object({
  email: z.string().email('Invalid email format'),
  password: z
    .string()
    .min(8, 'Password must be at least 8 characters')
    .max(128, 'Password must be at most 128 characters'),
  first_name: z.string().optional(),
  last_name: z.string().optional(),
  register_to_mail_list: z.boolean().optional().default(false),
});

export async function POST(request: NextRequest) {
  const limited = limitLegacyRoute(request, 'register');
  if (limited) return limited;

  try {
    const body = await request.json();
    const parseResult = registerSchema.safeParse(body);
    if (!parseResult.success) {
      const errors = parseResult.error.issues.map((i) => i.message);
      return createErrorResponse(errors.join(', '), 422);
    }
    const { email, password, first_name, last_name, register_to_mail_list } = parseResult.data;
    const normalized = email.trim().toLowerCase();

    const [holder] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, normalized))
      .limit(1);
    if (holder) return createErrorResponse(LEGACY_DETAIL.emailTaken, 409);

    const clientHeader = request.headers.get(CLIENT_HEADER);
    const result = await signUp(
      { email, password, first_name, last_name, register_to_mail_list },
      { headers: clientHeader ? { [CLIENT_HEADER]: clientHeader } : undefined }
    );
    if (result.kind === 'taken') return createErrorResponse(LEGACY_DETAIL.emailTaken, 409);
    if (result.kind === 'weak') return createErrorResponse(result.detail, 400);
    if (result.kind === 'invalid') return createErrorResponse(result.detail, 422);
    if (result.kind === 'rate_limited') return tooManyRequestsResponse(result.retryAfter);

    const accessToken = await mintJwt(result.sessionToken);
    if (!accessToken) throw new AuthServiceUnavailableError(401);

    // `registered_via` from X-Ansari-Client, as today (spec 56); NULL when absent.
    await insertAppUserRow({
      id: result.userId,
      email: normalized,
      firstName: first_name ?? null,
      lastName: last_name ?? null,
      registeredVia: getClientId(request),
    });

    return NextResponse.json({
      status: 'success',
      access_token: accessToken,
      refresh_token: result.sessionToken,
      token_type: 'bearer',
    });
  } catch (error) {
    if (error instanceof AuthServiceUnavailableError) {
      console.error('Registration: apps/auth unavailable', { status: error.status });
      return unavailableResponse();
    }
    // Sanitized metadata only: a driver error can embed the email or a hash.
    console.error('Registration error:', safeErrorMeta(error));
    return createErrorResponse('Registration failed', 500);
  }
}
