import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import * as Sentry from '@sentry/nextjs';
import {
  fetchJsonWithTimeout,
  ToolFetchError,
  toolLabel,
  TOOL_LABELS,
  unavailableResult,
  reportDegradedTool,
  TOOL_FETCH_TIMEOUT_MS,
  MAX_RESPONSE_BYTES,
} from '../lib/tools/resilience';

// Sentry must never be hit for real in unit tests, and we assert on its payload.
vi.mock('@sentry/nextjs', () => ({
  captureMessage: vi.fn(),
  captureException: vi.fn(),
}));

const URL_UNDER_TEST = 'https://api.example.com/search?q=secret-user-query';

function okResponse(body: unknown = { results: [] }): Response {
  return { ok: true, status: 200, statusText: 'OK', json: async () => body } as unknown as Response;
}

function errorResponse(status: number, statusText: string): Response {
  return { ok: false, status, statusText, json: async () => ({}) } as unknown as Response;
}

/** A fetch that hangs until its AbortSignal fires, then rejects with an AbortError. */
function hangingFetch() {
  return (_url: string, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        const err = new Error('The operation was aborted');
        err.name = 'AbortError';
        reject(err);
      });
    });
}

/**
 * A real 200 Response whose body stream emits `head` immediately, then STALLS until the
 * request's AbortSignal fires (issue #2: headers arrive, body hangs). Aborting errors the
 * stream so the reader's next read() rejects with an AbortError — the shape a real stalled
 * fetch body produces.
 */
function bodyHangResponse(head: string) {
  return (_url: string, init?: RequestInit): Promise<Response> => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        if (head) controller.enqueue(encoder.encode(head));
        init?.signal?.addEventListener('abort', () => {
          controller.error(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        });
      },
    });
    return Promise.resolve(new Response(stream, { status: 200, statusText: 'OK' }));
  };
}

/** A real 200 Response whose body is a single oversized chunk of `size` bytes (issue #2). */
function oversizedResponse(size: number): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(size));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, statusText: 'OK' });
}

describe('fetchJsonWithTimeout', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('returns the parsed JSON body on a 2xx (single attempt)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse({ results: [1, 2, 3] }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const data = await fetchJsonWithTimeout<{ results: number[] }>(URL_UNDER_TEST, {});

    expect(data).toEqual({ results: [1, 2, 3] });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('bounds the BODY read by the timeout: headers arrive, body hangs → timeout (issue #2)', async () => {
    const fetchMock = vi.fn().mockImplementation(bodyHangResponse('{"partial":'));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const err = await fetchJsonWithTimeout(URL_UNDER_TEST, {}, { timeoutMs: 40 }).catch((e) => e);

    expect(err).toBeInstanceOf(ToolFetchError);
    expect(err.errorClass).toBe('timeout');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('caps an oversized response body and degrades as too_large (issue #2)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(oversizedResponse(2048));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const err = await fetchJsonWithTimeout(URL_UNDER_TEST, {}, { maxBytes: 1024 }).catch((e) => e);

    expect(err).toBeInstanceOf(ToolFetchError);
    expect(err.errorClass).toBe('too_large');
  });

  it('degrades a 2xx with an unparseable body as invalid_body (issue #2)', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{not json'));
        controller.close();
      },
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(stream, { status: 200, statusText: 'OK' }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const err = await fetchJsonWithTimeout(URL_UNDER_TEST, {}).catch((e) => e);

    expect(err).toBeInstanceOf(ToolFetchError);
    expect(err.errorClass).toBe('invalid_body');
  });

  it('reads a streamed body inside the timeout window and returns parsed JSON', async () => {
    // A real streamed 200 (not the json()-only mock) must be read to completion and parsed.
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"results":'));
        controller.enqueue(new TextEncoder().encode('[{"id":"2:255"}]}'));
        controller.close();
      },
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(stream, { status: 200, statusText: 'OK' }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const data = await fetchJsonWithTimeout<{ results: Array<{ id: string }> }>(URL_UNDER_TEST, {});
    expect(data).toEqual({ results: [{ id: '2:255' }] });
  });

  it('exposes an 8 MiB default response cap (issue #2)', () => {
    expect(MAX_RESPONSE_BYTES).toBe(8 * 1024 * 1024);
  });

  it('throws ToolFetchError with http_5xx metadata immediately — no retry (issue #54)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(errorResponse(500, 'Internal Server Error'));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const err = await fetchJsonWithTimeout(URL_UNDER_TEST, {}, {
      errorPrefix: 'Usul API error',
    }).catch((e) => e);

    expect(err).toBeInstanceOf(ToolFetchError);
    expect(err.errorClass).toBe('http_5xx');
    expect(err.status).toBe(500);
    expect(err.attempts).toBe(1);
    expect(err.message).toBe('Usul API error: 500 Internal Server Error');
    // The single-attempt contract: a 5xx degrades immediately, it is NOT retried.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('throws ToolFetchError with http_4xx metadata immediately (no retry)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(errorResponse(400, 'Bad Request'));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const err = await fetchJsonWithTimeout(URL_UNDER_TEST, {}, {
      errorPrefix: 'Kalemat API error',
    }).catch((e) => e);

    expect(err).toBeInstanceOf(ToolFetchError);
    expect(err.errorClass).toBe('http_4xx');
    expect(err.status).toBe(400);
    expect(err.attempts).toBe(1);
    expect(err.message).toBe('Kalemat API error: 400 Bad Request');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('aborts a hung request at timeoutMs and classifies it as "timeout" (single attempt)', async () => {
    const fetchMock = vi.fn().mockImplementation(hangingFetch());
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const err = await fetchJsonWithTimeout(URL_UNDER_TEST, {}, {
      timeoutMs: 30,
    }).catch((e) => e);

    expect(err).toBeInstanceOf(ToolFetchError);
    expect(err.errorClass).toBe('timeout');
    expect(err.attempts).toBe(1);
    // Hung requests are aborted and degraded, never retried.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('classifies a network error as "network" immediately (no retry)', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('fetch failed'));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const err = await fetchJsonWithTimeout(URL_UNDER_TEST, {}).catch((e) => e);

    expect(err).toBeInstanceOf(ToolFetchError);
    expect(err.errorClass).toBe('network');
    expect(err.message).toBe('fetch failed');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('bounds per-tool wall-clock at ≤10s under the default flat timeout (issue #54)', async () => {
    // The old retry schedule (3×5000ms + backoff) burned ~16s, overrunning #49's
    // request budget. A single flat 10s AbortController timeout is now the whole
    // per-tool budget. Simulate a persistently hung provider with fake timers and
    // assert the total (simulated) wall-clock stays within the flat timeout — and
    // that fetch is attempted exactly ONCE (no retry).
    vi.useFakeTimers();
    try {
      const fetchMock = vi.fn().mockImplementation(hangingFetch());
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const start = Date.now();
      // No overrides → exercises the DEFAULT (production) flat timeout.
      const promise = fetchJsonWithTimeout(URL_UNDER_TEST, {}).catch((e) => e);
      await vi.runAllTimersAsync();
      const err = await promise;
      const elapsed = Date.now() - start;

      expect(err).toBeInstanceOf(ToolFetchError);
      expect(err.errorClass).toBe('timeout');
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(elapsed).toBeLessThanOrEqual(TOOL_FETCH_TIMEOUT_MS);
    } finally {
      vi.useRealTimers();
    }
  });

  it('passes the AbortController signal through to fetch', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse());
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await fetchJsonWithTimeout(URL_UNDER_TEST, { headers: { 'x-api-key': 'k' } });

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect((init.headers as Record<string, string>)['x-api-key']).toBe('k');
  });

  it('exposes a flat 10s default timeout (issue #54)', () => {
    expect(TOOL_FETCH_TIMEOUT_MS).toBe(10_000);
  });
});

describe('toolLabel / TOOL_LABELS', () => {
  it('maps known tool ids to human source labels', () => {
    expect(toolLabel('search_mawsuah')).toBe('Encyclopedia of Islamic Jurisprudence (Mawsuah)');
    expect(toolLabel('search_tafsir_encyclopedia')).toBe('Tafsir Encyclopedia');
    expect(toolLabel('search_quran')).toBe('Quran search');
    expect(toolLabel('search_hadith')).toBe('Hadith search');
  });

  it('covers all four registered tools', () => {
    expect(Object.keys(TOOL_LABELS)).toHaveLength(4);
  });

  it('falls back to the raw name for unknown tools', () => {
    expect(toolLabel('search_unknown')).toBe('search_unknown');
  });
});

describe('unavailableResult', () => {
  it('returns a single non-citable "temporarily unavailable" document', () => {
    const result = unavailableResult('Quran search');

    expect(result.content).toMatch(/temporarily unavailable/i);
    expect(result.documents).toHaveLength(1);
    expect(result.documents[0].title).toBe('Source Temporarily Unavailable');
    expect(result.documents[0].citations?.enabled).toBe(false);
    expect(result.documents[0].source.data).toMatch(/Quran search/);
  });

  it('is distinct from a "no results found" empty result', () => {
    const result = unavailableResult('Tafsir Encyclopedia');
    expect(result.content).not.toMatch(/no results/i);
  });

  it('sets the machine-readable isDegraded marker (issue #54)', () => {
    // #49's fail-fast reads this structured flag; it MUST NOT string-match the
    // human-facing "temporarily unavailable" content.
    const result = unavailableResult('Hadith search');
    expect(result.isDegraded).toBe(true);
  });
});

describe('reportDegradedTool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reports to Sentry at warning level with structured NON-PII fields', () => {
    reportDegradedTool({
      tool: 'search_mawsuah',
      provider: 'usul',
      status: 502,
      attempts: 1,
      errorClass: 'http_5xx',
      queryLength: 18,
    });

    expect(Sentry.captureMessage as Mock).toHaveBeenCalledTimes(1);
    const [message, context] = (Sentry.captureMessage as Mock).mock.calls[0];
    expect(message).toBe('Search tool degraded: search_mawsuah');
    expect(context.level).toBe('warning');
    expect(context.tags).toEqual({ tool: 'search_mawsuah', provider: 'usul' });
    expect(context.extra).toEqual({
      status: 502,
      attempts: 1,
      errorClass: 'http_5xx',
      queryLength: 18,
    });
  });

  it('never sends query text or a URL to Sentry (no-PII contract)', () => {
    reportDegradedTool({
      tool: 'search_quran',
      provider: 'kalemat',
      status: 500,
      attempts: 1,
      errorClass: 'http_5xx',
      queryLength: 'secret-user-query'.length,
    });

    const serialized = JSON.stringify((Sentry.captureMessage as Mock).mock.calls[0]);
    expect(serialized).not.toContain('secret-user-query');
    expect(serialized).not.toContain('?q=');
    expect(serialized).not.toContain('api.example.com');
  });

  it('also logs a NON-PII line to the server console', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    reportDegradedTool({
      tool: 'search_hadith',
      provider: 'kalemat',
      status: 503,
      attempts: 1,
      errorClass: 'http_5xx',
      queryLength: 5,
    });

    expect(warn).toHaveBeenCalledTimes(1);
    const line = warn.mock.calls[0][0] as string;
    expect(line).toContain('[kalemat] search_hadith: degraded');
    expect(line).not.toContain('?q=');
    expect(line).not.toContain('api.example.com');
  });
});
