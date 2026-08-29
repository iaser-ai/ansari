import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { usulSearch } from '../lib/tools/usul-client';
import { SearchMawsuah } from '../lib/tools/search-mawsuah';
import { SearchTafsir } from '../lib/tools/search-tafsir';

// The tools now report degraded events to Sentry via reportDegradedTool (Spec 43).
// Mock it so unit tests don't reach the network and so we can assert no-PII payloads.
vi.mock('@sentry/nextjs', () => ({
  captureMessage: vi.fn(),
  captureException: vi.fn(),
}));

// Config reads these lazily on first construction / call.
beforeEach(() => {
  process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
  process.env.JWT_SECRET = 'test-secret-key-for-testing-purposes-only-32chars';
  process.env.GEMINI_API_KEY = 'test-gemini-key';
  process.env.KALEMAT_API_KEY = 'test-kalemat-key';
  process.env.USUL_API_TOKEN = 'test-usul-token';
});

const BASE_URL = 'https://api.usul.ai/v1/vector-search/book/version';

function okResponse(results: unknown[]) {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => ({ results }),
  };
}

function errorResponse(status: number, statusText: string) {
  return { ok: false, status, statusText, json: async () => ({}) };
}

const SAMPLE_RESULT = {
  node: {
    text: 'The ruling on this matter is...',
    metadata: {
      pages: [{ page: '42', volume: '3' }],
      chapters: [{ title: 'Kitab al-Salah' }],
    },
  },
};

// Issue #54: usulSearch uses a flat per-attempt timeout — no backoff. Issue #72
// adds exactly one immediate retry on timeout ONLY; every other failure class
// (5xx / 4xx / network / invalid_body) still degrades on the first attempt.
describe('usulSearch resilience', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('returns results on a successful 200', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse([SAMPLE_RESULT]));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const data = await usulSearch(BASE_URL, 'zakat');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(data.results).toHaveLength(1);
  });

  it('throws immediately on a 502 — no retry (issue #54)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(errorResponse(502, 'Bad Gateway'));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(usulSearch(BASE_URL, 'zakat')).rejects.toThrow(/Usul API error: 502/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('throws immediately on a network error — no retry', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('fetch failed'));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(usulSearch(BASE_URL, 'zakat')).rejects.toThrow(/fetch failed/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('throws immediately on a 4xx client error', async () => {
    const fetchMock = vi.fn().mockResolvedValue(errorResponse(400, 'Bad Request'));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(usulSearch(BASE_URL, 'zakat')).rejects.toThrow(/Usul API error: 400/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('builds the request URL with the expected query params', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse([SAMPLE_RESULT]));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await usulSearch(BASE_URL, 'صلاة', { limit: 5 });

    const calledUrl = new URL(fetchMock.mock.calls[0][0] as string);
    expect(calledUrl.searchParams.get('q')).toBe('صلاة');
    expect(calledUrl.searchParams.get('limit')).toBe('5');
    expect(calledUrl.searchParams.get('page')).toBe('1');
    expect(calledUrl.searchParams.get('include_chapters')).toBe('false');
  });
});

// Tool-level: verify the user-observable behaviour end to end. The single flat
// timeout is a real timer, so the hang test uses fake timers to stay fast.
describe.each([
  ['SearchMawsuah', () => new SearchMawsuah(), 'Encyclopedia of Islamic Jurisprudence'],
  ['SearchTafsir', () => new SearchTafsir(), 'Tafsir Encyclopedia'],
] as const)('%s graceful degradation', (_name, makeTool, expectedTitleFragment) => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('returns real documents on a successful 200', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(okResponse([SAMPLE_RESULT])) as unknown as typeof fetch;

    const promise = makeTool().run('zakat');
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result.documents).toHaveLength(1);
    expect(result.documents[0].title).toContain(expectedTitleFragment);
    expect(result.documents[0].citations?.enabled).toBe(true);
    expect(result.isDegraded).toBeUndefined();
  });

  it('returns the unified "temporarily unavailable" result on a 5xx (single attempt)', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(errorResponse(502, 'Bad Gateway')) as unknown as typeof fetch;

    const promise = makeTool().run('zakat');
    await vi.runAllTimersAsync();
    const result = await promise;

    // Spec 43: degraded signal is the unified "temporarily unavailable" result,
    // NOT the old "Error searching …" string, and NOT "No results found".
    expect(result.content).toMatch(/temporarily unavailable/i);
    expect(result.content).not.toMatch(/Error searching/);
    expect(result.documents).toHaveLength(1);
    expect(result.documents[0].title).toBe('Source Temporarily Unavailable');
    expect(result.documents[0].citations?.enabled).toBe(false);
    // Issue #54: structured marker set on the degrade path.
    expect(result.isDegraded).toBe(true);
  });

  it('returns the unified "temporarily unavailable" result immediately on a 4xx (no retry)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(errorResponse(400, 'Bad Request'));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const promise = makeTool().run('zakat');
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.documents[0].title).toBe('Source Temporarily Unavailable');
    expect(result.documents[0].citations?.enabled).toBe(false);
    expect(result.isDegraded).toBe(true);
  });

  it('degrades gracefully (no hang) when the provider hangs past the timeout', async () => {
    // fetch never resolves on its own; it only rejects when its AbortSignal fires.
    const fetchMock = vi.fn().mockImplementation(
      (_url: string, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const err = new Error('The operation was aborted');
            err.name = 'AbortError';
            reject(err);
          });
        }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const promise = makeTool().run('zakat');
    await vi.runAllTimersAsync();
    const result = await promise;

    // The per-attempt AbortController timeout fires, the #72 timeout-only retry
    // runs once, and the tool degrades instead of hanging indefinitely.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.documents[0].title).toBe('Source Temporarily Unavailable');
    expect(result.documents[0].citations?.enabled).toBe(false);
    expect(result.isDegraded).toBe(true);
  });

  it('recovers real documents when the first attempt times out and the retry succeeds (issue #72)', async () => {
    // The issue's production scenario end to end: a tail-latency excursion eats
    // attempt 1; the immediate retry lands in the ~1-4s bulk and the user gets a
    // real answer instead of a degraded source.
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(
        (_url: string, init?: RequestInit) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => {
              const err = new Error('The operation was aborted');
              err.name = 'AbortError';
              reject(err);
            });
          }),
      )
      .mockResolvedValue(okResponse([SAMPLE_RESULT]));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const promise = makeTool().run('zakat');
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.documents).toHaveLength(1);
    expect(result.documents[0].title).toContain(expectedTitleFragment);
    expect(result.isDegraded).toBeUndefined();
  });

  it('reports attempts=2 and errorClass=timeout in the degraded telemetry when both attempts time out (issue #72)', async () => {
    const Sentry = await import('@sentry/nextjs');
    (Sentry.captureMessage as ReturnType<typeof vi.fn>).mockClear();
    const fetchMock = vi.fn().mockImplementation(
      (_url: string, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const err = new Error('The operation was aborted');
            err.name = 'AbortError';
            reject(err);
          });
        }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const promise = makeTool().run('zakat');
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result.isDegraded).toBe(true);
    expect(Sentry.captureMessage).toHaveBeenCalledTimes(1);
    const [, context] = (Sentry.captureMessage as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(context.extra.errorClass).toBe('timeout');
    // "Timed out twice" is distinguishable from a single-shot failure.
    expect(context.extra.attempts).toBe(2);
  });

  it('reports the degraded event to Sentry with NON-PII fields only', async () => {
    const Sentry = await import('@sentry/nextjs');
    (Sentry.captureMessage as ReturnType<typeof vi.fn>).mockClear();
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(errorResponse(502, 'Bad Gateway')) as unknown as typeof fetch;

    const promise = makeTool().run('a-private-user-query');
    await vi.runAllTimersAsync();
    await promise;

    expect(Sentry.captureMessage).toHaveBeenCalledTimes(1);
    const serialized = JSON.stringify(
      (Sentry.captureMessage as ReturnType<typeof vi.fn>).mock.calls[0],
    );
    expect(serialized).not.toContain('a-private-user-query');
    expect(serialized).not.toContain('?q=');
  });

  it('degrades a 200 whose body lacks a results array, never a silent "no results" (issue #2)', async () => {
    // A 200 error object / shape change previously left `data.results` undefined, so the tool
    // returned the benign "No results found" — invisible to the degraded counter and Sentry.
    // usulSearch now validates the top-level shape and degrades loudly instead.
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({ error: 'quota exceeded' }),
      }) as unknown as typeof fetch;

    const promise = makeTool().run('zakat');
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result.isDegraded).toBe(true);
    expect(result.documents[0].title).toBe('Source Temporarily Unavailable');
    expect(result.content).not.toMatch(/No results/i);
  });
});
