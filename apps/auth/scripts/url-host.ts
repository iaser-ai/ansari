// What an operator script may say about a database URL: its host, never the
// user, password, path, query string or a parse error (any of which can carry
// a credential). Shared by the cutover rehearsal and the service-keys script.

/** The host of a postgres URL, lower-cased, or null when it does not parse. */
export function urlHost(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.toLowerCase() || null;
  } catch {
    return null;
  }
}

/** Postgres's port when a URL names none. */
const DEFAULT_PORT = '5432';

/** `hostname:port` of a postgres URL, or null when it does not parse. */
export function urlHostPort(url: string | undefined): string | null {
  const host = urlHost(url);
  if (host === null || url === undefined) return null;
  return `${host}:${new URL(url).port || DEFAULT_PORT}`;
}
