import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SearchQuran } from '../lib/tools/search-quran';
import { SearchHadith } from '../lib/tools/search-hadith';

// The Kalemat tools report degraded events to Sentry via reportDegradedTool
// (Spec 43). Mock it so unit tests don't reach the network and we can assert no-PII.
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

function okJson(body: unknown) {
  return { ok: true, status: 200, statusText: 'OK', json: async () => body };
}

function errorResponse(status: number, statusText: string) {
  return { ok: false, status, statusText, json: async () => ({}) };
}

/** A fetch that hangs until its AbortSignal fires, then rejects with an AbortError. */
function hangingFetch() {
  return (_url: string, init?: RequestInit) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        const err = new Error('The operation was aborted');
        err.name = 'AbortError';
        reject(err);
      });
    });
}

const QURAN_RESULT = { id: '2:255', text: 'ٱللَّهُ لَآ إِلَٰهَ', en_text: 'Allah - there is no deity' };
const HADITH_RESULT = {
  id: 'h1',
  source_book: 'Sahih Bukhari',
  chapter_number: '2',
  chapter_english: 'Belief',
  section_number: '1',
  section_english: 'Faith',
  hadith_number: '8',
  en_text: 'Islam is based on five...',
  ar_text: 'بُنِيَ الإسلام',
  grade_en: 'Sahih',
};

describe.each([
  ['SearchQuran', () => new SearchQuran(), QURAN_RESULT, 'Quran 2:255', /No Quran verses found/i],
  ['SearchHadith', () => new SearchHadith(), HADITH_RESULT, 'Sahih Bukhari', /No hadith found/i],
] as const)('%s resilience', (_name, makeTool, sampleResult, titleFragment, emptyContentRe) => {
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
      .mockResolvedValue(okJson([sampleResult])) as unknown as typeof fetch;

    const promise = makeTool().run('faith');
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result.documents).toHaveLength(1);
    expect(result.documents[0].title).toContain(titleFragment);
    expect(result.documents[0].citations?.enabled).toBe(true);
    expect(result.isDegraded).toBeUndefined();
  });

  it('returns the unified "temporarily unavailable" result on a 5xx (single attempt)', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(errorResponse(502, 'Bad Gateway')) as unknown as typeof fetch;

    const promise = makeTool().run('faith');
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result.content).toMatch(/temporarily unavailable/i);
    expect(result.content).not.toMatch(/Error searching/);
    expect(result.documents[0].title).toBe('Source Temporarily Unavailable');
    expect(result.documents[0].citations?.enabled).toBe(false);
    // Issue #54: structured marker set on the degrade path.
    expect(result.isDegraded).toBe(true);
    // Spec 73: HTTP failures carry class + status + the single attempt.
    expect(result.degradation).toEqual({ errorClass: 'http_5xx', attempts: 1, status: 502 });
  });

  it('returns the unified "temporarily unavailable" result immediately on a 4xx (no retry)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(errorResponse(400, 'Bad Request'));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const promise = makeTool().run('faith');
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.documents[0].title).toBe('Source Temporarily Unavailable');
    expect(result.isDegraded).toBe(true);
  });

  it('degrades gracefully (no hang) when the provider hangs past the timeout', async () => {
    const fetchMock = vi.fn().mockImplementation(hangingFetch());
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const promise = makeTool().run('faith');
    await vi.runAllTimersAsync();
    const result = await promise;

    // The shared #72 timeout-only retry applies to the Kalemat tools too: one
    // immediate retry per timed-out call, then the graceful degrade.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.documents[0].title).toBe('Source Temporarily Unavailable');
    expect(result.documents[0].citations?.enabled).toBe(false);
    expect(result.isDegraded).toBe(true);
    // Spec 73: the real ToolFetchError's retry detail rides on the result — this is
    // what the persisted tool_result record reads (attempts=2 on a retried timeout).
    expect(result.degradation).toEqual({ errorClass: 'timeout', attempts: 2 });
  });

  it('treats an empty 200 result as "no results", NOT "temporarily unavailable"', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(okJson([])) as unknown as typeof fetch;

    const promise = makeTool().run('faith');
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result.content).toMatch(emptyContentRe);
    expect(result.documents[0].title).toBe('No Results');
    expect(result.documents[0].title).not.toBe('Source Temporarily Unavailable');
  });

  it('treats a 200 with a non-array body as DEGRADED, never a silent "no results" (issue #2)', async () => {
    // A shape change / error object at a 200 previously had `data.length === undefined`, so the
    // tool returned the benign "No results found" — telling the model the source had nothing to
    // say rather than that it failed (invisible to the degraded counter and Sentry). It must now
    // degrade loudly through the resilience path.
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(okJson({ error: 'quota exceeded' })) as unknown as typeof fetch;

    const promise = makeTool().run('faith');
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result.isDegraded).toBe(true);
    expect(result.documents[0].title).toBe('Source Temporarily Unavailable');
    expect(result.content).not.toMatch(emptyContentRe);
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
    const [message, context] = (Sentry.captureMessage as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(message).toMatch(/Search tool degraded/);
    expect(context.level).toBe('warning');
    expect(context.tags.provider).toBe('kalemat');

    const serialized = JSON.stringify(
      (Sentry.captureMessage as ReturnType<typeof vi.fn>).mock.calls[0],
    );
    expect(serialized).not.toContain('a-private-user-query');
    expect(serialized).not.toContain('?q=');
  });
});
