import * as Sentry from '@sentry/nextjs';
import type { NextRequest } from 'next/server';

// Per-client traffic attribution (spec 56, extended by #87).
//
// A single choke-point for reading the optional `X-Ansari-Client` header (with
// a `?src=` query-param fallback for callers that cannot set headers, e.g.
// browsing AIs fetching a URL from a published prompt) so every write path
// attributes identically. The client id is an application identifier (not
// PII), so it is safe to attach to Sentry and logs.

/** HTTP header carrying the per-request client id. Case-insensitive per Fetch. */
export const CLIENT_HEADER = 'X-Ansari-Client';

/** Query param carrying the client id when the header can't be set (#87). */
export const CLIENT_SRC_PARAM = 'src';

/**
 * Reserved sentinel stored when the header is present but malformed. Distinct
 * from NULL (= header absent), so malformed traffic stays countable in the
 * `client` analytics rather than being conflated with unattributed traffic.
 * Never assigned to a real client (a client that literally sends `invalid` is
 * also treated as malformed).
 */
export const INVALID_CLIENT = 'invalid';

/**
 * First-party client ids, for readability only — NOT enforced. Partners send
 * their own id (e.g. `muslimpedia`); any value matching CLIENT_ID_PATTERN is
 * accepted (spec decision D4: sanitize, don't allowlist).
 */
export const KNOWN_CLIENTS = ['askansari-web', 'askansari-android'] as const;

// 1–64 chars, starts alphanumeric, then [a-z0-9._-]. Bounds cardinality and is
// safe for logging, Sentry tags, and SQL.
const CLIENT_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/**
 * Extract the per-request client id from the `X-Ansari-Client` header
 * (spec 56), falling back to the `?src=` query param when the header is
 * absent (#87). The header always wins when both are present — including a
 * malformed header, which maps to the sentinel regardless of the param
 * (first-party precedence).
 *
 * Returns:
 *  - `null`            when both header and param are absent — attribution not
 *                      provided; the caller stores NULL and behavior is
 *                      unchanged.
 *  - the normalized id when present and valid (trimmed + lowercased).
 *  - `INVALID_CLIENT`  when present but malformed.
 *
 * Lenient by design (spec D2, architect-confirmed): a malformed value never
 * throws and never produces a 4xx — it is recorded as the sentinel and reported
 * to Sentry at WARNING level (with a truncated copy of the raw value) so
 * misconfigured clients are visible without leaking user content.
 */
export function getClientId(request: NextRequest): string | null {
  const header = request.headers.get(CLIENT_HEADER);
  const raw = header ?? request.nextUrl.searchParams.get(CLIENT_SRC_PARAM);
  if (raw === null) return null;

  const normalized = raw.trim().toLowerCase();

  if (CLIENT_ID_PATTERN.test(normalized) && normalized !== INVALID_CLIENT) {
    Sentry.setTag('client', normalized);
    return normalized;
  }

  // Present but malformed (bad charset, too long, empty after trim, or the
  // reserved sentinel word itself) → store the sentinel and warn.
  const via =
    header !== null ? `${CLIENT_HEADER} header` : `${CLIENT_SRC_PARAM} query param`;
  Sentry.setTag('client', INVALID_CLIENT);
  Sentry.captureMessage(`invalid ${via}`, {
    level: 'warning',
    tags: { client: INVALID_CLIENT },
    extra: { rawTruncated: raw.slice(0, 32) },
  });
  return INVALID_CLIENT;
}
