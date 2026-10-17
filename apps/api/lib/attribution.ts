import * as Sentry from '@sentry/nextjs';
import type { NextRequest } from 'next/server';
import {
  CLIENT_HEADER,
  CLIENT_SRC_PARAM,
  INVALID_CLIENT,
  parseClientId,
} from '@ansari/types/attribution';

// Per-client traffic attribution (spec 56, extended by #87).
//
// A single choke-point for reading the optional `X-Ansari-Client` header (with
// a `?src=` query-param fallback for callers that cannot set headers, e.g.
// browsing AIs fetching a URL from a published prompt) so every write path
// attributes identically. The pattern and normalisation are shared with
// apps/auth through @ansari/types (spec 300); this wrapper adds the Sentry
// reporting.

export { CLIENT_HEADER, CLIENT_SRC_PARAM, INVALID_CLIENT, KNOWN_CLIENTS } from '@ansari/types/attribution';

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
  const parsed = parseClientId(
    request.headers.get(CLIENT_HEADER),
    request.nextUrl.searchParams.get(CLIENT_SRC_PARAM)
  );
  if (parsed.kind === 'absent') return null;

  if (parsed.kind === 'valid') {
    Sentry.setTag('client', parsed.clientId);
    return parsed.clientId;
  }

  // Present but malformed (bad charset, too long, empty after trim, or the
  // reserved sentinel word itself) → store the sentinel and warn.
  const via =
    parsed.source === 'header' ? `${CLIENT_HEADER} header` : `${CLIENT_SRC_PARAM} query param`;
  Sentry.setTag('client', INVALID_CLIENT);
  Sentry.captureMessage(`invalid ${via}`, {
    level: 'warning',
    tags: { client: INVALID_CLIENT },
    extra: { rawTruncated: parsed.raw.slice(0, 32) },
  });
  return INVALID_CLIENT;
}
