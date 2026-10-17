import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import type { User } from '@/db/schema';
import { verifyAccessToken } from './verify-jwt';
import { resolveUser } from './resolve-user';

/**
 * The successor to `authenticateRequest` (spec 300): the same
 * `{ user } | { error }` shape, so switching a route is a one-line change.
 * The bearer is an apps/auth JWT, verified against the cached JWKS; its `sub`
 * resolves to the `public.users` row (created on first use).
 *
 * The 401 details are the legacy ones the phase 1 contract fixtures freeze:
 * no bearer, a token that does not verify, and a token whose account is gone.
 * A first-use profile fetch apps/auth cannot answer is a 503, never a 401, so
 * an outage does not log the client out.
 */
export async function requireUser(
  request: NextRequest
): Promise<{ user: User } | { error: NextResponse }> {
  const token = bearerToken(request.headers.get('Authorization'));
  if (!token) return { error: detail('Not authenticated', 401) };

  const verified = await verifyAccessToken(token);
  if (!verified) return { error: detail('Invalid or expired token', 401) };

  const resolved = await resolveUser(verified.sub, token);
  if (resolved.kind === 'unavailable') {
    return { error: detail('Authentication service unavailable', 503) };
  }
  if (resolved.kind === 'refused') return { error: detail('Token not found or expired', 401) };

  Sentry.setUser({ id: resolved.user.id });
  return { user: resolved.user };
}

/** `Bearer <token>`, exactly, as the legacy middleware parses it. */
export function bearerToken(header: string | null): string | null {
  if (!header) return null;
  const parts = header.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer' || !parts[1]) return null;
  return parts[1];
}

function detail(message: string, status: number): NextResponse {
  return NextResponse.json({ detail: message }, { status });
}
