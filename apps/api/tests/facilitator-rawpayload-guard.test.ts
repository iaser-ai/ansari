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
  // The complete arrival-ordered turn; rawPayload (in-request replay view) may
  // legitimately hold only the final delta — see the fragment test below.
  allParts?: unknown[],
  rawPayload?: { role: string; parts: unknown[] }
) {
  const parts = text ? [{ text }] : [];
  return {
    text,
    toolCalls,
    rawPayload: rawPayload ?? { role: 'model', parts },
    allParts: allParts ?? parts,
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

describe('done event carries the final turn payload (issue #70)', () => {
  it('hands the final model turn through — signatures included — on done and onMessage', async () => {
    const finalParts = [{ text: 'Sabr is patience.', thoughtSignature: 'sig-final' }];
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
      // Round 2: final text answer with a signature-bearing part.
      async function* () {
        yield { type: 'text', data: 'Sabr is patience.' };
        yield { type: 'done', response: doneResponse('Sabr is patience.', [], 'STOP', finalParts) };
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
    expect(done?.rawPayload).toEqual({ role: 'model', parts: finalParts });
    expect(persisted).toHaveLength(1);
    expect(persisted[0].rawPayload).toEqual({ role: 'model', parts: finalParts });
    // Guard stayed silent on a clean payload.
    expect(
      vi.mocked(Sentry.captureMessage).mock.calls.some((c) => String(c[0]).includes('desync'))
    ).toBe(false);
  });

  it('persists the COMPLETE multi-chunk turn, not the last-chunk rawPayload fragment', async () => {
    // The consultation-found defect: for a streamed multi-chunk answer,
    // response.rawPayload is last-chunk-wins (#83) — only the final text delta.
    // The persisted payload must come from allParts (the whole turn), or turn 2+
    // replays a fragment of the prior answer.
    const fullTurn = [
      { text: 'Sabr in the Quran means patient perseverance. ' },
      { text: 'And Allah knows best.', thoughtSignature: 'sig-tail' },
    ];
    const lastChunkOnly = { role: 'model', parts: [fullTurn[1]] };
    h.scripts = [
      async function* () {
        yield { type: 'text', data: fullTurn[0].text };
        yield { type: 'text', data: fullTurn[1].text };
        yield {
          type: 'done',
          response: doneResponse(
            fullTurn[0].text + fullTurn[1].text,
            [],
            'STOP',
            fullTurn,
            lastChunkOnly
          ),
        };
      },
    ];

    const events = await collect(runFacilitator([USER_TURN]));

    const done = events.find((e) => e.type === 'done');
    expect(done?.rawPayload).toEqual({ role: 'model', parts: fullTurn });
    // Signature stays attached to its original part.
    expect(done?.rawPayload?.parts?.[1].thoughtSignature).toBe('sig-tail');
  });

  it('never persists thought parts (reasoning must not be stored)', async () => {
    const turn = [
      { text: 'internal reasoning summary', thought: true },
      { text: 'Visible answer.' },
    ];
    h.scripts = [
      async function* () {
        yield { type: 'text', data: 'Visible answer.' };
        yield { type: 'done', response: doneResponse('Visible answer.', [], 'STOP', turn) };
      },
    ];

    const events = await collect(runFacilitator([USER_TURN]));

    const done = events.find((e) => e.type === 'done');
    expect(done?.rawPayload).toEqual({ role: 'model', parts: [{ text: 'Visible answer.' }] });
  });

  it('persists null when nothing remains after filtering (no empty payloads)', async () => {
    // Only a thought part in the turn; visible text arrives but the turn parts
    // are all filtered — persist null so replay falls back to content text.
    const turn = [{ text: 'reasoning only', thought: true }];
    h.scripts = [
      async function* () {
        yield { type: 'text', data: 'A real visible answer nonetheless.' };
        yield {
          type: 'done',
          response: doneResponse('A real visible answer nonetheless.', [], 'STOP', turn),
        };
      },
    ];

    const events = await collect(runFacilitator([USER_TURN]));

    const done = events.find((e) => e.type === 'done');
    expect(done?.rawPayload).toBeNull();
  });

  it('guard: nulls a final payload carrying functionCall parts, loudly (never poison the thread)', async () => {
    // A desynced final: zero tool_call events reached the loop, yet the turn
    // carries a functionCall part. Persisting it would replay an orphan
    // functionCall on every later turn of the thread.
    const poisonedTurn = [
      { text: 'Partial answer.' },
      { functionCall: { name: 'search_quran', args: {} } },
    ];
    h.scripts = [
      async function* () {
        yield { type: 'text', data: 'Partial answer.' };
        yield { type: 'done', response: doneResponse('Partial answer.', [], 'STOP', poisonedTurn) };
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
