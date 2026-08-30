/**
 * A tiny registration bridge between the auth session (which owns the tokens)
 * and the transport layer (`http.ts`, `streaming.ts`). The `AuthProvider`
 * registers a token getter and an unauthorized handler here at startup; the
 * transport reads them without importing React or creating a dependency cycle.
 *
 * The vendored `custom-fetch.ts` already has its own `setAuthTokenGetter` used
 * for attaching the bearer header on generated/`customFetch` calls. This bridge
 * additionally exposes the current token to the streaming path (which bypasses
 * `customFetch`) and a single-flight refresh handler for 401 recovery.
 */

type TokenGetter = () => Promise<string | null> | string | null;

/** Attempts a token refresh; resolves to a fresh access token, or null on failure. */
type UnauthorizedHandler = () => Promise<string | null>;

let _tokenGetter: TokenGetter | null = null;
let _unauthorizedHandler: UnauthorizedHandler | null = null;

export function setAccessTokenGetter(getter: TokenGetter | null): void {
  _tokenGetter = getter;
}

export async function getAccessToken(): Promise<string | null> {
  if (!_tokenGetter) return null;
  return _tokenGetter();
}

export function setUnauthorizedHandler(handler: UnauthorizedHandler | null): void {
  _unauthorizedHandler = handler;
}

/**
 * Invoked by the transport on a 401. Delegates to the registered handler (the
 * AuthProvider, which does single-flight refresh + logout-on-failure). Returns a
 * fresh access token to retry with, or null if the caller should give up.
 */
export async function handleUnauthorized(): Promise<string | null> {
  if (!_unauthorizedHandler) return null;
  return _unauthorizedHandler();
}
