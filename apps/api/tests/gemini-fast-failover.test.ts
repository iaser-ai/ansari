/**
 * 429 fast-failover regression tests (issue #44).
 *
 * Under Vertex Dynamic Shared Quota congestion the primary model 429s
 * (RESOURCE_EXHAUSTED) on a separate capacity pool from the fallback. The old
 * streamWithRetry backoff-retried the PRIMARY up to 4 times (~3.5s) on a 429
 * before ever trying the fallback — and across the facilitator's multi-call tool
 * loop those wasted windows compounded into "loading indefinitely" requests.
 *
 * The fix: a 429 before the first token reaches the caller skips the primary's
 * backoff-retries and attempts the fallback model immediately. Other transient
 * errors (503/500/network/TruncatedStreamError) keep the existing primary-retry
 * behavior, and a fallback that ALSO 429s is bounded so it can never hang.
 *
 * These tests reuse the @google/genai SDK mock shape from
 * tests/gemini-stream-retry.test.ts: each establishment (sendMessageStream call)
 * pops the next script and returns the async iterator it produces, recording the
 * model it targeted so we can assert which pool each attempt hit.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

type Chunk = {
  candidates?: Array<{ content: { role: string; parts: unknown[] }; finishReason?: string }>;
};

const sdk = vi.hoisted(() => ({
  establishCalls: 0,
  modelsTried: [] as string[],
  scripts: [] as Array<(model: string) => AsyncGenerator<unknown>>,
}));

const RESOURCE_EXHAUSTED =
  'got status: RESOURCE_EXHAUSTED. {"error":{"code":429,"message":"Resource exhausted. Please try again later.","status":"RESOURCE_EXHAUSTED"}}';
const UNAVAILABLE =
  'got status: UNAVAILABLE. {"error":{"code":503,"message":"The service is currently unavailable.","status":"UNAVAILABLE"}}';

// A complete text chunk carries a finishReason, like a real terminal chunk does —
// the gated-buffer truncation guard (issue #41) flags a finishReason-less close as
// a silent truncation, so success mocks must set one.
function textChunk(text: string, finishReason: string | null = 'STOP'): Chunk {
  const candidate: NonNullable<Chunk['candidates']>[number] = {
    content: { role: 'model', parts: [{ text }] },
  };
  if (finishReason) candidate.finishReason = finishReason;
  return { candidates: [candidate] };
}

vi.mock('@google/genai', () => ({
  ThinkingLevel: { LOW: 'LOW', HIGH: 'HIGH' },
  GoogleGenAI: class {
    constructor(_opts: unknown) {}
    chats = {
      create: (args: { model: string }) => ({
        sendMessageStream: async () => {
          sdk.establishCalls += 1;
          sdk.modelsTried.push(args.model);
          const script = sdk.scripts.shift();
          if (!script) {
            // eslint-disable-next-line require-yield
            return (async function* () {
              yield textChunk(`answer from ${args.model}`);
            })();
          }
          return script(args.model);
        },
      }),
    };
  },
}));

beforeEach(() => {
  vi.resetModules();
  process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
  process.env.JWT_SECRET = 'test-secret-key-for-testing-purposes-only-32chars';
  process.env.GEMINI_API_KEY = 'test-gemini-key';
  process.env.KALEMAT_API_KEY = 'test-kalemat-key';
  process.env.USUL_API_TOKEN = 'test-usul-token';
  process.env.GEMINI_MODEL = 'gemini-primary';
  process.env.GEMINI_FALLBACK_MODEL = 'gemini-fallback';
  sdk.establishCalls = 0;
  sdk.modelsTried = [];
  sdk.scripts = [];
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('429 fast-failover (issue #44)', () => {
  it('a 429 before first token fails over to the fallback immediately — NO primary backoff-retries', async () => {
    sdk.scripts = [
      // Primary: 429 on the first pull, before any token.
      // eslint-disable-next-line require-yield
      async function* () {
        throw new Error(RESOURCE_EXHAUSTED);
      },
      // Fallback: succeeds.
      async function* () {
        yield textChunk('Answer from the fallback pool');
      },
    ];

    const { streamGemini } = await import('../lib/ai/gemini-client');

    const texts: string[] = [];
    for await (const ev of streamGemini('What is sabr?')) {
      if (ev.type === 'text') texts.push(ev.data);
    }

    expect(texts.join('')).toBe('Answer from the fallback pool');
    // The defining assertion: the primary was tried EXACTLY ONCE (no 4x backoff
    // retries), and the second establishment went straight to the fallback model.
    expect(sdk.modelsTried).toEqual(['gemini-primary', 'gemini-fallback']);
    expect(sdk.modelsTried.filter((m) => m === 'gemini-primary')).toHaveLength(1);
    expect(sdk.establishCalls).toBe(2);
  });

  it('a non-429 transient (503) still RETRIES the primary — no immediate failover', async () => {
    sdk.scripts = [
      // Primary attempt 1: a 503 (UNAVAILABLE), which is NOT a 429.
      // eslint-disable-next-line require-yield
      async function* () {
        throw new Error(UNAVAILABLE);
      },
      // Primary attempt 2 (retry of the SAME model): succeeds.
      async function* () {
        yield textChunk('Recovered on the primary');
      },
    ];

    const { streamGemini } = await import('../lib/ai/gemini-client');

    const texts: string[] = [];
    for await (const ev of streamGemini('What is sabr?')) {
      if (ev.type === 'text') texts.push(ev.data);
    }

    expect(texts.join('')).toBe('Recovered on the primary');
    // Both establishments hit the PRIMARY — a 503 retries the same model rather
    // than failing over, exactly as before this fix.
    expect(sdk.modelsTried).toEqual(['gemini-primary', 'gemini-primary']);
    expect(sdk.establishCalls).toBe(2);
  });

  it('with NO distinct fallback (fallback === primary), a 429 still RETRIES the primary — no single-attempt regression', async () => {
    // GEMINI_FALLBACK_MODEL defaults to the same value as GEMINI_MODEL, so commonly
    // there is no separate pool to fail over to. In that config a 429 must keep the
    // bounded primary backoff-retries rather than failing over (and immediately
    // bailing) after a single attempt.
    process.env.GEMINI_FALLBACK_MODEL = 'gemini-primary'; // same model as the primary
    sdk.scripts = [
      // Primary attempt 1: 429.
      // eslint-disable-next-line require-yield
      async function* () {
        throw new Error(RESOURCE_EXHAUSTED);
      },
      // Primary attempt 2 (retry of the SAME model): succeeds.
      async function* () {
        yield textChunk('Recovered on the primary');
      },
    ];

    const { streamGemini } = await import('../lib/ai/gemini-client');

    const texts: string[] = [];
    for await (const ev of streamGemini('What is sabr?')) {
      if (ev.type === 'text') texts.push(ev.data);
    }

    expect(texts.join('')).toBe('Recovered on the primary');
    // The 429 fell through to the bounded primary retry — both establishments hit
    // the primary, NOT a single attempt followed by a bail.
    expect(sdk.modelsTried).toEqual(['gemini-primary', 'gemini-primary']);
    expect(sdk.establishCalls).toBe(2);
  });

  it('a fallback that ALSO 429s is bounded and surfaces a clean error — never hangs', async () => {
    // Every model 429s. Primary fast-fails over once; the fallback then 429s on
    // every bounded retry. The path must terminate with a clean 429 error.
    const always429 = (): AsyncGenerator<unknown> =>
      // eslint-disable-next-line require-yield
      (async function* () {
        throw new Error(RESOURCE_EXHAUSTED);
      })();
    // 1 primary + (FALLBACK_MAX_RETRIES + 1) = up to 4 establishments; provide
    // plenty so an accidental unbounded loop would be visible as extra calls.
    sdk.scripts = [always429, always429, always429, always429, always429, always429];

    const { streamGemini } = await import('../lib/ai/gemini-client');

    const texts: string[] = [];
    let caught: unknown = null;
    try {
      for await (const ev of streamGemini('What is sabr?')) {
        if (ev.type === 'text') texts.push(ev.data);
      }
    } catch (e) {
      caught = e;
    }

    expect(texts).toEqual([]); // nothing ever reached the caller
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain('RESOURCE_EXHAUSTED'); // clean 429, not a hang
    // Primary tried once (fast-failover), then the fallback bounded at 3 attempts.
    expect(sdk.modelsTried.filter((m) => m === 'gemini-primary')).toHaveLength(1);
    const fallbackTries = sdk.modelsTried.filter((m) => m === 'gemini-fallback').length;
    expect(fallbackTries).toBe(3); // FALLBACK_MAX_RETRIES (2) + 1
    expect(sdk.establishCalls).toBe(4);
  }, 15000);

  it('callGeminiStreaming fast-fails over on a 429 too', async () => {
    sdk.scripts = [
      // eslint-disable-next-line require-yield
      async function* () {
        throw new Error(RESOURCE_EXHAUSTED);
      },
      async function* () {
        yield textChunk('Fallback answer');
      },
    ];

    const { callGeminiStreaming } = await import('../lib/ai/gemini-client');
    const res = await callGeminiStreaming('What is sabr?');

    expect(res.text).toBe('Fallback answer');
    expect(sdk.modelsTried).toEqual(['gemini-primary', 'gemini-fallback']);
    expect(sdk.establishCalls).toBe(2);
  });
});
