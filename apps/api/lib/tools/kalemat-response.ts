import { ToolFetchError } from './resilience';

/**
 * The items of a Kalimat `/search` 200 body, whichever of its two shapes it arrived in.
 *
 * Kalimat answers the same endpoint with a bare array of items or with an envelope
 * `{ results: [...], total_results_num }`, and the caller does not choose which (issue #383):
 * since 2026-11-05 every hadith search is enveloped, and a Quran search is enveloped when the
 * query is a verse reference ("2:255") or a surah name and a bare array otherwise. The items
 * themselves are the same in both.
 *
 * Any other body (an error object, `results` that is not an array, null) must NOT be waved
 * through as "No results found": that would tell the model the source had nothing to say,
 * invisibly to the degraded counter and Sentry (issue #2). It fails loudly as `invalid_body`
 * through the tools' existing degraded path instead.
 */
export function kalematResults<T>(body: unknown): T[] {
  if (Array.isArray(body)) return body as T[];
  if (typeof body === 'object' && body !== null) {
    const { results } = body as { results?: unknown };
    if (Array.isArray(results)) return results as T[];
  }
  throw new ToolFetchError(
    'Kalemat API error: unexpected response shape (expected an array or { results: [...] })',
    { errorClass: 'invalid_body' },
  );
}
