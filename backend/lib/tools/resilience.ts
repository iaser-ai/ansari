import * as Sentry from '@sentry/nextjs';
import type { ToolResult } from './types';

/**
 * Shared resilience layer for the Islamic search tools (Spec 43; simplified for
 * issue #54).
 *
 * All four search tools (Kalemat: quran/hadith; Usul: mawsuah/tafsir) call
 * third-party providers that intermittently return 5xx or hang. This module is
 * the single source of truth for:
 *   - a single flat per-tool timeout (AbortController — true cancellation, not a
 *     leaked race) that bounds each tool call's wall-clock,
 *   - a consistent "temporarily unavailable" degraded ToolResult carrying a
 *     machine-readable {@link ToolResult.isDegraded} marker, and
 *   - no-PII observability (console + Sentry) for degraded-tool events.
 *
 * Issue #54: the earlier retry-with-backoff schedule (inherited from #48) was
 * replaced by a single flat timeout. Retrying transient failures forced the
 * per-attempt timeout down to fit an aggregate wall-clock budget, which risked
 * false-degrading healthy-but-slow (3–5s) calls, and the multi-attempt scheme
 * was hard to reason about. One AbortController timeout is simpler to debug,
 * lets slow-but-healthy calls through, and directly gives the per-tool
 * ≤{@link TOOL_FETCH_TIMEOUT_MS} bound the request-time budget (#49) needs.
 */

/**
 * Flat per-tool request timeout (AbortController). A single attempt bounded by
 * this timeout is the entire per-tool wall-clock budget: no retries, no backoff.
 * Set to 10s so slow-but-healthy providers still succeed while a hung or failing
 * provider cannot overrun the request-time budget (#49).
 */
export const TOOL_FETCH_TIMEOUT_MS = 10_000;

/** Classification of why a fetch failed. All NON-PII. */
export type ToolFetchErrorClass = 'http_5xx' | 'http_4xx' | 'network' | 'timeout';

/**
 * Rich error thrown by {@link fetchWithTimeout} on failure. Carries the
 * structured, NON-PII fields callers forward to {@link reportDegradedTool}.
 *
 * IMPORTANT: the request URL (which contains `?q=<query>`) is deliberately never
 * stored on this error, so it cannot leak user content into logs or Sentry.
 */
export class ToolFetchError extends Error {
  readonly status?: number;
  /**
   * Attempts made before failing. Always 1 under the single-attempt model
   * (issue #54); retained so the degraded-event monitoring shape is stable.
   */
  readonly attempts: number;
  readonly errorClass: ToolFetchErrorClass;

  constructor(
    message: string,
    info: { status?: number; attempts?: number; errorClass: ToolFetchErrorClass },
  ) {
    super(message);
    this.name = 'ToolFetchError';
    this.status = info.status;
    this.attempts = info.attempts ?? 1;
    this.errorClass = info.errorClass;
  }
}

export interface FetchTimeoutOptions {
  /** Timeout in ms (AbortController). Default {@link TOOL_FETCH_TIMEOUT_MS}. */
  timeoutMs?: number;
  /**
   * Prefix for thrown error messages, preserving each provider's existing wording
   * (e.g. 'Usul API error' → "Usul API error: 502 Bad Gateway"). Default 'HTTP error'.
   */
  errorPrefix?: string;
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

/**
 * Fetch a URL with a single flat timeout (issue #54) — one attempt, no retry,
 * no backoff. Returns the successful `Response` (caller reads the body); throws a
 * {@link ToolFetchError} on any non-2xx status, network error, or timeout.
 *
 * The timeout is enforced with an AbortController so a hung request is actually
 * cancelled (the reported "loading indefinitely" failure mode), not merely raced.
 * Callers convert the thrown error into a graceful degraded result, so the total
 * per-tool wall-clock is bounded by `timeoutMs` (≤{@link TOOL_FETCH_TIMEOUT_MS}).
 */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  options: FetchTimeoutOptions = {},
): Promise<Response> {
  const { timeoutMs = TOOL_FETCH_TIMEOUT_MS, errorPrefix = 'HTTP error' } = options;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    // Either the timeout fired (AbortError) or a network-level failure.
    if (isAbortError(err)) {
      throw new ToolFetchError(`${errorPrefix}: request timed out after ${timeoutMs}ms`, {
        errorClass: 'timeout',
      });
    }
    throw new ToolFetchError(err instanceof Error ? err.message : String(err), {
      errorClass: 'network',
    });
  } finally {
    clearTimeout(timer);
  }

  if (response.ok) {
    return response;
  }

  // Any non-2xx degrades immediately (single attempt — no retry). The 4xx/5xx
  // split is preserved only to keep the NON-PII errorClass useful for monitoring.
  const errorClass: ToolFetchErrorClass =
    response.status >= 400 && response.status < 500 ? 'http_4xx' : 'http_5xx';
  throw new ToolFetchError(`${errorPrefix}: ${response.status} ${response.statusText}`, {
    status: response.status,
    errorClass,
  });
}

/**
 * Map from internal tool id to the human-facing source label. Used by BOTH the
 * tools and the facilitator backstop so the degraded wording is identical
 * everywhere (no per-site drift).
 */
export const TOOL_LABELS: Record<string, string> = {
  search_quran: 'Quran search',
  search_hadith: 'Hadith search',
  search_mawsuah: 'Encyclopedia of Islamic Jurisprudence (Mawsuah)',
  search_tafsir_encyclopedia: 'Tafsir Encyclopedia',
};

/** Human-facing source label for a tool id; falls back to the raw id if unknown. */
export function toolLabel(toolName: string): string {
  return TOOL_LABELS[toolName] ?? toolName;
}

/**
 * The single canonical "temporarily unavailable" degraded result. Distinct from
 * the tools' existing "No results found" empty result: it tells the facilitator a
 * source could not be consulted (so it proceeds with other sources / its own
 * knowledge) rather than implying the source had nothing to say. Citations are
 * disabled so the model never cites the unavailable-notice as a source.
 *
 * `isDegraded: true` (issue #54) is the machine-readable marker for programmatic
 * consumers (e.g. #49's fail-fast). Every degrade path — timeout, HTTP error,
 * and network error — funnels through here, so the flag covers all of them.
 * Consumers MUST read this flag, never string-match the human-facing content.
 */
export function unavailableResult(label: string): ToolResult {
  return {
    isDegraded: true,
    content: `The ${label} is temporarily unavailable. Answer from the other sources and your own knowledge; note that this source could not be consulted.`,
    documents: [
      {
        type: 'document',
        source: {
          type: 'text',
          media_type: 'text/plain',
          data: `The ${label} source is temporarily unavailable.`,
        },
        title: 'Source Temporarily Unavailable',
        context: label,
        citations: { enabled: false },
      },
    ],
  };
}

export interface DegradedToolInfo {
  /** Internal tool id, e.g. 'search_mawsuah'. */
  tool: string;
  /** Provider tag, e.g. 'usul' | 'kalemat'. */
  provider: string;
  /** HTTP status, when the failure was an HTTP error. */
  status?: number;
  /** Attempts made before degrading (always 1 under the single-attempt model). */
  attempts?: number;
  /** Why it ultimately failed. */
  errorClass?: ToolFetchErrorClass;
  /** Length (not content) of the query, for rough monitoring. */
  queryLength?: number;
}

/**
 * Record a degraded-tool event for monitoring. Logs to the server console and
 * reports to Sentry at WARNING level (degradation is expected/handled — no pager
 * noise).
 *
 * NO-PII CONTRACT (spec 6): this function takes ONLY structured NON-PII fields —
 * never a raw `Error` (whose message/stack can contain the request URL with
 * `?q=<query>`) and never the query text itself. Neither the console line nor the
 * Sentry event includes the URL or query.
 */
export function reportDegradedTool(info: DegradedToolInfo): void {
  const { tool, provider, status, attempts, errorClass, queryLength } = info;

  console.warn(
    `[${provider}] ${tool}: degraded — errorClass=${errorClass ?? 'unknown'} status=${
      status ?? 'n/a'
    } attempts=${attempts ?? 'n/a'}`,
  );

  Sentry.captureMessage(`Search tool degraded: ${tool}`, {
    level: 'warning',
    tags: { tool, provider },
    extra: { status, attempts, errorClass, queryLength },
  });
}
