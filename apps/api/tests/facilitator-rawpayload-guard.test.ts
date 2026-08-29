import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Facilitator rawPayload hand-off + consistency guard (issue #70).
 *
 * The stateful SSE routes persist the assistant turn themselves on the `done`
 * event, so the final model turn's Content must ride on that event for the
 * rawPayload to ever reach the DB. And because a persisted payload is replayed
 * on EVERY later turn of the thread, a payload carrying functionCall parts with
 * no paired functionResponse would poison the thread permanently (Vertex 400 on
 * each turn) — the guard must null it loudly instead.
 *
 * Also locks the read-back side: an assistant message carrying a rawPayload must
 * be replayed VERBATIM as its history Content (convertToGeminiHistory's
 * rawPayload branch), signatures included.
 *
 * Mock scaffolding mirrors tests/facilitator-continuation.test.ts.
 */

type AnyEvent = { type: string; data?: unknown; response?: unknown };

const h = vi.hoisted(() => ({
  calls: [] as Array<{ message: string; options: { history?: unknown[] } }>,
  scripts: [] as Array<() => AsyncGenerator<AnyEvent>>,
  gemini: { model: 'primary-model', fallbackModel: 'fallback-model' },
}));

function doneResponse(
  text: string,
  toolCalls: Array<{ name: string; args: unknown }> = [],
  finishReason = 'STOP',
  rawPayload?: { role: string; parts: unknown[] }
) {
  return {
    text,
    toolCalls,
    rawPayload: rawPayload ?? { role: 'model', parts: text ? [{ text }] : [] },
    hasThinking: false,
    usage: { promptTokenCount: 1, candidatesTokenCount: 1, thoughtsTokenCount: 0, totalTokenCount: 2 },
    finishReason,
  };
}

vi.mock('@sentry/nextjs', () => ({
  captureMessage: vi.fn(),
  captureException: vi.fn(),
  addBreadcrumb: vi.fn(),
}));

vi.mock('@/lib/config', () => ({
  config: {
    get gemini() {
      return h.gemini;
    },
    inkling: { apiKey: undefined },
  },
}));

vi.mock('@/lib/ai/gemini-client', () => ({
  streamGemini: vi.fn((message: string, options: { history?: unknown[] }) => {
    h.calls.push({ message, options });
    const script = h.scripts.shift();
    if (script) return script();
    return (async function* () {
      yield { type: 'text', data: 'default answer' };
      yield { type: 'done', response: doneResponse('default answer') };
    })();
  }),
}));

vi.mock('@/lib/tools', () => ({
  getGeminiToolDescriptions: () => [{ name: 'search_quran' }],
  createToolMap: () => {
    const make = (name: string) => ({
      run: async () => ({
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
      }),
    });
    return new Map(
      ['search_quran', 'search_hadith', 'search_mawsuah', 'search_tafsir_encyclopedia'].map((n) => [
        n,
        make(n),
      ])
    );
  },
}));

// Import AFTER mocks.
import * as Sentry from '@sentry/nextjs';
import { runFacilitator, type Message, type FacilitatorStreamEvent } from '../lib/facilitator/agent';

const USER_TURN: Message = { role: 'user', content: [{ type: 'text', text: 'What is sabr?' }] };

async function collect(gen: AsyncGenerator<FacilitatorStreamEvent>): Promise<FacilitatorStreamEvent[]> {
  const events: FacilitatorStreamEvent[] = [];
  for await (const e of gen) events.push(e);
  return events;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.calls = [];
  h.scripts = [];
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('done event carries the final rawPayload (issue #70)', () => {
  it('hands the final model turn through verbatim — signatures included — on done and onMessage', async () => {
    const finalPayload = {
      role: 'model',
      parts: [{ text: 'Sabr is patience.', thoughtSignature: 'sig-final' }],
    };
    h.scripts = [
      // Round 1: model requests two parallel tools.
      async function* () {
        yield { type: 'tool_call', data: { name: 'search_quran', args: { query: 'sabr' } } };
        yield { type: 'tool_call', data: { name: 'search_hadith', args: { query: 'sabr' } } };
        yield {
          type: 'done',
          response: doneResponse('', [
            { name: 'search_quran', args: { query: 'sabr' } },
            { name: 'search_hadith', args: { query: 'sabr' } },
          ]),
        };
      },
      // Round 2: final text answer with a signature-bearing payload.
      async function* () {
        yield { type: 'text', data: 'Sabr is patience.' };
        yield { type: 'done', response: doneResponse('Sabr is patience.', [], 'STOP', finalPayload) };
      },
    ];

    const persisted: Message[] = [];
    const events = await collect(
      runFacilitator([USER_TURN], async (m) => {
        persisted.push(m);
      })
    );

    const done = events.find((e) => e.type === 'done');
    expect(done).toBeDefined();
    // Verbatim, by identity: no cloning/mangling between the model turn and the caller.
    expect(done?.rawPayload).toBe(finalPayload);
    expect(persisted).toHaveLength(1);
    expect(persisted[0].rawPayload).toBe(finalPayload);
    // Guard stayed silent on a clean payload.
    expect(
      vi.mocked(Sentry.captureMessage).mock.calls.some((c) => String(c[0]).includes('desync'))
    ).toBe(false);
  });

  it('guard: nulls a final payload carrying functionCall parts, loudly (never poison the thread)', async () => {
    // A desynced final: zero tool_call events reached the loop, yet the payload
    // carries a functionCall part. Persisting it would replay an orphan
    // functionCall on every later turn of the thread.
    const poisoned = {
      role: 'model',
      parts: [{ text: 'Partial answer.' }, { functionCall: { name: 'search_quran', args: {} } }],
    };
    h.scripts = [
      async function* () {
        yield { type: 'text', data: 'Partial answer.' };
        yield { type: 'done', response: doneResponse('Partial answer.', [], 'STOP', poisoned) };
      },
    ];

    const persisted: Message[] = [];
    const events = await collect(
      runFacilitator([USER_TURN], async (m) => {
        persisted.push(m);
      })
    );

    const done = events.find((e) => e.type === 'done');
    expect(done?.rawPayload).toBeNull();
    expect(persisted[0].rawPayload).toBeNull();
    // Loud: Sentry error with counts only, never content.
    const call = vi
      .mocked(Sentry.captureMessage)
      .mock.calls.find((c) => String(c[0]).includes('rawPayload functionCall desync'));
    expect(call).toBeDefined();
    expect(JSON.stringify(call)).not.toContain('Partial answer');
  });
});

describe('history replay uses the stored rawPayload (issue #70)', () => {
  it('replays a stored assistant rawPayload verbatim in the Gemini history on turn 2+', async () => {
    const storedPayload = {
      role: 'model',
      parts: [{ text: 'Earlier answer.', thoughtSignature: 'sig-earlier' }],
    };
    const history: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'First question' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Earlier answer.' }], rawPayload: storedPayload },
      { role: 'user', content: [{ type: 'text', text: 'Follow-up question' }] },
    ];

    await collect(runFacilitator(history));

    // The model call's history contains the stored Content itself, not a
    // text-only reconstruction.
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].options.history).toContainEqual(storedPayload);
  });

  it('falls back to text-only history for legacy assistant messages without rawPayload', async () => {
    const history: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'First question' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Earlier answer.' }], rawPayload: null },
      { role: 'user', content: [{ type: 'text', text: 'Follow-up question' }] },
    ];

    await collect(runFacilitator(history));

    expect(h.calls[0].options.history).toContainEqual({
      role: 'model',
      parts: [{ text: 'Earlier answer.' }],
    });
  });
});
