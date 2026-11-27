/**
 * Small helpers shared by the three HTTP clients.
 *
 * Python used `httpx`; Node ships `fetch`. Three differences that the clients have to handle:
 * - `httpx` does not follow redirects, `fetch` does. Every call here passes `redirect: 'manual'` and treats a 3xx as a
 *   failure, so a token is never sent to a place the operator did not configure.
 * - `httpx`'s timeout is per wait (connecting, then each read). `fetch` has none, only an `AbortSignal` you build yourself.
 *   Every call here gets one plain deadline.
 * - A `fetch` response whose body is never read keeps its connection busy until it is garbage-collected, so every
 *   response a client gives up on goes through `discardBody`.
 */

/** The type of `fetch`. Clients take it as an option so tests can hand in a fake. */
export type FetchLike = typeof fetch;

/** Release a response we will not read. Errors are ignored: the body may already be consumed or locked. */
export async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // already consumed or locked
  }
}

/**
 * A short, safe description of why a `fetch` failed, for logs: the error's class, plus the system error code when there
 * is one (`TypeError/ECONNREFUSED`). Never the message: Node's can include the URL.
 */
export function describeNetworkError(error: unknown): string {
  if (!(error instanceof Error)) return typeof error;
  const cause: unknown = error.cause;
  const code = cause instanceof Error && 'code' in cause ? String((cause as { code: unknown }).code) : undefined;
  return code ? `${error.name}/${code}` : error.name;
}

/** Remove trailing slashes, so `http://host/` + `/path` does not become `http://host//path`. */
export function trimTrailingSlashes(url: string): string {
  return url.replace(/\/+$/, '');
}
