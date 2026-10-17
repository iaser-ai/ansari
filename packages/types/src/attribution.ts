// Per-client traffic attribution (spec 56, extended by #87): the pure parser.
//
// Both services read the optional `X-Ansari-Client` header — apps/api on every
// write path, apps/auth on sign-up (`registered_via`) — so the pattern and the
// normalisation live here, once, and neither copy can drift. Reporting (Sentry
// tags and warnings) stays with each caller: this module has no dependencies,
// so apps/api still never imports anything auth-related through it.
//
// The client id is an application identifier (not PII), so it is safe to log.

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
export const KNOWN_CLIENTS = ['askansari-web', 'askansari-ios', 'askansari-android'] as const;

// 1–64 chars, starts alphanumeric, then [a-z0-9._-]. Bounds cardinality and is
// safe for logging, Sentry tags, and SQL.
const CLIENT_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export type ClientIdSource = 'header' | 'query';

export type ParsedClientId =
  /** Neither the header nor the param was sent. */
  | { kind: 'absent'; clientId: null }
  /** A valid id, trimmed and lowercased. */
  | { kind: 'valid'; clientId: string; source: ClientIdSource }
  /** Present but malformed: the caller stores INVALID_CLIENT and may report `raw`. */
  | { kind: 'invalid'; clientId: typeof INVALID_CLIENT; source: ClientIdSource; raw: string };

/**
 * Parse the client id from the header value, falling back to the `?src=`
 * query param when the header is absent (#87). The header always wins when
 * both are present — including a malformed header, which maps to the sentinel
 * regardless of the param (first-party precedence).
 *
 * Lenient by design (spec D2): a malformed value never throws; it maps to
 * INVALID_CLIENT.
 */
export function parseClientId(header: string | null, srcParam: string | null): ParsedClientId {
  const source: ClientIdSource = header !== null ? 'header' : 'query';
  const raw = header ?? srcParam;
  if (raw === null) return { kind: 'absent', clientId: null };

  const normalized = raw.trim().toLowerCase();
  if (CLIENT_ID_PATTERN.test(normalized) && normalized !== INVALID_CLIENT) {
    return { kind: 'valid', clientId: normalized, source };
  }
  return { kind: 'invalid', clientId: INVALID_CLIENT, source, raw };
}
