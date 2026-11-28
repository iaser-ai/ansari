import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Pinned-model requests — issue #393.
 *
 * `runFacilitator(history, onMessage, { model })` is the evaluation seam: every Gemini
 * call of the request targets that model with the cross-model failover off, and the
 * request never escalates to Inkling, so an answer recorded under a model's name was
 * written by that model or the request failed. A request without `model` must be
 * exactly what it was before the seam: no extra keys on its call options.
 *
 * Mock scaffolding mirrors tests/facilitator-inkling-rung.test.ts.
 */

type AnyEvent = { type: string; data?: unknown; response?: unknown };

const h = vi.hoisted(() => ({
  calls: [] as Array<{ message: string; options: Record<string, unknown> }>,
  scripts: [] as Array<() => AsyncGenerator<AnyEvent>>,
  inklingCalls: [] as Array<{ message: string; options: Record<string, unknown> }>,
  inklingConfigured: true,
  primaryBackend: 'gemini' as 'gemini' | 'inkling',
  toolBehavior: 'ok' as 'ok' | 'degrade',
}));

function doneResponse(
  text: string,
  toolCalls: Array<{ name: string; args: unknown }> = [],
  finishReason = 'STOP'
) {
  return {
    text,
    toolCalls,
    rawPayload: { role: 'model', parts: text ? [{ text }] : [] },
    allParts: text ? [{ text }] : [],
    hasThinking: false,
    usage: { promptTokenCount: 1, candidatesTokenCount: 1, thoughtsTokenCount: 0, totalTokenCount: 2 },
    finishReason,
  };
}

function textRound(text: string): () => AsyncGenerator<AnyEvent> {
  return async function* () {
    if (text) yield { type: 'text', data: text };
    yield { type: 'done', response: doneResponse(text) };
  };
}

function emptyRound(finishReason = 'STOP'): () => AsyncGenerator<AnyEvent> {
  return async function* () {
    yield { type: 'done', response: doneResponse('', [], finishReason) };
  };
}

function toolRound(names: string[]): () => AsyncGenerator<AnyEvent> {
  return async function* () {
    for (const name of names) yield { type: 'tool_call', data: { name, args: { query: 'q' } } };
    yield { type: 'done', response: doneResponse('', names.map((name) => ({ name, args: { query: 'q' } }))) };
  };
}

function errorRound(message: string): () => AsyncGenerator<AnyEvent> {
  // eslint-disable-next-line require-yield
  return async function* () {
    throw new Error(message);
  };
}

vi.mock('@sentry/nextjs', () => ({
  captureMessage: vi.fn(),
  captureException: vi.fn(),
  addBreadcrumb: vi.fn(),
}));

vi.mock('@/lib/config', () => ({
  config: {
    get primaryBackend() {
      return h.primaryBackend;
    },
    get gemini() {
      return { model: 'configured-model', fallbackModel: 'fallback-model' };
    },
    get inkling() {
      return { model: 'thinkingmachines/Inkling', timeoutMs: 180000 };
    },
  },
}));

vi.mock('@/lib/ai/gemini-client', () => ({
  streamGemini: vi.fn((message: string, options: Record<string, unknown>) => {
    h.calls.push({ message, options });
    const script = h.scripts.shift();
    if (script) return script();
    return textRound('default gemini answer')();
  }),
}));

vi.mock('@/lib/ai/inkling-client', () => ({
  isInklingConfigured: vi.fn(() => h.inklingConfigured),
  streamInkling: vi.fn((message: string, options: Record<string, unknown>) => {
    h.inklingCalls.push({ message, options });
    return textRound('inkling answer')();
  }),
}));

vi.mock('@/lib/ai/prompts/facilitator', () => ({
  FACILITATOR_SYSTEM_PROMPT: 'BASE_PROMPT\nCITATION FORMAT (VERY IMPORTANT):',
  TOOL_CONTINUATION_DIRECTIVE: 'CONTINUATION_DIRECTIVE',
}));

vi.mock('@/lib/tools', async () => {
  const { unavailableResult } = await vi.importActual<typeof import('../lib/tools/resilience')>(
    '../lib/tools/resilience'
  );
  return {
    getGeminiToolDescriptions: () => [{ name: 'search_quran' }],
    createToolMap: () => {
      const make = (name: string) => ({
        run: async () =>
          h.toolBehavior === 'degrade'
            ? unavailableResult(name)
            : {
                content: `result for ${name}`,
                documents: [
                  {
                    type: 'document',
                    source: { type: 'text', media_type: 'text/plain', data: 'doc' },
                    title: name,
                    context: 'src',
                    citations: { enabled: false },
                  },
                ],
              },
      });
      return new Map(['search_quran', 'search_hadith'].map((n) => [n, make(n)]));
    },
  };
});

// Import AFTER mocks.
import { runFacilitator, type Message, type FacilitatorStreamEvent } from '../lib/facilitator/agent';

async function collect(gen: AsyncGenerator<FacilitatorStreamEvent>): Promise<FacilitatorStreamEvent[]> {
  const events: FacilitatorStreamEvent[] = [];
  for await (const e of gen) events.push(e);
  return events;
}

const question: Message[] = [{ role: 'user', content: [{ type: 'text', text: 'q' }] }];

beforeEach(() => {
  h.calls = [];
  h.scripts = [];
  h.inklingCalls = [];
  h.inklingConfigured = true;
  h.primaryBackend = 'gemini';
  h.toolBehavior = 'ok';
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('runFacilitator with a pinned model (issue #393)', () => {
  it('targets the pinned model, failover off, on every call of the tool loop', async () => {
    h.scripts = [toolRound(['search_quran']), textRound('the answer')];
    const events = await collect(runFacilitator(question, undefined, { model: 'model-under-test' }));

    expect(h.calls).toHaveLength(2);
    for (const call of h.calls) {
      expect(call.options.model).toBe('model-under-test');
      expect(call.options.noModelFallback).toBe(true);
    }
    const done = events.at(-1)!;
    expect(done.type).toBe('done');
    expect(done.provenance).toEqual({ provider: 'gemini', modelId: 'model-under-test' });
  });

  it('pins the synthesis pass too', async () => {
    // Two degraded tool results trip T1, which runs the tools-disabled synthesis call.
    h.toolBehavior = 'degrade';
    h.scripts = [toolRound(['search_quran', 'search_hadith']), textRound('best effort answer')];
    const events = await collect(runFacilitator(question, undefined, { model: 'model-under-test' }));

    expect(h.calls).toHaveLength(2);
    const synthesis = h.calls[1];
    expect(synthesis.options.tools).toBeUndefined(); // it is the synthesis call
    expect(synthesis.options.model).toBe('model-under-test');
    expect(synthesis.options.noModelFallback).toBe(true);
    expect(events.at(-1)!.type).toBe('done');
  });

  it('never escalates an empty final to Inkling: one same-model retry, then an error', async () => {
    h.scripts = [emptyRound(), emptyRound(), emptyRound()];
    const events = await collect(runFacilitator(question, undefined, { model: 'model-under-test' }));

    expect(h.inklingCalls).toHaveLength(0);
    expect(h.calls).toHaveLength(2); // the first call + exactly one same-model retry
    expect(h.calls.every((c) => c.options.model === 'model-under-test')).toBe(true);
    const last = events.at(-1)!;
    expect(last.type).toBe('error');
    expect(last.provenance).toEqual({ provider: 'gemini', modelId: 'model-under-test' });
  });

  // Issue #444: the benchmark path pins its model, and that is where MALFORMED_RESPONSE
  // was seen. A pinned request gets the same-model retry and nothing more.
  it('retries an empty MALFORMED_RESPONSE final once on the pinned model, never on Inkling', async () => {
    h.scripts = [emptyRound('MALFORMED_RESPONSE'), textRound('the answer')];
    const events = await collect(runFacilitator(question, undefined, { model: 'model-under-test' }));

    expect(h.inklingCalls).toHaveLength(0);
    expect(h.calls).toHaveLength(2);
    expect(h.calls.every((c) => c.options.model === 'model-under-test')).toBe(true);
    expect(events.at(-1)!.type).toBe('done');
    expect(events.filter((e) => e.type === 'text').map((e) => e.data).join('')).toBe('the answer');
  });

  it('a pinned MALFORMED_RESPONSE that repeats: one same-model retry, then an error', async () => {
    h.scripts = [
      emptyRound('MALFORMED_RESPONSE'),
      emptyRound('MALFORMED_RESPONSE'),
      emptyRound('MALFORMED_RESPONSE'),
    ];
    const events = await collect(runFacilitator(question, undefined, { model: 'model-under-test' }));

    expect(h.inklingCalls).toHaveLength(0);
    expect(h.calls).toHaveLength(2); // the first call + exactly one same-model retry
    expect(h.calls.every((c) => c.options.model === 'model-under-test')).toBe(true);
    expect(events.at(-1)!.type).toBe('error');
  });

  it('never rescues a terminal Gemini error on Inkling', async () => {
    h.scripts = [errorRound('429 RESOURCE_EXHAUSTED')];
    const events = await collect(runFacilitator(question, undefined, { model: 'model-under-test' }));

    expect(h.inklingCalls).toHaveLength(0);
    expect(h.calls).toHaveLength(1);
    const last = events.at(-1)!;
    expect(last.type).toBe('error');
    expect(last.data).toContain('RESOURCE_EXHAUSTED');
  });

  it('selects Gemini even when PRIMARY_BACKEND is inkling', async () => {
    h.primaryBackend = 'inkling';
    const events = await collect(runFacilitator(question, undefined, { model: 'model-under-test' }));

    expect(h.inklingCalls).toHaveLength(0);
    expect(h.calls).toHaveLength(1);
    expect(events.at(-1)!.provenance).toEqual({ provider: 'gemini', modelId: 'model-under-test' });
  });

  it("refuses to combine a pinned model with provider 'inkling'", async () => {
    await expect(
      collect(runFacilitator(question, undefined, { model: 'model-under-test', provider: 'inkling' }))
    ).rejects.toThrow(/cannot be combined/);
    expect(h.calls).toHaveLength(0);
    expect(h.inklingCalls).toHaveLength(0);
  });

  // The controls: the same scripts WITHOUT `model` must behave as before the seam.
  it('adds no model keys to an unpinned request', async () => {
    h.scripts = [toolRound(['search_quran']), textRound('the answer')];
    const events = await collect(runFacilitator(question));

    expect(h.calls).toHaveLength(2);
    for (const call of h.calls) {
      expect('model' in call.options).toBe(false);
      expect('noModelFallback' in call.options).toBe(false);
    }
    expect(events.at(-1)!.provenance).toEqual({ provider: 'gemini', modelId: 'configured-model' });
  });

  it('still escalates an unpinned empty final to Inkling', async () => {
    h.scripts = [emptyRound(), emptyRound()];
    const events = await collect(runFacilitator(question));

    expect(h.inklingCalls).toHaveLength(1);
    expect(events.at(-1)!.type).toBe('done');
    expect(events.at(-1)!.provenance).toEqual({ provider: 'inkling', modelId: 'thinkingmachines/Inkling' });
  });
});
