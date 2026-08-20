/**
 * rawPayload functionCall preservation across multi-chunk streams (issue #83).
 *
 * streamGemini/continueWithToolResult used to build response.rawPayload as
 * "last chunk wins" (finalContent = candidate.content on every chunk). When
 * gemini-3.6-flash emits the functionCall in one chunk and then a trailing
 * content/thought chunk, the functionCall was absent from the stored rawPayload —
 * geminiHistory then replayed a model turn whose functionResponse had no
 * preceding functionCall, corrupting tool-round history for every continuation
 * and same-model retry (root cause under #81).
 *
 * The fix (streamRawPayload) merges the dropped functionCall part(s) back in by
 * substituting the full arrival-ordered part list — and ONLY when a functionCall
 * would otherwise be dropped, so the primary path still returns the last chunk's
 * candidate.content by identity (thought-signature handling untouched).
 *
 * These tests mock the @google/genai SDK like tests/gemini-stream-retry.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Content, Part } from '@google/genai';

type Chunk = {
  candidates?: Array<{ content: Content; finishReason?: string }>;
};

const sdk = vi.hoisted(() => ({
  scripts: [] as Array<(model: string) => AsyncGenerator<unknown>>,
  lastChunkContents: [] as unknown[],
}));

/** A chunk carrying the given parts; finishReason only on the terminal chunk. */
function chunk(parts: Part[], finishReason?: string): Chunk {
  const candidate: NonNullable<Chunk['candidates']>[number] = {
    content: { role: 'model', parts },
  };
  if (finishReason) candidate.finishReason = finishReason;
  sdk.lastChunkContents.push(candidate.content);
  return { candidates: [candidate] };
}

vi.mock('@google/genai', () => ({
  ThinkingLevel: { LOW: 'LOW', HIGH: 'HIGH' },
  GoogleGenAI: class {
    constructor(_opts: unknown) {}
    chats = {
      create: (args: { model: string }) => ({
        sendMessageStream: async () => {
          const script = sdk.scripts.shift();
          if (!script) throw new Error('test scripted no stream');
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
  sdk.scripts = [];
  sdk.lastChunkContents = [];
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('rawPayload functionCall preservation (issue #83)', () => {
  it('keeps the functionCall when a trailing chunk without it arrives last (streamGemini)', async () => {
    const callPart: Part = {
      functionCall: { name: 'search_quran', args: { query: 'sabr' } },
      thoughtSignature: 'sig-on-call',
    };
    const trailingPart: Part = { text: 'Let me search for that.' };
    sdk.scripts = [
      async function* () {
        yield chunk([callPart]);
        yield chunk([trailingPart], 'STOP');
      },
    ];

    const { streamGemini } = await import('../lib/ai/gemini-client');

    let response: import('../lib/ai/gemini-client').GeminiResponse | undefined;
    for await (const ev of streamGemini('What is sabr?')) {
      if (ev.type === 'done') response = ev.response;
    }

    // The tool ran (toolCalls accumulates) AND the stored model turn records it.
    expect(response?.toolCalls).toEqual([{ name: 'search_quran', args: { query: 'sabr' } }]);
    const parts = response?.rawPayload.parts ?? [];
    expect(parts.map((p) => (p.functionCall ? 'call' : 'text'))).toEqual(['call', 'text']);
    // Merged by reference, in arrival order: signature stays attached to its part.
    expect(parts[0]).toBe(callPart);
    expect(parts[0].thoughtSignature).toBe('sig-on-call');
    expect(parts[1]).toBe(trailingPart);
    expect(response?.rawPayload.role).toBe('model');
  });

  it('keeps the functionCall on the continueWithToolResult path', async () => {
    const callPart: Part = { functionCall: { name: 'search_hadith', args: { query: 'patience' } } };
    sdk.scripts = [
      async function* () {
        yield chunk([{ text: 'Checking hadith too. ' }]);
        yield chunk([callPart]);
        yield chunk([{ text: 'One moment.' }], 'STOP');
      },
    ];

    const { continueWithToolResult } = await import('../lib/ai/gemini-client');
    const res = await continueWithToolResult('search_quran', { ok: true }, []);

    expect(res.toolCalls).toEqual([{ name: 'search_hadith', args: { query: 'patience' } }]);
    expect(res.rawPayload.parts?.some((p) => p.functionCall?.name === 'search_hadith')).toBe(true);
    // Arrival order preserved end-to-end.
    expect(res.rawPayload.parts?.map((p) => (p.functionCall ? 'call' : 'text'))).toEqual([
      'text',
      'call',
      'text',
    ]);
  });

  it('leaves the primary path untouched: single-chunk content is returned by identity', async () => {
    sdk.scripts = [
      async function* () {
        yield chunk(
          [{ text: 'A complete answer.', thoughtSignature: 'sig-1' }],
          'STOP'
        );
      },
    ];

    const { callGeminiStreaming } = await import('../lib/ai/gemini-client');
    const res = await callGeminiStreaming('What is sabr?');

    // Exact candidate.content object — thought-signature format preserved verbatim.
    expect(res.rawPayload).toBe(sdk.lastChunkContents[0]);
    expect(res.rawPayload.parts?.[0].thoughtSignature).toBe('sig-1');
  });

  it('leaves last-chunk-wins in place when the last chunk already carries the functionCall', async () => {
    sdk.scripts = [
      async function* () {
        yield chunk([{ text: 'Thinking about it… and here is plenty of visible text.' }]);
        yield chunk([{ functionCall: { name: 'search_quran', args: {} }, thoughtSignature: 'sig-2' }], 'STOP');
      },
    ];

    const { callGeminiStreaming } = await import('../lib/ai/gemini-client');
    const res = await callGeminiStreaming('What is sabr?');

    // No functionCall was dropped, so the final chunk's content is kept by identity.
    expect(res.rawPayload).toBe(sdk.lastChunkContents[1]);
    expect(res.toolCalls).toEqual([{ name: 'search_quran', args: {} }]);
  });
});
