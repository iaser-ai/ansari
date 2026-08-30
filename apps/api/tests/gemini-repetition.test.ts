/**
 * Repetition-loop degeneration regression tests (issue #51).
 *
 * Prod evidence: some facilitator responses degenerate into a verbatim
 * repeated-sentence loop WITHIN a single Gemini generation — the largest was a
 * single 272,451-char text block (~400s latency) whose tail repeats one
 * sentence over and over. This happens inside one streamGemini call, so the
 * facilitator's tool-iteration caps (MAX_ITERATIONS etc.) cannot apply.
 *
 * The fix is two layers in lib/ai/gemini-client.ts:
 *  1. maxOutputTokens on every generation (server-side backstop, sized
 *     thinking-inclusive with large headroom — coordinated with issue #60);
 *  2. a runtime repetition guard: once accumulated visible text passes a floor
 *     (8,192 chars), the trailing 4,096-char window is periodically tested for
 *     verbatim periodicity (>= 3 repeats); on detection the stream is cut
 *     EARLY and CLEANLY — delivered text + a normal `done`, never an error and
 *     never a retry (which would duplicate already-delivered tokens).
 *
 * These tests mock the @google/genai SDK (like tests/gemini-truncation.test.ts)
 * to script degenerate and legitimate streams deterministically.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

type Chunk = {
  candidates?: Array<{ content?: { role: string; parts: unknown[] }; finishReason?: string }>;
  usageMetadata?: Record<string, number>;
};

// Scriptable SDK mock: each establishment (sendMessageStream call) pops the next
// script. `createConfigs` records the per-call GenerateContentConfig so tests can
// assert on maxOutputTokens.
const sdk = vi.hoisted(() => ({
  establishCalls: 0,
  createConfigs: [] as Array<Record<string, unknown>>,
  scripts: [] as Array<(model: string) => AsyncGenerator<unknown>>,
}));

vi.mock('@google/genai', () => ({
  ThinkingLevel: { LOW: 'LOW', HIGH: 'HIGH' },
  GoogleGenAI: class {
    constructor(_opts: unknown) {}
    chats = {
      create: (args: { model: string; config?: Record<string, unknown> }) => ({
        sendMessageStream: async () => {
          sdk.establishCalls += 1;
          sdk.createConfigs.push(args.config ?? {});
          const script = sdk.scripts.shift();
          if (!script) {
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

// gemini-client imports Sentry for the repetition-cut breadcrumb; mock it like
// the sibling gemini test files so the tests never touch the real SDK.
vi.mock('@sentry/nextjs', () => ({
  addBreadcrumb: vi.fn(),
  captureException: vi.fn(),
  captureMessage: vi.fn(),
}));

/** A streamed text part with no finishReason (a normal mid-stream delta). */
function fragmentChunk(text: string): Chunk {
  return { candidates: [{ content: { role: 'model', parts: [{ text }] } }] };
}

/** A complete text chunk with finishReason + usage (a normal terminal chunk). */
function textChunk(text: string, finishReason: string | null = 'STOP'): Chunk {
  const candidate: NonNullable<Chunk['candidates']>[number] = {
    content: { role: 'model', parts: [{ text }] },
  };
  if (finishReason) candidate.finishReason = finishReason;
  return {
    candidates: [candidate],
    usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 7, totalTokenCount: 12 },
  };
}

/** A terminal chunk that only carries a finishReason. */
function finishOnlyChunk(finishReason: string): Chunk {
  return { candidates: [{ content: { role: 'model', parts: [] }, finishReason }] };
}

// The prod degeneration shape: one ~100-char sentence repeated verbatim.
const LOOP_SENTENCE =
  'Moving for a better life or to a place where you can practice your Deen better is a valid pursuit. ';

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
  process.env.JWT_SECRET = 'test-secret-key-for-testing-purposes-only-32chars';
  process.env.GEMINI_API_KEY = 'test-gemini-key';
  process.env.KALEMAT_API_KEY = 'test-kalemat-key';
  process.env.USUL_API_TOKEN = 'test-usul-token';
  process.env.GEMINI_MODEL = 'gemini-primary';
  process.env.GEMINI_FALLBACK_MODEL = 'gemini-fallback';
  sdk.establishCalls = 0;
  sdk.createConfigs = [];
  sdk.scripts = [];
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Gemini repetition-loop degeneration (issue #51)', () => {
  it('cuts a degenerate repeated-sentence stream early and finishes cleanly (the 272K-char prod case)', async () => {
    // A coherent opening, then the prod loop: 2,720 verbatim repeats (~272K chars),
    // mirroring the largest prod message. Without the guard the full ~272K chars
    // stream through; with it the stream is cut within ~1 KB of degeneration.
    sdk.scripts = [
      async function* () {
        yield fragmentChunk('Here is a practical 3-month growth-bridge plan for you. ');
        for (let i = 0; i < 2720; i++) yield fragmentChunk(LOOP_SENTENCE);
        yield finishOnlyChunk('STOP');
      },
    ];

    const { streamGemini } = await import('../lib/ai/gemini-client');

    const texts: string[] = [];
    let done = false;
    let errored = false;
    for await (const ev of streamGemini('Give me a 3-month growth-bridge plan')) {
      if (ev.type === 'text') texts.push(ev.data);
      if (ev.type === 'done') done = true;
      if (ev.type === 'error') errored = true;
    }
    const delivered = texts.join('');

    // Cut early: past the 8,192-char check floor, but nowhere near the 272K-char
    // degenerate total (first check at 8,192 + at most 1,024-char check spacing).
    expect(delivered.length).toBeGreaterThanOrEqual(8192);
    expect(delivered.length).toBeLessThan(16000);
    // The answer's coherent opening was delivered.
    expect(delivered.startsWith('Here is a practical 3-month growth-bridge plan')).toBe(true);
    // Clean termination: a normal done event, no error...
    expect(done).toBe(true);
    expect(errored).toBe(false);
    // ...and NO retry: tokens were already delivered, so re-establishing the
    // stream would duplicate output. Exactly one establishment.
    expect(sdk.establishCalls).toBe(1);
  });

  it('cut is loud: logs a non-PII warning (lengths only, never the text)', async () => {
    sdk.scripts = [
      async function* () {
        for (let i = 0; i < 200; i++) yield fragmentChunk(LOOP_SENTENCE);
        yield finishOnlyChunk('STOP');
      },
    ];

    const { streamGemini } = await import('../lib/ai/gemini-client');
    for await (const ev of streamGemini('question')) {
      void ev;
    }

    const warnCalls = vi.mocked(console.warn).mock.calls;
    const repetitionWarn = warnCalls.find((c) => String(c[0]).includes('repetition loop detected'));
    expect(repetitionWarn).toBeDefined();
    // The structured summary carries lengths, never the response text.
    expect(JSON.stringify(repetitionWarn)).not.toContain('valid pursuit');
  });

  it('does NOT cut a long but non-repetitive answer', async () => {
    // ~12K chars of aperiodic text — longer than any legitimate prod answer, and
    // well past the guard's 8,192-char floor.
    const parts: string[] = [];
    for (let i = 0; i < 200; i++) {
      parts.push(`Point ${i}: sabr in hardship number ${i} differs from gratitude lesson ${i * 7}. `);
    }
    sdk.scripts = [
      async function* () {
        for (const p of parts) yield fragmentChunk(p);
        yield finishOnlyChunk('STOP');
      },
    ];

    const { streamGemini } = await import('../lib/ai/gemini-client');

    const texts: string[] = [];
    let doneText: string | undefined;
    for await (const ev of streamGemini('long question')) {
      if (ev.type === 'text') texts.push(ev.data);
      if (ev.type === 'done') doneText = ev.response.text;
    }

    // Everything delivered, nothing cut, no retry.
    expect(texts.join('')).toBe(parts.join(''));
    expect(doneText).toBe(parts.join(''));
    expect(sdk.establishCalls).toBe(1);
  });

  it('does NOT cut short repetitive-but-legitimate content (dhikr-style repetition below the floor)', async () => {
    // ~3.9K chars of verbatim repetition — a legitimate shape in an Islamic app
    // (repeated dhikr) that stays below the 8,192-char check floor.
    const dhikr = 'SubhanAllah wa bihamdihi. '.repeat(150);
    sdk.scripts = [
      async function* () {
        yield fragmentChunk(dhikr);
        yield finishOnlyChunk('STOP');
      },
    ];

    const { streamGemini } = await import('../lib/ai/gemini-client');

    const texts: string[] = [];
    for await (const ev of streamGemini('dhikr please')) {
      if (ev.type === 'text') texts.push(ev.data);
    }

    expect(texts.join('')).toBe(dhikr);
    expect(sdk.establishCalls).toBe(1);
  });

  it('sends maxOutputTokens=32768 on every generation (server-side backstop)', async () => {
    sdk.scripts = [
      async function* () {
        yield textChunk('short answer');
      },
    ];

    const { streamGemini } = await import('../lib/ai/gemini-client');
    for await (const ev of streamGemini('question')) {
      void ev;
    }

    expect(sdk.createConfigs).toHaveLength(1);
    expect(sdk.createConfigs[0].maxOutputTokens).toBe(32768);
  });

  it('keeps toolCalls in sync with rawPayload functionCalls when the tripping chunk carries them (issue #70)', async () => {
    // The production desync: the repetition guard trips on a chunk whose parts
    // list carries functionCall parts AFTER the degenerate text part. The old
    // mid-chunk `break` skipped those parts — they stayed in finalContent (and so
    // in rawPayload) but never reached `toolCalls`, so the facilitator built
    // fewer functionResponse parts than the stored turn's functionCall parts and
    // Vertex 400'd the next call. The fix processes the whole chunk and only
    // stops text emission.
    const callA = { functionCall: { name: 'search_quran', args: { query: 'q1' } } };
    const callB = {
      functionCall: { name: 'search_hadith', args: { query: 'q2' } },
      thoughtSignature: 'sig-on-call-b',
    };
    // Stay just under the 8,192-char check floor with plain fragments, so the
    // guard trips exactly on the chunk that also carries the function calls.
    const preCount = Math.floor((8192 - 1) / LOOP_SENTENCE.length);
    sdk.scripts = [
      async function* () {
        for (let i = 0; i < preCount; i++) yield fragmentChunk(LOOP_SENTENCE);
        yield {
          candidates: [
            {
              content: {
                role: 'model',
                parts: [{ text: LOOP_SENTENCE.repeat(3) }, callA, callB],
              },
            },
          ],
        } as Chunk;
        // Never pulled: the cut stops the stream after the tripping chunk.
        yield finishOnlyChunk('STOP');
      },
    ];

    const { streamGemini } = await import('../lib/ai/gemini-client');
    const Sentry = await import('@sentry/nextjs');

    const toolCallNames: string[] = [];
    let response:
      | { toolCalls: Array<{ name: string }>; rawPayload: { parts?: Array<Record<string, unknown>> } }
      | undefined;
    for await (const ev of streamGemini('question')) {
      if (ev.type === 'tool_call') toolCallNames.push(ev.data.name);
      if (ev.type === 'done') response = ev.response;
    }

    // Both parallel calls were collected AND emitted despite the cut...
    expect(toolCallNames).toEqual(['search_quran', 'search_hadith']);
    expect(response?.toolCalls.map((t) => t.name)).toEqual(['search_quran', 'search_hadith']);
    // ...and the stored model turn carries exactly as many functionCall parts as
    // toolCalls entries — the invariant that keeps Vertex happy on replay.
    const payloadCalls = (response?.rawPayload.parts ?? []).filter((p) => p.functionCall);
    expect(payloadCalls).toHaveLength(response?.toolCalls.length ?? -1);
    // Signature stays attached to its part in the stored payload.
    expect((response?.rawPayload.parts ?? []).some((p) => p.thoughtSignature === 'sig-on-call-b')).toBe(
      true
    );
    // Cut still happened (loud warning) but the desync tripwire stayed silent.
    const warns = vi.mocked(console.warn).mock.calls.map((c) => String(c[0]));
    expect(warns.some((w) => w.includes('repetition loop detected'))).toBe(true);
    expect(warns.some((w) => w.includes('desync'))).toBe(false);
    expect(
      vi.mocked(Sentry.captureMessage).mock.calls.some((c) => String(c[0]).includes('desync'))
    ).toBe(false);
    // No retry: delivered tokens must never be duplicated.
    expect(sdk.establishCalls).toBe(1);
  });

  it('keeps the same invariant on the continueWithToolResult path (issue #70)', async () => {
    // Same desync shape as above, but on the tool-continuation call — the other
    // streaming entry point that feeds toolCalls/rawPayload back into the loop.
    const call = { functionCall: { name: 'search_tafsir_encyclopedia', args: { query: 'q' } } };
    const preCount = Math.floor((8192 - 1) / LOOP_SENTENCE.length);
    sdk.scripts = [
      async function* () {
        for (let i = 0; i < preCount; i++) yield fragmentChunk(LOOP_SENTENCE);
        yield {
          candidates: [
            { content: { role: 'model', parts: [{ text: LOOP_SENTENCE.repeat(3) }, call] } },
          ],
        } as Chunk;
        yield finishOnlyChunk('STOP');
      },
    ];

    const { continueWithToolResult } = await import('../lib/ai/gemini-client');
    const res = await continueWithToolResult('search_quran', { ok: true }, []);

    expect(res.toolCalls.map((t) => t.name)).toEqual(['search_tafsir_encyclopedia']);
    const payloadCalls = (res.rawPayload.parts ?? []).filter((p) => p.functionCall);
    expect(payloadCalls).toHaveLength(res.toolCalls.length);
    // The complete-turn view carries the call too (persistence source, issue #70).
    expect(res.allParts.filter((p) => p.functionCall)).toHaveLength(1);
    expect(sdk.establishCalls).toBe(1);
  });

  it('delivers a MAX_TOKENS-terminated stream normally (cap hit is a deliberate stop, never retried)', async () => {
    sdk.scripts = [
      async function* () {
        yield fragmentChunk('A long answer that hit the output cap');
        yield finishOnlyChunk('MAX_TOKENS');
      },
    ];

    const { streamGemini } = await import('../lib/ai/gemini-client');

    const texts: string[] = [];
    let done = false;
    for await (const ev of streamGemini('question')) {
      if (ev.type === 'text') texts.push(ev.data);
      if (ev.type === 'done') done = true;
    }

    expect(texts.join('')).toBe('A long answer that hit the output cap');
    expect(done).toBe(true);
    expect(sdk.establishCalls).toBe(1);
  });
});
