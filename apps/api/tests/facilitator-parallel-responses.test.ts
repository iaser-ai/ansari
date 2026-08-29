import { describe, it, expect, vi, beforeEach } from 'vitest';
import { unavailableResult } from '../lib/tools/resilience';

/**
 * Parallel-call functionResponse packing — issue #14.
 *
 * Gemini requires the turn that follows a functionCall turn to carry exactly as
 * many functionResponse parts as the model emitted functionCall parts. The
 * facilitator used to push ONE single-part user Content per tool call, so a
 * round with N parallel calls produced a next-turn with 1 response part vs N
 * call parts — Vertex rejects the continuation with 400 "Please ensure that the
 * number of function response parts is equal to the number of function call
 * parts of the function call turn" (prod: iterations 2, toolCallCount 3).
 *
 * These tests lock the packing invariant: for every model turn containing
 * functionCall parts, the IMMEDIATELY FOLLOWING history Content is a single
 * 'user'-role Content whose functionResponse parts match the round's calls
 * one-for-one and in order — for healthy, degraded, and budget-skipped results
 * alike. Mock scaffolding mirrors tests/facilitator-t1.test.ts.
 */

type AnyEvent = { type: string; data?: unknown; response?: unknown };
type HistoryContent = {
  role?: string;
  parts?: Array<{ functionCall?: { name?: string }; functionResponse?: { name?: string }; text?: string }>;
};

const h = vi.hoisted(() => ({
  calls: [] as Array<{ message: string; history: HistoryContent[] }>,
  scripts: [] as Array<() => AsyncGenerator<AnyEvent>>,
  behavior: {} as Record<string, 'degrade' | 'ok'>,
}));

// Production-shaped tool round: rawPayload carries the functionCall parts, as
// gemini-client's streamRawPayload guarantees (#83).
function toolRound(names: string[]): () => AsyncGenerator<AnyEvent> {
  return async function* () {
    for (const name of names) {
      yield { type: 'tool_call', data: { name, args: { query: 'q' } } };
    }
    yield {
      type: 'done',
      response: {
        text: '',
        toolCalls: names.map((name) => ({ name, args: { query: 'q' } })),
        rawPayload: { role: 'model', parts: names.map((name) => ({ functionCall: { name, args: { query: 'q' } } })) },
        allParts: names.map((name) => ({ functionCall: { name, args: { query: 'q' } } })),
        hasThinking: false,
        usage: { promptTokenCount: 1, candidatesTokenCount: 1, thoughtsTokenCount: 0, totalTokenCount: 2 },
        finishReason: 'STOP',
      },
    };
  };
}

function textRound(text: string): () => AsyncGenerator<AnyEvent> {
  return async function* () {
    yield { type: 'text', data: text };
    yield {
      type: 'done',
      response: {
        text,
        toolCalls: [],
        rawPayload: { role: 'model', parts: [{ text }] },
        allParts: [{ text }],
        hasThinking: false,
        usage: { promptTokenCount: 1, candidatesTokenCount: 1, thoughtsTokenCount: 0, totalTokenCount: 2 },
        finishReason: 'STOP',
      },
    };
  };
}

vi.mock('@sentry/nextjs', () => ({
  captureMessage: vi.fn(),
  captureException: vi.fn(),
  addBreadcrumb: vi.fn(),
}));

vi.mock('@/lib/ai/gemini-client', () => ({
  streamGemini: vi.fn((message: string, options: { history?: HistoryContent[] }) => {
    // Snapshot the history: the agent mutates the same array across iterations.
    h.calls.push({ message, history: structuredClone(options.history ?? []) });
    const script = h.scripts.shift();
    if (script) return script();
    return textRound('default answer')();
  }),
}));

vi.mock('@/lib/ai/prompts/facilitator', () => ({
  FACILITATOR_SYSTEM_PROMPT: 'BASE_PROMPT',
  TOOL_CONTINUATION_DIRECTIVE: 'CONTINUATION_DIRECTIVE',
}));

vi.mock('@/lib/tools', () => ({
  getGeminiToolDescriptions: () => [{ name: 'search_quran' }],
  createToolMap: () => {
    const make = (name: string) => ({
      run: async () => {
        if ((h.behavior[name] ?? 'ok') === 'degrade') return unavailableResult(name);
        return {
          content: `real result for ${name}`,
          documents: [
            {
              type: 'document',
              source: { type: 'text', media_type: 'text/plain', data: 'doc' },
              title: name,
              context: 'src',
              citations: { enabled: false },
            },
          ],
        };
      },
    });
    return new Map(
      ['search_quran', 'search_hadith', 'search_mawsuah', 'search_tafsir_encyclopedia'].map((n) => [n, make(n)]),
    );
  },
}));

import { runFacilitator, type Message } from '../lib/facilitator/agent';

async function collect(gen: AsyncGenerator<{ type: string; data?: string }>): Promise<Array<{ type: string }>> {
  const events: Array<{ type: string }> = [];
  for await (const e of gen) events.push(e);
  return events;
}

function userMessage(text: string): Message {
  return { role: 'user', content: [{ type: 'text', text }] };
}

/**
 * The invariant under test: in `history`, every model Content carrying
 * functionCall parts is immediately followed by ONE user Content whose
 * functionResponse parts match the calls in count, name, and order.
 */
function expectMatchedFunctionRounds(history: HistoryContent[]): void {
  let functionCallTurns = 0;
  for (let i = 0; i < history.length; i++) {
    const callNames = (history[i].parts ?? [])
      .filter((p) => p.functionCall)
      .map((p) => p.functionCall!.name);
    if (callNames.length === 0) continue;
    functionCallTurns++;

    const next = history[i + 1];
    expect(next, `Content after functionCall turn at index ${i}`).toBeDefined();
    expect(next.role).toBe('user');
    const responseNames = (next.parts ?? [])
      .filter((p) => p.functionResponse)
      .map((p) => p.functionResponse!.name);
    expect(responseNames).toEqual(callNames);
  }
  expect(functionCallTurns).toBeGreaterThan(0);
}

beforeEach(() => {
  h.calls = [];
  h.scripts = [];
  h.behavior = {};
  vi.clearAllMocks();
});

describe('parallel functionResponse packing (issue #14)', () => {
  it('3 parallel calls → the continuation history has ONE user turn with 3 functionResponse parts', async () => {
    h.scripts = [
      toolRound(['search_quran', 'search_hadith', 'search_mawsuah']),
      textRound('Final answer.'),
    ];

    const events = await collect(runFacilitator([userMessage('q')]) as AsyncGenerator<{ type: string }>);
    expect(events.map((e) => e.type)).toContain('done');

    expect(h.calls).toHaveLength(2);
    expectMatchedFunctionRounds(h.calls[1].history);
  });

  it('a degraded tool in a parallel round still yields a matched response part (prod kalemat-timeout shape)', async () => {
    h.behavior = { search_hadith: 'degrade' }; // 1 degraded — below the T1 threshold, loop continues
    h.scripts = [
      toolRound(['search_quran', 'search_hadith', 'search_mawsuah']),
      textRound('Final answer.'),
    ];

    const events = await collect(runFacilitator([userMessage('q')]) as AsyncGenerator<{ type: string }>);
    expect(events.map((e) => e.type)).toContain('done');

    expect(h.calls).toHaveLength(2);
    expectMatchedFunctionRounds(h.calls[1].history);
  });

  it('T1 short-circuit mid-round: skipped calls land in the SAME user turn, so synthesis history is valid', async () => {
    // First two calls degrade → T1 fires at the threshold; the third is budget-skipped.
    h.behavior = { search_quran: 'degrade', search_hadith: 'degrade' };
    h.scripts = [
      toolRound(['search_quran', 'search_hadith', 'search_mawsuah']),
      textRound('Best-effort synthesis.'),
    ];

    const events = await collect(runFacilitator([userMessage('q')]) as AsyncGenerator<{ type: string }>);
    expect(events.map((e) => e.type)).toContain('done');

    // Second call is the synthesis pass; its history must satisfy the same invariant.
    expect(h.calls).toHaveLength(2);
    expectMatchedFunctionRounds(h.calls[1].history);
  });

  it('single-call rounds keep the unchanged shape: one user turn with exactly one functionResponse part', async () => {
    h.scripts = [toolRound(['search_quran']), toolRound(['search_hadith']), textRound('Final answer.')];

    const events = await collect(runFacilitator([userMessage('q')]) as AsyncGenerator<{ type: string }>);
    expect(events.map((e) => e.type)).toContain('done');

    expect(h.calls).toHaveLength(3);
    expectMatchedFunctionRounds(h.calls[2].history);
    // Each single-call round produced a single-part response turn.
    const responseTurns = h.calls[2].history.filter((c) =>
      (c.parts ?? []).some((p) => p.functionResponse),
    );
    expect(responseTurns).toHaveLength(2);
    for (const turn of responseTurns) {
      expect((turn.parts ?? []).filter((p) => p.functionResponse)).toHaveLength(1);
    }
  });
});
