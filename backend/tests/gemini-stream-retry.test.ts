/**
 * Mid-stream 429 retry + unhandledRejection regression tests (issue #37).
 *
 * The Gemini streaming path used to wrap only stream *establishment* in withRetry.
 * A 429 RESOURCE_EXHAUSTED that Vertex surfaces *during the first chunk pull*
 * (request accepted, then 429s) bypassed retry/fallback and reached the user.
 * Separately, streamGemini leaked an unhandledRejection on its normal-error path.
 *
 * These tests mock the @google/genai SDK (like tests/gemini.test.ts) so we can
 * make `sendMessageStream` resolve and then have the returned async iterator throw
 * mid-stream — before or after a token is emitted — and assert the new behavior.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

type Chunk = {
  candidates?: Array<{ content: { role: string; parts: unknown[] }; finishReason?: string }>;
};

// Mock state. `scripts` is a queue: each establishment (sendMessageStream call)
// pops the next script and returns the async iterator it produces. A script may
// inspect the target model to simulate model-specific congestion.
const sdk = vi.hoisted(() => ({
  primaryModel: 'gemini-primary',
  establishCalls: 0,
  modelsTried: [] as string[],
  scripts: [] as Array<(model: string) => AsyncGenerator<unknown>>,
}));

const RESOURCE_EXHAUSTED =
  'got status: RESOURCE_EXHAUSTED. {"error":{"code":429,"message":"Resource exhausted. Please try again later.","status":"RESOURCE_EXHAUSTED"}}';

// A complete text chunk carries a finishReason, exactly as a real Gemini stream's
// terminal chunk does. The gated-buffer truncation guard (issue #41) treats a
// stream that ends with NO finishReason as a silent truncation, so these
// single-chunk success mocks must set one to model a normal completion. Pass
// `null` to model a truncated fragment (no finishReason).
function textChunk(text: string, finishReason: string | null = 'STOP'): Chunk {
  const candidate: NonNullable<Chunk['candidates']>[number] = {
    content: { role: 'model', parts: [{ text }] },
  };
  if (finishReason) candidate.finishReason = finishReason;
  return { candidates: [candidate] };
}

function toolCallChunk(name: string): Chunk {
  return { candidates: [{ content: { role: 'model', parts: [{ functionCall: { name, args: {} } }] } }] };
}

vi.mock('@google/genai', () => ({
  ThinkingLevel: { LOW: 'LOW', HIGH: 'HIGH' },
  GoogleGenAI: class {
    constructor(_opts: unknown) {}
    chats = {
      create: (args: { model: string }) => ({
        // Establishment resolves successfully; the returned iterator is where
        // any mid-stream 429 surfaces (matching Vertex's accept-then-429 behavior).
        sendMessageStream: async () => {
          sdk.establishCalls += 1;
          sdk.modelsTried.push(args.model);
          const script = sdk.scripts.shift();
          if (!script) {
            // Default: a one-chunk success.
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
  sdk.primaryModel = 'gemini-primary';
  sdk.establishCalls = 0;
  sdk.modelsTried = [];
  sdk.scripts = [];
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('streamGemini mid-stream 429 (issue #37)', () => {
  it('(a) 429 on the first chunk pull — before any text — recovers via retry', async () => {
    sdk.scripts = [
      // Attempt 1: request accepted, then 429 on the very first pull. No text yet.
      // eslint-disable-next-line require-yield
      async function* () {
        throw new Error(RESOURCE_EXHAUSTED);
      },
      // Attempt 2 (retry): succeeds.
      async function* () {
        yield textChunk('Recovered answer');
      },
    ];

    const { streamGemini } = await import('../lib/ai/gemini-client');

    const texts: string[] = [];
    let doneText: string | undefined;
    for await (const ev of streamGemini('What is sabr?')) {
      if (ev.type === 'text') texts.push(ev.data);
      if (ev.type === 'done') doneText = ev.response.text;
    }

    expect(texts.join('')).toBe('Recovered answer'); // retry's output, exactly once
    expect(doneText).toBe('Recovered answer');
    expect(sdk.establishCalls).toBe(2); // one failed establishment + one retry
  });

  it('(b) 429 after a token is emitted does NOT retry, surfaces the error, no unhandledRejection', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);

    try {
      sdk.scripts = [
        // Emit one token, THEN 429. Retrying here would duplicate "Hello".
        async function* () {
          yield textChunk('Hello');
          throw new Error(RESOURCE_EXHAUSTED);
        },
      ];

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

      // Give Node a macrotask to raise any unhandledRejection from the orphaned
      // background reader before we assert there were none.
      await new Promise((r) => setTimeout(r, 50));

      expect(texts).toEqual(['Hello']); // delivered exactly once, no duplicate
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message).toContain('RESOURCE_EXHAUSTED'); // surfaced
      expect(sdk.establishCalls).toBe(1); // did NOT retry after emitting
      expect(unhandled).toHaveLength(0); // the leak is fixed
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('fast-fails over to the fallback model on the FIRST primary 429 — no primary backoff-retries (issue #44)', async () => {
    // A 429 means the primary's shared-capacity pool is exhausted now; retrying it
    // is wasted latency, so we go straight to the fallback's separate pool.
    const make = (model: string): AsyncGenerator<unknown> => {
      if (model === sdk.primaryModel) {
        // eslint-disable-next-line require-yield
        return (async function* () {
          throw new Error(RESOURCE_EXHAUSTED);
        })();
      }
      return (async function* () {
        yield textChunk(`answer from ${model}`);
      })();
    };
    sdk.scripts = [make, make]; // 1 primary attempt (429) → immediate fallback

    const { streamGemini } = await import('../lib/ai/gemini-client');

    const texts: string[] = [];
    for await (const ev of streamGemini('What is sabr?')) {
      if (ev.type === 'text') texts.push(ev.data);
    }

    expect(texts.join('')).toBe('answer from gemini-fallback');
    expect(sdk.modelsTried.filter((m) => m === 'gemini-primary')).toHaveLength(1); // no 4x retry
    expect(sdk.modelsTried.at(-1)).toBe('gemini-fallback');
  });

  it('locks retry after a tool_call — it is yielded to the consumer', async () => {
    sdk.scripts = [
      async function* () {
        yield toolCallChunk('search_quran'); // yielded to the consumer before the 429
        throw new Error(RESOURCE_EXHAUSTED);
      },
    ];

    const { streamGemini } = await import('../lib/ai/gemini-client');

    const types: string[] = [];
    let caught: unknown = null;
    try {
      for await (const ev of streamGemini('What is sabr?')) {
        types.push(ev.type);
      }
    } catch (e) {
      caught = e;
    }

    expect(types).toContain('tool_call'); // delivered to the caller
    expect(caught).toBeInstanceOf(Error);
    expect(sdk.establishCalls).toBe(1); // so the stream locked — no retry
  });
});

describe('callGeminiStreaming mid-stream 429 (issue #37)', () => {
  it('recovers from a first-chunk 429 via retry', async () => {
    sdk.scripts = [
      // eslint-disable-next-line require-yield
      async function* () {
        throw new Error(RESOURCE_EXHAUSTED);
      },
      async function* () {
        yield textChunk('Recovered');
      },
    ];

    const { callGeminiStreaming } = await import('../lib/ai/gemini-client');
    const res = await callGeminiStreaming('What is sabr?');

    expect(res.text).toBe('Recovered');
    expect(sdk.establishCalls).toBe(2);
  });

  it('does NOT retry after a chunk has been delivered to onTextChunk', async () => {
    sdk.scripts = [
      async function* () {
        yield textChunk('Partial');
        throw new Error(RESOURCE_EXHAUSTED);
      },
    ];

    const { callGeminiStreaming } = await import('../lib/ai/gemini-client');

    const delivered: string[] = [];
    await expect(
      callGeminiStreaming('What is sabr?', {
        onTextChunk: (t) => {
          delivered.push(t);
        },
      })
    ).rejects.toThrow(/RESOURCE_EXHAUSTED/);

    expect(delivered).toEqual(['Partial']); // delivered exactly once, no duplicate
    expect(sdk.establishCalls).toBe(1); // locked after first delivery
  });

  it('a hidden tool_call before any text does NOT lock retry (callback API)', async () => {
    // The callback API never surfaces tool_call/thought events to the caller —
    // they are only aggregated into the return value. A 429 after such a hidden
    // part but before any caller-visible text is still safe to retry.
    sdk.scripts = [
      async function* () {
        yield toolCallChunk('search_quran'); // not surfaced via any callback
        throw new Error(RESOURCE_EXHAUSTED);
      },
      async function* () {
        yield textChunk('Recovered after tool call');
      },
    ];

    const { callGeminiStreaming } = await import('../lib/ai/gemini-client');

    const delivered: string[] = [];
    const res = await callGeminiStreaming('What is sabr?', {
      onTextChunk: (t) => {
        delivered.push(t);
      },
    });

    expect(res.text).toBe('Recovered after tool call');
    expect(delivered).toEqual(['Recovered after tool call']);
    expect(sdk.establishCalls).toBe(2); // retried — nothing had reached the caller
  });
});

describe('continueWithToolResult mid-stream 429 (issue #37)', () => {
  it('recovers from a first-chunk 429 via retry', async () => {
    sdk.scripts = [
      // eslint-disable-next-line require-yield
      async function* () {
        throw new Error(RESOURCE_EXHAUSTED);
      },
      async function* () {
        yield textChunk('Continued');
      },
    ];

    const { continueWithToolResult } = await import('../lib/ai/gemini-client');
    const res = await continueWithToolResult('search_quran', { ok: true }, [], {});

    expect(res.text).toBe('Continued');
    expect(sdk.establishCalls).toBe(2);
  });

  it('does NOT retry after a chunk has been delivered to onTextChunk', async () => {
    sdk.scripts = [
      async function* () {
        yield textChunk('Partial');
        throw new Error(RESOURCE_EXHAUSTED);
      },
    ];

    const { continueWithToolResult } = await import('../lib/ai/gemini-client');

    const delivered: string[] = [];
    await expect(
      continueWithToolResult('search_quran', { ok: true }, [], {
        onTextChunk: (t) => {
          delivered.push(t);
        },
      })
    ).rejects.toThrow(/RESOURCE_EXHAUSTED/);

    expect(delivered).toEqual(['Partial']); // delivered exactly once, no duplicate
    expect(sdk.establishCalls).toBe(1); // locked after first delivery
  });
});
