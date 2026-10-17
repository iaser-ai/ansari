import { decodeJwt } from 'jose';
import { z } from 'zod';
import { config } from '@/lib/config';

/**
 * The one HTTP client for apps/auth (spec 300, "Two databases" rule 8; owner
 * amendment 2026-10-17). apps/api reaches apps/auth like any other client: at
 * its public origin (`AUTH_URL`), with no shared credential. Calls about a
 * user carry that user's own JWT; the layer's calls are anonymous. Every call
 * times out after 3 s.
 *
 * Nothing here logs: a body can carry an email, and the headers carry a
 * bearer. Callers log ids and statuses only.
 */

export const AUTH_SERVICE_TIMEOUT_MS = 3_000;

/**
 * apps/auth could not give an answer: a network error, a timeout, a 5xx, a 429
 * or a response of the wrong shape. Callers fail closed on it (503), never
 * open, and never read it as "the user does not exist".
 */
export class AuthServiceUnavailableError extends Error {
  constructor(readonly status: number | null) {
    super(
      status === null
        ? 'apps/auth is unreachable'
        : `apps/auth answered ${status}`
    );
    this.name = 'AuthServiceUnavailableError';
  }
}

export interface AuthServiceRequest {
  method?: string;
  /** JSON-encoded as the body. */
  body?: unknown;
  /** Sent as `Authorization: Bearer <token>`. */
  bearer?: string;
  /** Extra headers (X-Ansari-Client). The Origin is always set here. */
  headers?: Record<string, string>;
}

/**
 * One request to apps/auth at its public origin. Resolves with the response for
 * any status apps/auth chose to send; rejects with AuthServiceUnavailableError
 * only when no response arrived.
 */
export async function authServiceFetch(
  path: string,
  request: AuthServiceRequest = {}
): Promise<Response> {
  const { url, layerOrigin } = config.authService;
  // Node's fetch sends Sec-Fetch-Mode, so better-auth's CSRF check wants a
  // trusted Origin; apps/auth trusts this one for that and nothing else.
  const headers: Record<string, string> = { ...request.headers, origin: layerOrigin };
  if (request.bearer) headers.authorization = `Bearer ${request.bearer}`;
  if (request.body !== undefined) headers['content-type'] = 'application/json';

  try {
    return await fetch(new URL(path, url), {
      method: request.method ?? (request.body === undefined ? 'GET' : 'POST'),
      headers,
      body: request.body === undefined ? undefined : JSON.stringify(request.body),
      redirect: 'manual',
      signal: AbortSignal.timeout(AUTH_SERVICE_TIMEOUT_MS),
    });
  } catch {
    throw new AuthServiceUnavailableError(null);
  }
}

/** apps/auth's account endpoints (apps/auth `routes/account.ts`), bound to the bearer's own sub. */
export const ACCOUNT_PATH = '/api/account';

const accountSchema = z.object({
  id: z.string(),
  email: z.string(),
  first_name: z.string().nullable(),
  last_name: z.string().nullable(),
  registered_via: z.string().nullable(),
  role: z.string().nullable(),
  banned: z.boolean(),
});

export type AuthAccount = z.infer<typeof accountSchema>;

/**
 * The bearer's own account: profile, role and ban state, read live. Null when
 * apps/auth refuses the token (401: its session has ended) or does not know
 * the user (404). apps/api has already verified `jwt` and passes its `sub`, so
 * an answer for anyone else is a fault, never a user.
 */
export async function getAuthAccount(sub: string, jwt: string): Promise<AuthAccount | null> {
  const response = await authServiceFetch(`${ACCOUNT_PATH}/me`, { bearer: jwt });
  if (response.status === 401 || response.status === 404) return null;
  if (response.status !== 200) throw new AuthServiceUnavailableError(response.status);
  const parsed = accountSchema.safeParse(await response.json().catch(() => undefined));
  if (!parsed.success || parsed.data.id !== sub) {
    throw new AuthServiceUnavailableError(response.status);
  }
  return parsed.data;
}

/** Thrown before any call when a token is not the subject's own. */
export class NotTheSubjectError extends Error {
  constructor() {
    super('the token is not the subject\'s own');
    this.name = 'NotTheSubjectError';
  }
}

/**
 * Delete the auth user `sub` and its sessions, asked with `jwt`. apps/auth
 * deletes the TOKEN's subject, so a token for anyone else is refused here,
 * before any call (callers pass a token they have verified; this is the
 * backstop). apps/auth answers 204 for a user already gone (even with the
 * token's session ended by the delete), so a retry is safe; any other answer
 * leaves the tombstone pending.
 */
export async function deleteAuthUser(sub: string, jwt: string): Promise<void> {
  let tokenSub: unknown;
  try {
    tokenSub = decodeJwt(jwt).sub;
  } catch {
    tokenSub = undefined;
  }
  if (tokenSub !== sub) throw new NotTheSubjectError();
  const response = await authServiceFetch(ACCOUNT_PATH, { method: 'DELETE', bearer: jwt });
  if (response.status !== 204) throw new AuthServiceUnavailableError(response.status);
}
