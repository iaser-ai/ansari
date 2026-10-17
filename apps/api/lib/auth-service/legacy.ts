import type { NextResponse } from 'next/server';
import { createErrorResponse } from '@/lib/error-response';
import { z } from 'zod';
import { ACCOUNT_PATH, AuthServiceUnavailableError, authServiceFetch, type AuthServiceRequest } from './client';

/**
 * The compatibility layer's calls to apps/auth (spec 300, plan phase 8), and
 * the translation of apps/auth's answers into the legacy `/v2/users/*` wire:
 * the `detail` strings and status codes phase 1's contract fixtures freeze.
 *
 * Every call is an anonymous pass-through to apps/auth's public endpoints
 * (owner amendment 2026-10-17): no credential, no forwarded IP. apps/auth
 * therefore sees apps/api's IP on all of them, so it keys none of these paths
 * by IP; the per-client-IP limits run here, in the routes, before the call
 * (`limits.ts`). TEMPORARY, until the legacy system is replaced. Nothing here
 * imports better-auth or @ansari/auth: apps/auth is reached over HTTP only.
 */

export const LEGACY_DETAIL = {
  invalidCredentials: 'Invalid email or password',
  emailTaken: 'An account with this email already exists',
  invalidRefreshToken: 'Invalid or expired refresh token',
  invalidResetToken: 'Invalid or expired reset token',
  tooManyRequests: 'Too many requests. Please try again later.',
  unavailable: 'Authentication service unavailable',
} as const;

/** The legacy weak-password `detail` (apps/auth sends the same, byte for byte). */
export function weakPasswordDetail(suggestions: string[]): string {
  return `Password is too weak. ${suggestions.join(' ')}`;
}


/** apps/auth could not answer: fail closed, and never as a credentials error. */
export function unavailableResponse(): NextResponse {
  return createErrorResponse(LEGACY_DETAIL.unavailable, 503);
}

export function tooManyRequestsResponse(retryAfter: string | null): NextResponse {
  return createErrorResponse(
    LEGACY_DETAIL.tooManyRequests,
    429,
    retryAfter ? { 'Retry-After': retryAfter } : undefined
  );
}

const errorBody = z.object({ code: z.string().optional(), message: z.string().optional() });

/** better-auth's `{code, message}` error body; empty when it is anything else. */
async function readError(response: Response): Promise<z.infer<typeof errorBody>> {
  const parsed = errorBody.safeParse(await response.json().catch(() => undefined));
  return parsed.success ? parsed.data : {};
}

const sessionBody = z.object({
  token: z.string().min(1),
  user: z.object({ id: z.string() }),
});

const tokenBody = z.object({ token: z.string().min(1) });

type RateLimited = { kind: 'rate_limited'; retryAfter: string | null };

function rateLimited(response: Response): RateLimited {
  return { kind: 'rate_limited', retryAfter: response.headers.get('x-retry-after') };
}

async function parseOrUnavailable<T>(response: Response, schema: z.ZodType<T>): Promise<T> {
  const parsed = schema.safeParse(await response.json().catch(() => undefined));
  if (!parsed.success) throw new AuthServiceUnavailableError(response.status);
  return parsed.data;
}

type Session = { kind: 'ok'; userId: string; sessionToken: string };

export type SignUpResult =
  | Session
  | { kind: 'taken' }
  | { kind: 'weak'; detail: string }
  | { kind: 'invalid'; detail: string }
  | RateLimited;

/**
 * `POST /api/auth/sign-up/email`. apps/auth runs the legacy guard order:
 * reserved or taken (one 409) before strength (400).
 */
export async function signUp(
  body: {
    email: string;
    password: string;
    first_name?: string;
    last_name?: string;
    register_to_mail_list: boolean;
  },
  request: Pick<AuthServiceRequest, 'headers'> = {}
): Promise<SignUpResult> {
  const response = await authServiceFetch('/api/auth/sign-up/email', { ...request, body });
  if (response.status === 200) {
    const session = await parseOrUnavailable(response, sessionBody);
    return { kind: 'ok', userId: session.user.id, sessionToken: session.token };
  }
  if (response.status === 409) return { kind: 'taken' };
  if (response.status === 429) return rateLimited(response);
  if (response.status === 400 || response.status === 422) {
    const { code, message } = await readError(response);
    if (code === 'PASSWORD_TOO_WEAK' && message) return { kind: 'weak', detail: message };
    return { kind: 'invalid', detail: message ?? 'Invalid request' };
  }
  throw new AuthServiceUnavailableError(response.status);
}

export type SignInResult = Session | { kind: 'invalid' } | RateLimited;

/** `POST /api/auth/sign-in/email`. Any refusal is the one generic 401. */
export async function signIn(body: { email: string; password: string }): Promise<SignInResult> {
  const response = await authServiceFetch('/api/auth/sign-in/email', { body });
  if (response.status === 200) {
    const session = await parseOrUnavailable(response, sessionBody);
    return { kind: 'ok', userId: session.user.id, sessionToken: session.token };
  }
  if (response.status === 429) return rateLimited(response);
  if (response.status >= 400 && response.status < 500) return { kind: 'invalid' };
  throw new AuthServiceUnavailableError(response.status);
}

/**
 * `GET /api/auth/token`: a live session token (the legacy refresh_token) for a
 * fresh JWT. Null when the session is dead or the token is not a session token.
 */
export async function mintJwt(sessionToken: string): Promise<string | null> {
  const response = await authServiceFetch('/api/auth/token', { bearer: sessionToken });
  if (response.status === 200) return (await parseOrUnavailable(response, tokenBody)).token;
  // A dead session is a 401. Anything else (a 403 from the origin check, say)
  // is a fault, never read as "logged out".
  if (response.status === 401) return null;
  throw new AuthServiceUnavailableError(response.status);
}

/**
 * Every session of the bearer (legacy logout is all devices). False when
 * apps/auth refuses the token because its session has already ended (401).
 */
export async function revokeSessions(jwt: string): Promise<boolean> {
  const response = await authServiceFetch(`${ACCOUNT_PATH}/revoke-sessions`, {
    method: 'POST',
    bearer: jwt,
  });
  if (response.status === 204) return true;
  if (response.status === 401) return false;
  throw new AuthServiceUnavailableError(response.status);
}

/** `POST /api/auth/request-password-reset`: the same answer for every email. */
export async function requestPasswordReset(email: string): Promise<{ kind: 'ok' } | RateLimited> {
  const response = await authServiceFetch('/api/auth/request-password-reset', { body: { email } });
  if (response.status === 429) return rateLimited(response);
  if (response.status !== 200) throw new AuthServiceUnavailableError(response.status);
  return { kind: 'ok' };
}

export type ResetResult =
  | { kind: 'ok' }
  | { kind: 'invalid_token' }
  | { kind: 'weak'; detail: string }
  | RateLimited;

/**
 * `POST /api/auth/reset-password`. apps/auth checks the token before the
 * strength, the legacy order. better-auth's own minimum length (8) can refuse
 * a password the strength score passed; that is a weak password too.
 */
export async function resetPassword(token: string, newPassword: string): Promise<ResetResult> {
  const response = await authServiceFetch('/api/auth/reset-password', {
    body: { token, newPassword },
  });
  if (response.status === 200) return { kind: 'ok' };
  if (response.status === 429) return rateLimited(response);
  if (response.status === 400) {
    const { code, message } = await readError(response);
    if (code === 'PASSWORD_TOO_WEAK' && message) return { kind: 'weak', detail: message };
    if (code === 'PASSWORD_TOO_SHORT') {
      return { kind: 'weak', detail: weakPasswordDetail(['Use at least 8 characters']) };
    }
    return { kind: 'invalid_token' };
  }
  throw new AuthServiceUnavailableError(response.status);
}
