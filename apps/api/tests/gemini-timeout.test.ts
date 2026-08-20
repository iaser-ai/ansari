/**
 * Per-call timeout option on streamGemini (issue #49, Phase 1).
 *
 * The facilitator's request budget (Phase 2) needs to bound each Gemini call to the
 * remaining request deadline. streamGemini gains an optional `timeoutMs`:
 *   - the effective overall deadline is `min(GEMINI_TIMEOUT_MS, timeoutMs)`,
 *   - the consumer-loop deadline bounds the *response* even if the SDK ignores abort,
 *   - when set, an AbortController is wired into the SDK request for true cancellation,
 *   - when omitted, behavior is unchanged (no signal, 3-min default).
 *
 * Mocks @google/genai like tests/gemini-stream-retry.test.ts, additionally capturing the
 * abortSignal passed on the chat config so we can assert cancellation.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

type Chunk = {
  candidates?: Array<{ content: { role: string; parts: unknown[] }; finishReason?: string }>;
};

const sdk = vi.hoisted(() => ({
  capturedSignal: undefined as AbortSignal | undefined,
  createCalls: 0,
  scripts: [] as Array<(signal?: AbortSignal) => AsyncGenerator<unknown>>,
}));

function textChunk(text: string, finishReason: string | null = 'STOP'): Chunk {
  const candidate: NonNullable<Chunk['candidates']>[number] = {
    content: { role: 'model', parts: [{ text }] },
  };
  if (finishReason) candidate.finishReason = finishReason;
  return { candidates: [candidate] };
}

// A stream that never yields and ignores the abort signal — proves the consumer-loop
// deadline bounds the response even when the SDK does not honor cancellation.
async function* hangIgnoringSignal(): AsyncGenerator<unknown> {
  await new Promise<never>(() => {}); // never resolves
  yield textChunk('never'); // unreachable
}

// A stream that only ends when its abort signal fires — proves native cancellation.
function hangUntilAbort(signal?: AbortSignal): AsyncGenerator<unknown> {
  return (async function* () {
    await new Promise<never>((_, reject) => {
      if (signal) signal.addEventListener('abort', () => reject(new Error('aborted by signal')));
    });
    yield textChunk('never'); // unreachable
  })();
}

vi.mock('@google/genai', () => ({
  ThinkingLevel: { LOW: 'LOW', HIGH: 'HIGH' },
  GoogleGenAI: class {
    constructor(_opts: unknown) {}
    chats = {
      create: (args: { model: string; config?: { abortSignal?: AbortSignal } }) => {
        sdk.createCalls += 1;
        sdk.capturedSignal = args.config?.abortSignal;
        const signal = args.config?.abortSignal;
        return {
          sendMessageStream: async () => {
            const script = sdk.scripts.shift();
            if (!script) {
              return (async function* () {
                yield textChunk('default answer');
              })();
            }
            return script(signal);
          },
        };
      },
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
  sdk.capturedSignal = undefined;
  sdk.createCalls = 0;
  sdk.scripts = [];
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('streamGemini per-call timeout (issue #49)', () => {
  it('bounds a hanging call within timeoutMs even if the SDK ignores abort', async () => {
    sdk.scripts = [() => hangIgnoringSignal()];
    const { streamGemini } = await import('../lib/ai/gemini-client');

    const start = Date.now();
    let caught: unknown = null;
    try {
      for await (const _ev of streamGemini('What is sabr?', { timeoutMs: 100 })) {
        // consume
      }
    } catch (e) {
      caught = e;
    }
    const elapsed = Date.now() - start;

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/deadline|hang/i);
    expect(elapsed).toBeLessThan(2000); // bounded ~100ms; generous ceiling for CI
  });

  it('aborts the underlying request when the deadline elapses (native cancellation)', async () => {
    sdk.scripts = [(signal) => hangUntilAbort(signal)];
    const { streamGemini } = await import('../lib/ai/gemini-client');

    let caught: unknown = null;
    try {
      for await (const _ev of streamGemini('What is sabr?', { timeoutMs: 100 })) {
        // consume
      }
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(Error);
    expect(sdk.capturedSignal).toBeInstanceOf(AbortSignal);
    expect(sdk.capturedSignal?.aborted).toBe(true);
  });

  it('does not wire an abort signal when timeoutMs is omitted (default behavior)', async () => {
    sdk.scripts = [
      () =>
        (async function* () {
          yield textChunk('hello');
        })(),
    ];
    const { streamGemini } = await import('../lib/ai/gemini-client');

    const texts: string[] = [];
    for await (const ev of streamGemini('What is sabr?')) {
      if (ev.type === 'text') texts.push(ev.data);
    }

    expect(texts.join('')).toBe('hello');
    expect(sdk.capturedSignal).toBeUndefined();
  });

  it('completes a fast successful call within timeoutMs without cutting it off', async () => {
    sdk.scripts = [
      () =>
        (async function* () {
          yield textChunk('done well');
        })(),
    ];
    const { streamGemini } = await import('../lib/ai/gemini-client');

    const texts: string[] = [];
    let doneText: string | undefined;
    for await (const ev of streamGemini('What is sabr?', { timeoutMs: 5000 })) {
      if (ev.type === 'text') texts.push(ev.data);
      if (ev.type === 'done') doneText = ev.response.text;
    }

    expect(texts.join('')).toBe('done well');
    expect(doneText).toBe('done well');
    expect(sdk.capturedSignal).toBeInstanceOf(AbortSignal); // wired, but the call succeeded
  });

  it('clamps timeoutMs to the 3-min default when larger (effective = min)', async () => {
    // Assert directly on the scheduled abort-timer delay: it must be the clamped default
    // (180000), never the larger caller value (600000). Deterministic, no time advance.
    const delays: number[] = [];
    const realSetTimeout = global.setTimeout;
    vi.spyOn(global, 'setTimeout').mockImplementation(((fn: (...a: unknown[]) => void, ms?: number, ...rest: unknown[]) => {
      if (typeof ms === 'number') delays.push(ms);
      return realSetTimeout(fn, ms, ...rest);
    }) as typeof setTimeout);

    sdk.scripts = [
      () =>
        (async function* () {
          yield textChunk('ok');
        })(),
    ];
    const { streamGemini } = await import('../lib/ai/gemini-client');

    for await (const _ev of streamGemini('What is sabr?', { timeoutMs: 10 * 60_000 })) {
      // consume
    }

    expect(delays).toContain(180_000); // abort timer scheduled at the clamped default
    expect(delays).not.toContain(600_000); // never the larger caller timeoutMs
  });
});
