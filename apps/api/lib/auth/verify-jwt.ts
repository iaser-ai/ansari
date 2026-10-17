import {
  createLocalJWKSet,
  createRemoteJWKSet,
  customFetch,
  errors,
  jwtVerify,
  type JWTVerifyGetKey,
} from 'jose';
import { config } from '@/lib/config';
import { AUTH_SERVICE_TIMEOUT_MS } from '@/lib/auth-service/client';

/**
 * Verification of apps/auth's JWTs (spec 300, "Hosting and token model"; plan
 * phase 7; owner amendment 2026-10-17). The JWKS is apps/auth's public one, at
 * `AUTH_URL`, fetched like any other client fetches it: no credential. On
 * apps/auth it falls under the router's per-IP default, which this fetch rate
 * (at most one per 30 s cooldown) never approaches.
 *
 * - The algorithm is pinned to EdDSA, the one createAuth() signs with, so
 *   `none`, HS256 (a legacy token) and RS256 are refused before any key lookup.
 * - `iss`, `aud`, `exp`, `sub` and `sid` are required.
 * - Keys are cached for 10 minutes. Steady state makes no network call.
 * - When a refresh fails (apps/auth down), the last key set fetched keeps
 *   verifying for one more JWT lifetime past the cache age, so a token issued
 *   before the outage works until its `exp` (spec: "tokens already issued
 *   still verify from the cache"). After that it fails closed.
 * - An unknown `kid` re-fetches at most once per 30 s cooldown, and so does a
 *   failed fetch (see `gatedFetch`), so a flood of random `kid`s, or traffic
 *   while apps/auth is down, cannot turn apps/api into an amplifier.
 */

/** The algorithm apps/auth signs with; nothing else is accepted. */
const JWT_ALGORITHMS = ['EdDSA'];
export const JWKS_PATH = '/api/auth/jwks';
export const JWKS_COOLDOWN_MS = 30_000;
export const JWKS_CACHE_MAX_AGE_MS = 600_000;
/** Better Auth's JWT lifetime (I-7): no token signed before an outage outlives this. */
export const JWKS_STALE_GRACE_MS = 15 * 60_000;

export interface VerifiedToken {
  /** The user's UUID, the same in both databases. */
  sub: string;
  /** The Better Auth session the token was minted from. */
  sid: string;
}

/**
 * jose's own cooldown applies only after a successful fetch: a failed one sets
 * no timestamp, so while apps/auth is down every request would fetch again.
 * This gate allows one network attempt per cooldown, successful or not. jose
 * itself never fetches twice within the cooldown after a success, so the gate
 * changes nothing in the healthy case.
 */
function gatedFetch(cooldownMs: number, onSuccess: () => void): typeof fetch {
  let lastAttempt = Number.NEGATIVE_INFINITY;
  return async (input, init) => {
    const now = Date.now();
    if (now - lastAttempt < cooldownMs) throw new Error('JWKS fetch cooling down');
    lastAttempt = now;
    const response = await fetch(input, init);
    if (response.status === 200 && isJwksLike(await response.clone().json().catch(() => null))) {
      onSuccess();
    }
    return response;
  };
}

/**
 * jose's own shape check before it installs a fetched set (`jwks/local.js`
 * `isJWKSLike`): a 200 whose body fails it is a failed refresh, and must not
 * extend the stale grace.
 */
function isJwksLike(body: unknown): boolean {
  if (!body || typeof body !== 'object') return false;
  const { keys } = body as { keys?: unknown };
  return (
    Array.isArray(keys) &&
    keys.every((k) => typeof k === 'object' && k !== null && !Array.isArray(k))
  );
}

/**
 * The remote key set, falling back to the last set it fetched when a refresh
 * fails, within the stale grace. An unknown or ambiguous `kid` is never a
 * reason to fall back: those come from the lookup, not from the fetch.
 */
function keySetWithStaleFallback(authUrl: string): JWTVerifyGetKey {
  let lastSuccess = Number.NEGATIVE_INFINITY;
  const remote = createRemoteJWKSet(new URL(JWKS_PATH, authUrl), {
    cooldownDuration: JWKS_COOLDOWN_MS,
    cacheMaxAge: JWKS_CACHE_MAX_AGE_MS,
    timeoutDuration: AUTH_SERVICE_TIMEOUT_MS,
    [customFetch]: gatedFetch(JWKS_COOLDOWN_MS, () => {
      lastSuccess = Date.now();
    }),
  });
  return async (header, token) => {
    try {
      return await remote(header, token);
    } catch (err) {
      if (err instanceof errors.JWKSNoMatchingKey || err instanceof errors.JWKSMultipleMatchingKeys) {
        throw err;
      }
      const lastGood = remote.jwks();
      const withinGrace = Date.now() - lastSuccess < JWKS_CACHE_MAX_AGE_MS + JWKS_STALE_GRACE_MS;
      if (!lastGood || !withinGrace) throw err;
      return createLocalJWKSet(lastGood)(header, token);
    }
  };
}

let cached: { key: string; jwks: JWTVerifyGetKey } | null = null;

/** One key set per URL, so a config change in tests takes effect. */
function remoteJwks(authUrl: string): JWTVerifyGetKey {
  if (cached?.key !== authUrl) {
    cached = { key: authUrl, jwks: keySetWithStaleFallback(authUrl) };
  }
  return cached.jwks;
}

/** Test-only: drop the cached key set, so the next verification starts cold. */
export function resetJwksCache(): void {
  cached = null;
}

/**
 * The token's subject and session, or null when it is not a valid apps/auth
 * access token for this audience. Never throws for a bad token.
 */
export async function verifyAccessToken(token: string): Promise<VerifiedToken | null> {
  const { url, jwtIssuer, jwtAudience } = config.authService;
  try {
    const { payload } = await jwtVerify(token, remoteJwks(url), {
      algorithms: JWT_ALGORITHMS,
      issuer: jwtIssuer,
      audience: jwtAudience,
      requiredClaims: ['exp', 'sub', 'sid'],
    });
    if (typeof payload.sub !== 'string' || typeof payload.sid !== 'string') return null;
    return { sub: payload.sub, sid: payload.sid };
  } catch {
    return null;
  }
}
