import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Inkling final fallback rung + terminal-error rescue + forced-primary mode —
 * issues #74/#79.
 *
 * The empty-final retry ladder (#60/#66/#70, restructured by #79): after ONE
 * same-model retry, escalation goes straight to thinkingmachines/Inkling —
 * entirely separate, non-Vertex infrastructure — using the SAME facilitator
 * system prompt. The #70 second-Vertex-pool (fallbackModel) rung is GONE.
 * When TINKER_API_KEY is unset, the ladder is the single same-model retry.
 * Engagement emits a no-PII Sentry breadcrumb.
 *
 * NEW in #79: when a Gemini call fails terminally (hang cut, dual-pool 429
 * exhaustion, Vertex HTML ApiError) with no text delivered and ≥20s of
 * gathering budget left, ONE sticky Inkling rescue attempt runs before the
 * error surfaces — with a breadcrumb message DISTINCT from the ladder's.
 *
 * The #74 scope amendment adds provider:'inkling' — the leaderboard adapter's
 * forced-primary mode where EVERY call of the request runs on Inkling and
 * Gemini is never invoked (no silent fallback; benchmark integrity).
 *
 * Mock scaffolding mirrors tests/facilitator-empty-final.test.ts.
 */

type AnyEvent = { type: string; data?: unknown; response?: unknown };

const h = vi.hoisted(() => ({
  calls: [] as Array<{ message: string; options: Record<string, unknown> }>,
  scripts: [] as Array<() => AsyncGenerator<AnyEvent>>,
  inklingCalls: [] as Array<{ message: string; options: Record<string, unknown> }>,
  inklingScripts: [] as Array<() => AsyncGenerator<AnyEvent>>,
  inklingConfigured: true,
  gemini: { model: 'primary-model', fallbackModel: 'fallback-model' },
}));

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

function emptyRound(finishReason?: string): () => AsyncGenerator<AnyEvent> {
  return async function* () {
    yield { type: 'done', response: doneResponse('', [], finishReason) };
  };
}

function textRound(text: string): () => AsyncGenerator<AnyEvent> {
  return async function* () {
    if (text) yield { type: 'text', data: text };
    yield { type: 'done', response: doneResponse(text, [], 'STOP') };
  };
}

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

// A terminal client failure — the #79 rescue trigger shape (hang cut, 429 exhaustion,
// Vertex HTML ApiError all surface as a thrown error from the stream).
function errorRound(message: string): () => AsyncGenerator<AnyEvent> {
  // eslint-disable-next-line require-yield
  return async function* () {
    throw new Error(message);
  };
}

// A call that streams real (gate-opening) text and THEN fails — delivered tokens
// mean the #79 rescue must NOT re-issue the call (#42 rule).
function textThenThrowRound(text: string, message: string): () => AsyncGenerator<AnyEvent> {
  return async function* () {
    yield { type: 'text', data: text };
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
    get gemini() {
      return h.gemini;
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
  INKLING_MODEL: 'thinkingmachines/Inkling',
  isInklingConfigured: vi.fn(() => h.inklingConfigured),
  streamInkling: vi.fn((message: string, options: Record<string, unknown>) => {
    h.inklingCalls.push({ message, options });
    const script = h.inklingScripts.shift();
    if (script) return script();
    return textRound('default inkling answer')();
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

type Event = { type: string; data?: string };

async function collect(gen: AsyncGenerator<Event>): Promise<Event[]> {
  const events: Event[] = [];
  for await (const e of gen) events.push(e);
  return events;
}

function userMessage(text: string): Message {
  return { role: 'user', content: [{ type: 'text', text }] };
}

function textOf(events: Event[]): string {
  return events.filter((e) => e.type === 'text').map((e) => e.data).join('');
}

beforeEach(() => {
  vi.clearAllMocks();
  h.calls = [];
  h.scripts = [];
  h.inklingCalls = [];
  h.inklingScripts = [];
  h.inklingConfigured = true;
  h.gemini = { model: 'primary-model', fallbackModel: 'fallback-model' };
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('Inkling final fallback rung (issues #74/#79)', () => {
  it('same-model retry also empty → Inkling engages directly (no 3.1-pro rung) with the SAME system prompt and recovers', async () => {
    const Sentry = await import('@sentry/nextjs');
    // Primary and its single same-model retry both come back empty.
    h.scripts = [emptyRound('STOP'), emptyRound('STOP'), textRound('should never be reached')];
    h.inklingScripts = [textRound('Answer from Inkling.')];

    const events = await collect(runFacilitator([userMessage('q')]) as AsyncGenerator<Event>);
    const types = events.map((e) => e.type);

    expect(h.calls).toHaveLength(2); // attempt + same-model retry — NO fallback-pool call (#79)
    expect(h.calls[0].options.model).toBeUndefined();
    expect(h.calls[1].options.model).toBeUndefined();
    expect(h.inklingCalls).toHaveLength(1);
    // Load-bearing (#74): the fallback call reuses the same tool-budget prompt.
    expect(h.inklingCalls[0].options.systemPrompt).toBe('BASE_PROMPT');
    expect(types).toContain('done');
    expect(types).not.toContain('error');
    expect(textOf(events)).toBe('Answer from Inkling.');
    // Engagement breadcrumb, no PII (counters + finishReason only).
    expect(Sentry.addBreadcrumb).toHaveBeenCalledWith(
      expect.objectContaining({
        category: 'inkling',
        message: expect.stringContaining('ladder escalated'),
        data: expect.objectContaining({ finishReason: 'STOP', emptyFinalRetries: 2 }),
      })
    );
    // The retry telemetry names Inkling as the next model.
    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      'facilitator empty final completion (retrying)',
      expect.objectContaining({
        extra: expect.objectContaining({ nextModel: 'thinkingmachines/Inkling' }),
      })
    );
  });

  it('TINKER_API_KEY unset → ladder is the single same-model retry, then explicit error', async () => {
    const Sentry = await import('@sentry/nextjs');
    h.inklingConfigured = false;
    h.scripts = [emptyRound('STOP'), emptyRound('STOP'), textRound('should never be reached')];
    h.inklingScripts = [textRound('should never be reached')];

    const events = await collect(runFacilitator([userMessage('q')]) as AsyncGenerator<Event>);
    const types = events.map((e) => e.type);

    expect(h.calls).toHaveLength(2);
    expect(h.inklingCalls).toHaveLength(0);
    expect(types).toContain('error');
    expect(types).not.toContain('done');
    expect(Sentry.addBreadcrumb).not.toHaveBeenCalled();
  });

  it('Inkling also returns an empty final → explicit error, strictly bounded', async () => {
    h.scripts = [emptyRound('STOP'), emptyRound('STOP')];
    h.inklingScripts = [emptyRound('STOP'), textRound('should never be reached')];

    const events = await collect(runFacilitator([userMessage('q')]) as AsyncGenerator<Event>);
    const types = events.map((e) => e.type);

    expect(h.calls).toHaveLength(2);
    expect(h.inklingCalls).toHaveLength(1); // no second Inkling attempt
    expect(types).toContain('error');
    expect(types).not.toContain('done');
    expect(events.find((e) => e.type === 'error')?.data).toMatch(/empty answer/i);
  });

  it('fallbackModel config (distinct or not) is irrelevant to the ladder (#79)', async () => {
    h.gemini = { model: 'primary-model', fallbackModel: 'primary-model' };
    h.scripts = [emptyRound('STOP'), emptyRound('STOP')];
    h.inklingScripts = [textRound('Recovered on Inkling.')];

    const events = await collect(runFacilitator([userMessage('q')]) as AsyncGenerator<Event>);
    const types = events.map((e) => e.type);

    expect(h.calls).toHaveLength(2); // attempt + single same-model retry
    expect(h.inklingCalls).toHaveLength(1);
    expect(types).toContain('done');
    expect(textOf(events)).toBe('Recovered on Inkling.');
  });

  it('rung is sticky: after engagement the tool loop continues on Inkling, never back to Gemini', async () => {
    h.scripts = [emptyRound('STOP'), emptyRound('STOP')];
    h.inklingScripts = [toolRound(['search_quran']), textRound('Final from Inkling.')];

    const events = await collect(runFacilitator([userMessage('q')]) as AsyncGenerator<Event>);
    const types = events.map((e) => e.type);

    expect(h.calls).toHaveLength(2); // Gemini never called again after escalation
    expect(h.inklingCalls).toHaveLength(2); // tool round + continuation, both on Inkling
    // The post-tool continuation carries the #73 directive, not an empty message.
    expect(h.inklingCalls[1].message).toBe('CONTINUATION_DIRECTIVE');
    expect(types).toContain('tool_result');
    expect(types).toContain('done');
    expect(textOf(events)).toBe('Final from Inkling.');
  });

  it('SAFETY still fails immediately — the Inkling rung does not widen retryable reasons', async () => {
    h.scripts = [emptyRound('SAFETY')];

    const events = await collect(runFacilitator([userMessage('q')]) as AsyncGenerator<Event>);
    const types = events.map((e) => e.type);

    expect(h.calls).toHaveLength(1);
    expect(h.inklingCalls).toHaveLength(0);
    expect(types).toContain('error');
    expect(types).not.toContain('done');
  });

  it('healthy Gemini answer → Inkling never involved (no primary-path change)', async () => {
    h.scripts = [textRound('Normal Gemini answer.')];

    const events = await collect(runFacilitator([userMessage('q')]) as AsyncGenerator<Event>);

    expect(h.calls).toHaveLength(1);
    expect(h.inklingCalls).toHaveLength(0);
    expect(textOf(events)).toBe('Normal Gemini answer.');
  });
});

describe('Inkling rescue on terminal Gemini errors (issue #79)', () => {
  it('terminal Gemini error with budget left → one sticky Inkling rescue, answer delivered', async () => {
    const Sentry = await import('@sentry/nextjs');
    h.scripts = [errorRound('ApiError: 429 dual-pool exhausted')];
    h.inklingScripts = [toolRound(['search_quran']), textRound('Rescued answer.')];

    const events = await collect(runFacilitator([userMessage('q')]) as AsyncGenerator<Event>);
    const types = events.map((e) => e.type);

    expect(h.calls).toHaveLength(1); // Gemini is never re-asked after the rescue (sticky)
    expect(h.inklingCalls).toHaveLength(2); // rescue call + post-tool continuation
    expect(h.inklingCalls[0].options.systemPrompt).toBe('BASE_PROMPT');
    expect(types).toContain('tool_result');
    expect(types).toContain('done');
    expect(types).not.toContain('error');
    expect(textOf(events)).toBe('Rescued answer.');
    // Rescue breadcrumb: category 'inkling' but a message DISTINCT from the ladder's,
    // so error-rescues and ladder-engagements are separable in Sentry. No query text.
    expect(Sentry.addBreadcrumb).toHaveBeenCalledWith(
      expect.objectContaining({
        category: 'inkling',
        message: expect.stringContaining('rescued'),
        data: expect.objectContaining({ error: expect.stringContaining('429') }),
      })
    );
    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      'facilitator terminal Gemini error rescued on Inkling',
      expect.objectContaining({ level: 'warning' })
    );
  });

  it('budget nearly exhausted (<20s to the soft deadline) → rescue skipped, error surfaces', async () => {
    // 300ms budget / 150ms reserve → the soft window is far below the 20s rescue floor.
    h.scripts = [errorRound('genuine LLM failure')];
    h.inklingScripts = [textRound('should never be reached')];

    const events = await collect(
      runFacilitator([userMessage('q')], undefined, { budgetMs: 300, reserveMs: 150 }) as AsyncGenerator<Event>
    );
    const types = events.map((e) => e.type);

    expect(h.calls).toHaveLength(1);
    expect(h.inklingCalls).toHaveLength(0);
    expect(types).toContain('error');
    expect(types).not.toContain('done');
    expect(events.find((e) => e.type === 'error')?.data).toBe('genuine LLM failure');
  });

  it('TINKER_API_KEY unset → rescue skipped, error surfaces as before', async () => {
    h.inklingConfigured = false;
    h.scripts = [errorRound('Vertex returned HTML instead of JSON')];
    h.inklingScripts = [textRound('should never be reached')];

    const events = await collect(runFacilitator([userMessage('q')]) as AsyncGenerator<Event>);
    const types = events.map((e) => e.type);

    expect(h.calls).toHaveLength(1);
    expect(h.inklingCalls).toHaveLength(0);
    expect(types).toContain('error');
    expect(types).not.toContain('done');
  });

  it('visible text already delivered by the failed call → no rescue (#42: never duplicate delivered tokens)', async () => {
    h.scripts = [textThenThrowRound('This partial answer opened the gate ', 'mid-stream cut')];
    h.inklingScripts = [textRound('should never be reached')];

    const events = await collect(runFacilitator([userMessage('q')]) as AsyncGenerator<Event>);
    const types = events.map((e) => e.type);

    expect(h.calls).toHaveLength(1);
    expect(h.inklingCalls).toHaveLength(0);
    expect(types).toContain('error');
    expect(types).not.toContain('done');
  });

  it('rescue is bounded to ONE attempt: if Inkling then fails, the error surfaces loudly', async () => {
    h.scripts = [errorRound('Gemini stream exceeded 60s overall deadline')];
    h.inklingScripts = [errorRound('[inkling] HTTP 503: upstream unavailable')];

    const events = await collect(runFacilitator([userMessage('q')]) as AsyncGenerator<Event>);
    const types = events.map((e) => e.type);

    expect(h.calls).toHaveLength(1); // never back to Gemini
    expect(h.inklingCalls).toHaveLength(1); // and no second rescue
    expect(types).toContain('error');
    expect(types).not.toContain('done');
    expect(events.find((e) => e.type === 'error')?.data).toMatch(/inkling/i);
  });

  it('rescue engages mid-request too: a continuation failure after healthy tool rounds', async () => {
    h.scripts = [toolRound(['search_quran']), errorRound('ApiError: 429 exhausted')];
    h.inklingScripts = [textRound('Rescued continuation.')];

    const events = await collect(runFacilitator([userMessage('q')]) as AsyncGenerator<Event>);
    const types = events.map((e) => e.type);

    expect(h.calls).toHaveLength(2); // tool round + failing continuation
    expect(h.inklingCalls).toHaveLength(1);
    // The rescued continuation re-issues the #73 directive, not an empty message.
    expect(h.inklingCalls[0].message).toBe('CONTINUATION_DIRECTIVE');
    expect(types).toContain('tool_result');
    expect(types).toContain('done');
    expect(types).not.toContain('error');
    expect(textOf(events)).toBe('Rescued continuation.');
  });
});

describe('forced Inkling primary — provider option (issue #74 amendment)', () => {
  it('provider inkling: every call including the tool loop runs on Inkling, Gemini never called', async () => {
    h.inklingScripts = [toolRound(['search_quran']), textRound('Inkling-primary answer.')];

    const events = await collect(
      runFacilitator([userMessage('q')], undefined, { provider: 'inkling' }) as AsyncGenerator<Event>
    );
    const types = events.map((e) => e.type);

    expect(h.calls).toHaveLength(0); // no silent Gemini anywhere
    expect(h.inklingCalls).toHaveLength(2);
    expect(h.inklingCalls[0].options.systemPrompt).toBe('BASE_PROMPT');
    // The post-tool continuation carries the #73 directive, not an empty message.
    expect(h.inklingCalls[1].message).toBe('CONTINUATION_DIRECTIVE');
    expect(types).toContain('tool_result');
    expect(types).toContain('done');
    expect(textOf(events)).toBe('Inkling-primary answer.');
  });

  it('provider inkling: empty finals retry on Inkling only — never a Gemini fallback', async () => {
    h.inklingScripts = [emptyRound('STOP'), emptyRound('STOP'), emptyRound('STOP'), emptyRound('STOP')];

    const events = await collect(
      runFacilitator([userMessage('q')], undefined, { provider: 'inkling' }) as AsyncGenerator<Event>
    );
    const types = events.map((e) => e.type);

    expect(h.calls).toHaveLength(0);
    // Bounded: initial + retries, all on Inkling, then an explicit error.
    expect(h.inklingCalls.length).toBeGreaterThanOrEqual(2);
    expect(h.inklingCalls.length).toBeLessThanOrEqual(4);
    expect(types).toContain('error');
    expect(types).not.toContain('done');
  });

  it('provider inkling: an Inkling error surfaces loudly as an error event', async () => {
    h.inklingScripts = [
      // eslint-disable-next-line require-yield
      async function* (): AsyncGenerator<AnyEvent> {
        throw new Error('[inkling] HTTP 503: upstream unavailable');
      },
    ];

    const events = await collect(
      runFacilitator([userMessage('q')], undefined, { provider: 'inkling' }) as AsyncGenerator<Event>
    );
    const types = events.map((e) => e.type);

    expect(h.calls).toHaveLength(0);
    expect(types).toContain('error');
    expect(types).not.toContain('done');
    expect(events.find((e) => e.type === 'error')?.data).toMatch(/inkling/i);
  });
});
