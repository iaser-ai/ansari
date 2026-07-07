import { config } from '../config';
import type { UsulSearchResult } from './types';
import { fetchWithTimeout } from './resilience';

/**
 * Shared client for the Usul.ai vector-search API used by SearchMawsuah and
 * SearchTafsir. Both tools hit the same `{base}/{bookId}/{versionId}?q=...`
 * pattern, so the request building and auth live here (DRY).
 *
 * Resilience is a single flat per-request timeout, delegated to
 * `fetchWithTimeout` (Spec 43; simplified in issue #54 — no more retries).
 * Without a timeout a hung request could stall a chat indefinitely. `usulSearch`
 * THROWS on failure — a `ToolFetchError` carrying status/errorClass — and the
 * calling tools convert that into a graceful degraded result.
 */

export interface UsulSearchOptions {
  /** Number of results to request (Usul `limit` param). Default 5. */
  limit?: number;
  /** Timeout in ms (AbortController). Default 10000 (issue #54). */
  timeoutMs?: number;
}

/**
 * Query the Usul.ai vector-search API with a single flat timeout (issue #54).
 * Throws a `ToolFetchError` on any non-2xx status, network error, or timeout —
 * callers keep their own graceful fallback for that case.
 *
 * @param baseUrl Fully-qualified `{USUL_BASE_URL}/{bookId}/{versionId}` endpoint.
 * @param query  Search query string.
 */
export async function usulSearch(
  baseUrl: string,
  query: string,
  options: UsulSearchOptions = {},
): Promise<UsulSearchResult> {
  const { limit = 5, timeoutMs } = options;

  const url = new URL(baseUrl);
  url.searchParams.set('q', query);
  url.searchParams.set('limit', String(limit));
  url.searchParams.set('page', '1');
  url.searchParams.set('include_chapters', 'false');

  const apiToken = config.tools.usul.apiToken;

  const response = await fetchWithTimeout(
    url.toString(),
    {
      headers: {
        Authorization: `Bearer ${apiToken}`,
        Accept: 'application/json',
      },
    },
    {
      timeoutMs,
      errorPrefix: 'Usul API error',
    },
  );

  return (await response.json()) as UsulSearchResult;
}
