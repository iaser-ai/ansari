import { decodeJwt } from 'jose';
import { z } from 'zod';
import { isMcpClientId } from '@ansari/types/attribution';
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

/**
 * apps/auth's service-key verify route (#314; apps/auth
 * `routes/service-verify.ts`). Mounted at the public origin, it takes no
 * credential of its own: the key in the body is the caller's.
 */
export const SERVICE_VERIFY_PATH = '/api/service/verify-key';

/**
 * The longest service key apps/auth's verify route reads (apps/auth
 * `VERIFY_KEY_MAX_LENGTH`). apps/auth answers 400 to a key outside
 * `[\x21-\x7E]{1,256}`, and a 400 here is an outage (503), so a token outside
 * that envelope must be refused before the call. The two bounds change together.
 */
export const SERVICE_KEY_MAX_LENGTH = 256;
const SERVICE_KEY_SHAPE = new RegExp(`^[\\x21-\\x7E]{1,${SERVICE_KEY_MAX_LENGTH}}$`);

/** Whether `token` is inside the envelope apps/auth's verify route accepts (printable ASCII, 1–256 characters). */
export function isServiceKeyShape(token: string): boolean {
  return SERVICE_KEY_SHAPE.test(token);
}

const verifyServiceKeySchema = z.union([
  z.object({
    valid: z.literal(true),
    client_id: z.string().refine(isMcpClientId),
    key_id: z.string().min(1),
  }),
  z.object({ valid: z.literal(false) }).strict(),
]);

export type ServiceKeyVerdict =
  | { valid: true; clientId: string; keyId: string }
  | { valid: false };

/**
 * Ask apps/auth whether `key` is a live service key holding `mcp: ['complete']`.
 * `{ valid: false }` only when apps/auth said so in exactly that shape; any
 * other answer (no response, a non-200, a body of the wrong shape, a client id
 * off the `ansari-mcp` pattern) throws AuthServiceUnavailableError, and the
 * caller fails closed. The key is never logged: it is the caller's secret.
 *
 * The refusal is pinned on both sides: apps/auth's tests assert the
 * byte-identical body `{"valid":false}`, and this schema accepts that shape
 * only. Adding any field to the refusal body on apps/auth turns every bad key
 * into a 503 here, so the two change together.
 */
export async function verifyServiceKey(key: string): Promise<ServiceKeyVerdict> {
  const response = await authServiceFetch(SERVICE_VERIFY_PATH, {
    body: { key, permissions: { mcp: ['complete'] } },
  });
  if (response.status !== 200) throw new AuthServiceUnavailableError(response.status);
  const parsed = verifyServiceKeySchema.safeParse(await response.json().catch(() => undefined));
  if (!parsed.success) throw new AuthServiceUnavailableError(response.status);
  if (!parsed.data.valid) return { valid: false };
  return { valid: true, clientId: parsed.data.client_id, keyId: parsed.data.key_id };
}
