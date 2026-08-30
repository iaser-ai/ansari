import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Post-tool-round continuation directive — issue #73.
 *
 * The facilitator loop used to continue after a tool round by sending an
 * EMPTY-string user message (`streamGemini('')` → `sendMessageStream({message: ''})`).
 * Under load, gemini-3.5-flash sometimes answers that request shape with a
 * thoughts-only STOP-empty completion — the dominant source of
 * "[facilitator] empty final completion — retrying" events (a 12h prod sample
 * showed 41/41 at iterations >= 2, never on a first call).
 *
 * The fix replaces the empty continuation with the explicit
 * TOOL_CONTINUATION_DIRECTIVE. These tests lock the request shape (the
 * continuation message is the directive, not '') and the leak-safety
 * invariants from the issue: the directive must never reach the visible
 * stream, persisted messages, or the history sent on later calls.
 *
 * Mock scaffolding mirrors tests/facilitator-empty-final.test.ts, EXCEPT that
 * '@/lib/ai/prompts/facilitator' is deliberately NOT mocked: the real module
 * must supply the directive so these assertions exercise the production value.
 */

type AnyEvent = { type: string; data?: unknown; response?: unknown };

const h = vi.hoisted(() => ({
  calls: [] as Array<{ message: string; options: Record<string, unknown> }>,
  scripts: [] as Array<() => AsyncGenerator<AnyEvent>>,
  gemini: { model: 'primary-model', fallbackModel: 'fallback-model' },
}));

// The exact production value, restated literally so a regression that empties or
// mangles the constant fails here even though the constant itself is imported by
// the code under test.
const DIRECTIVE = "Answer the user's question using the tool results above.";

function doneResponse(
  text: string,
  toolCalls: Array<{ name: string; args: unknown }> = [],
  finishReason?: string
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

// A round that streams a final text answer (no tools).
function textRound(text: string): () => AsyncGenerator<AnyEvent> {
  return async function* () {
    if (text) yield { type: 'text', data: text };
    yield { type: 'done', response: doneResponse(text, [], 'STOP') };
  };
}

// A round where the model requests a tool.
function toolRound(names: string[]): () => AsyncGenerator<AnyEvent> {
  return async function* () {
    for (const name of names) {
      yield { type: 'tool_call', data: { name, args: { query: 'q' } } };
    }
    yield {
      type: 'done',
      response: doneResponse('', names.map((name) => ({ name, args: { query: 'q' } })), 'STOP'),
    };
  };
}

// A round that completes with finishReason STOP, no text, no tool calls — the
// empty-final shape whose bounded retry (#70) must also re-send the directive.
function emptyRound(): () => AsyncGenerator<AnyEvent> {
  return async function* () {
    yield { type: 'done', response: doneResponse('', [], 'STOP') };
  };
}

vi.mock('@sentry/nextjs', () => ({
  captureMessage: vi.fn(),
  captureException: vi.fn(),
}));

vi.mock('@/lib/config', () => ({
  config: {
    get gemini() {
      return h.gemini;
    },
    // Inkling unset: these tests pin the Gemini-only continuation/retry
    // behavior; the #74 rung is exercised in tests/facilitator-inkling-rung.test.ts.
    inkling: { apiKey: undefined },
  },
}));

vi.mock('@/lib/ai/gemini-client', () => ({
  streamGemini: vi.fn((message: string, options: Record<string, unknown>) => {
    h.calls.push({ message, options });
    const script = h.scripts.shift();
    if (script) return script();
    return textRound('default answer')();
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
      ['search_quran', 'search_hadith', 'search_mawsuah', 'search_tafsir_encyclopedia'].map((n) => [n, make(n)]),
    );
  },
}));

// Import AFTER mocks.
import { runFacilitator, type Message } from '../lib/facilitator/agent';
import { TOOL_CONTINUATION_DIRECTIVE } from '../lib/ai/prompts/facilitator';

type Event = { type: string; data?: string };

async function collect(gen: AsyncGenerator<Event>): Promise<Event[]> {
  const events: Event[] = [];
  for await (const e of gen) events.push(e);
  return events;
}

function userMessage(text: string): Message {
  return { role: 'user', content: [{ type: 'text', text }] };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.calls = [];
  h.scripts = [];
  h.gemini = { model: 'primary-model', fallbackModel: 'fallback-model' };
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('post-tool-round continuation directive (issue #73)', () => {
  it('the production constant is the expected non-empty directive', () => {
    expect(TOOL_CONTINUATION_DIRECTIVE).toBe(DIRECTIVE);
  });

  it('continuation after a tool round sends the directive, never an empty message', async () => {
    h.scripts = [toolRound(['search_quran']), textRound('Sabr means patience.')];

    const events = await collect(runFacilitator([userMessage('What is sabr?')]) as AsyncGenerator<Event>);
    const types = events.map((e) => e.type);

    expect(h.calls).toHaveLength(2); // tool round + continuation
    expect(h.calls[0].message).toBe('What is sabr?'); // first call carries real user text
    expect(h.calls[1].message).toBe(DIRECTIVE); // continuation carries the directive — was ''
    expect(types).toContain('done');
    expect(types).not.toContain('error');
  });

  it('every continuation of a multi-tool-round request carries the directive', async () => {
    h.scripts = [
      toolRound(['search_quran']),
      toolRound(['search_hadith']),
      textRound('Final answer.'),
    ];

    await collect(runFacilitator([userMessage('q')]) as AsyncGenerator<Event>);

    expect(h.calls).toHaveLength(3);
    expect(h.calls[1].message).toBe(DIRECTIVE);
    expect(h.calls[2].message).toBe(DIRECTIVE);
  });

  it('the #70 bounded retry of an empty continuation also re-sends the directive', async () => {
    h.scripts = [toolRound(['search_quran']), emptyRound(), textRound('Recovered answer.')];

    const events = await collect(runFacilitator([userMessage('q')]) as AsyncGenerator<Event>);
    const types = events.map((e) => e.type);

    expect(h.calls).toHaveLength(3); // tool round + empty continuation + retry
    expect(h.calls[1].message).toBe(DIRECTIVE);
    expect(h.calls[2].message).toBe(DIRECTIVE); // retry keeps the directive, not ''
    expect(types).toContain('done');
    expect(types).not.toContain('error');
  });

  it('the directive never leaks: not in events, not in persisted messages, not in history', async () => {
    h.scripts = [
      toolRound(['search_quran']),
      toolRound(['search_hadith']),
      textRound('Final answer.'),
    ];
    const persisted: Message[] = [];

    const events = await collect(
      runFacilitator([userMessage('q')], async (m) => {
        persisted.push(m);
      }) as AsyncGenerator<Event>
    );

    // Visible stream: no yielded event payload contains the directive.
    for (const e of events) {
      expect(JSON.stringify(e.data ?? ''), `event ${e.type}`).not.toContain(DIRECTIVE);
    }

    // Persisted messages: only the assistant answer, never the directive.
    expect(persisted.length).toBeGreaterThan(0);
    expect(JSON.stringify(persisted)).not.toContain(DIRECTIVE);

    // Request history: the directive is transient per-call `message` text — it must
    // never be pushed into the history sent on any later call (no accumulation).
    for (const call of h.calls) {
      expect(JSON.stringify(call.options.history ?? []), 'history').not.toContain(DIRECTIVE);
    }
  });
});
