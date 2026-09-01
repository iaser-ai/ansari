import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Per-turn model provenance on the facilitator's terminal events (issue #99).
 *
 * Every terminal event (`done` AND `error`) that a model call produced carries
 * `provenance: {provider, modelId}` describing the call that produced — or
 * failed to produce — the final turn:
 *  - gemini-primary done → {gemini, config.gemini.model};
 *  - forced provider 'inkling' → {inkling, config.inkling.model};
 *  - a #79-rescued turn reports inkling even though the primary was gemini —
 *    this is what makes "rescued on Inkling" queryable, not just a Sentry event;
 *  - the #74 empty-final ladder's Inkling rung likewise;
 *  - a terminal error reports the provider whose call failed;
 *  - the T2 synthesis path reports the model that wrote the synthesis;
 *  - the only provenance-free terminal event is one no provider ever served
 *    (no user message) — persist sites map that absence to NULL.
 *
 * Mock scaffolding mirrors tests/facilitator-inkling-rung.test.ts.
 *
 * pglite DDL drift guard (#70 lesson) for the new columns: a fresh
 * `grep -rn "tool_calls jsonb" apps/api/tests/` at implementation time hit
 * exactly: attribution-schema, executor-threads-feedback, feedback-idor,
 * feedback-upsert, rawpayload-persistence, route-persistence-rollback,
 * thread-get-contract, toolcalls-persistence, toolcalls-routes — every
 * `CREATE TABLE messages` (9) and `CREATE TABLE tool_call_orphans` (3) among
 * them gained `model_provider text, model_id text`. Drizzle lists every mapped
 * column in INSERT, so a stale DDL fails loudly, not quietly.
 */

type AnyEvent = { type: string; data?: unknown; response?: unknown };

const h = vi.hoisted(() => ({
  scripts: [] as Array<() => AsyncGenerator<AnyEvent>>,
  inklingScripts: [] as Array<() => AsyncGenerator<AnyEvent>>,
  inklingConfigured: true,
  gemini: { model: 'gemini-3.7-flash', fallbackModel: 'gemini-fallback' },
  inkling: { model: 'tinker://sft-dpo-bf16', timeoutMs: 180000 },
}));

function doneResponse(text: string, finishReason?: string) {
  return {
    text,
    toolCalls: [],
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
    yield { type: 'done', response: doneResponse(text, 'STOP') };
  };
}

function emptyRound(finishReason?: string): () => AsyncGenerator<AnyEvent> {
  return async function* () {
    yield { type: 'done', response: doneResponse('', finishReason) };
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
      return 'gemini' as const;
    },
    get gemini() {
      return h.gemini;
    },
    get inkling() {
      return h.inkling;
    },
  },
}));

vi.mock('@/lib/ai/gemini-client', () => ({
  streamGemini: vi.fn(() => {
    const script = h.scripts.shift();
    if (script) return script();
    return textRound('default gemini answer')();
  }),
}));

vi.mock('@/lib/ai/inkling-client', () => ({
  isInklingConfigured: vi.fn(() => h.inklingConfigured),
  streamInkling: vi.fn(() => {
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
  createToolMap: () => new Map(),
}));

// Import AFTER mocks.
import { runFacilitator, type FacilitatorStreamEvent, type Message } from '../lib/facilitator/agent';

async function collect(gen: AsyncGenerator<FacilitatorStreamEvent>): Promise<FacilitatorStreamEvent[]> {
  const events: FacilitatorStreamEvent[] = [];
  for await (const e of gen) events.push(e);
  return events;
}

function userMessage(text: string): Message {
  return { role: 'user', content: [{ type: 'text', text }] };
}

function terminal(events: FacilitatorStreamEvent[]): FacilitatorStreamEvent {
  const last = events.at(-1);
  expect(last).toBeDefined();
  return last!;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.scripts = [];
  h.inklingScripts = [];
  h.inklingConfigured = true;
  h.gemini = { model: 'gemini-3.7-flash', fallbackModel: 'gemini-fallback' };
  h.inkling = { model: 'tinker://sft-dpo-bf16', timeoutMs: 180000 };
});

describe('done-event provenance', () => {
  it('a gemini-primary turn reports {gemini, config.gemini.model}', async () => {
    h.scripts = [textRound('An answer.')];

    const last = terminal(await collect(runFacilitator([userMessage('q')])));
    expect(last.type).toBe('done');
    expect(last.provenance).toEqual({ provider: 'gemini', modelId: 'gemini-3.7-flash' });
  });

  it("forced provider 'inkling' reports {inkling, config.inkling.model}", async () => {
    h.inklingScripts = [textRound('An answer.')];

    const last = terminal(
      await collect(runFacilitator([userMessage('q')], undefined, { provider: 'inkling' }))
    );
    expect(last.type).toBe('done');
    expect(last.provenance).toEqual({ provider: 'inkling', modelId: 'tinker://sft-dpo-bf16' });
  });

  it('a #79-RESCUED turn reports inkling even though the primary was gemini', async () => {
    h.scripts = [errorRound('Vertex HTML ApiError')];
    h.inklingScripts = [textRound('Rescued answer.')];

    const events = await collect(runFacilitator([userMessage('q')]));
    const last = terminal(events);
    expect(last.type).toBe('done');
    expect(last.provenance).toEqual({ provider: 'inkling', modelId: 'tinker://sft-dpo-bf16' });
    // The rescue actually served the visible answer.
    expect(events.filter((e) => e.type === 'text').map((e) => e.data).join('')).toBe('Rescued answer.');
  });

  it("the #74 empty-final ladder's Inkling rung reports inkling", async () => {
    h.scripts = [emptyRound('STOP'), emptyRound('STOP')];
    h.inklingScripts = [textRound('Ladder answer.')];

    const last = terminal(await collect(runFacilitator([userMessage('q')])));
    expect(last.type).toBe('done');
    expect(last.provenance).toEqual({ provider: 'inkling', modelId: 'tinker://sft-dpo-bf16' });
  });
});

describe('error-event provenance', () => {
  it('a terminal gemini error (rescue unavailable) reports the gemini provider that failed', async () => {
    h.inklingConfigured = false;
    h.scripts = [errorRound('dual-pool 429 exhaustion')];

    const last = terminal(await collect(runFacilitator([userMessage('q')])));
    expect(last.type).toBe('error');
    expect(last.provenance).toEqual({ provider: 'gemini', modelId: 'gemini-3.7-flash' });
  });

  it('an inkling-primary failure reports inkling', async () => {
    h.inklingScripts = [errorRound('HTTP 500')];

    const last = terminal(
      await collect(runFacilitator([userMessage('q')], undefined, { provider: 'inkling' }))
    );
    expect(last.type).toBe('error');
    expect(last.provenance).toEqual({ provider: 'inkling', modelId: 'tinker://sft-dpo-bf16' });
  });

  it('the no-user-message error — no provider ever engaged — carries NO provenance', async () => {
    const last = terminal(await collect(runFacilitator([])));
    expect(last.type).toBe('error');
    expect(last.provenance).toBeUndefined();
  });
});

describe('synthesis provenance', () => {
  // budgetMs === reserveMs puts the soft deadline at t=0: the loop's first check
  // short-circuits straight to the T2 synthesis pass (Spec 49 machinery).
  const SYNTH_AT_T0 = { budgetMs: 5000, reserveMs: 5000 };

  it('a gemini synthesis reports the gemini model that wrote it', async () => {
    h.scripts = [textRound('Synthesized from context.')];

    const last = terminal(
      await collect(runFacilitator([userMessage('q')], undefined, SYNTH_AT_T0))
    );
    expect(last.type).toBe('done');
    expect(last.provenance).toEqual({ provider: 'gemini', modelId: 'gemini-3.7-flash' });
  });

  it('an inkling-primary synthesis reports inkling', async () => {
    h.inklingScripts = [textRound('Synthesized from context.')];

    const last = terminal(
      await collect(
        runFacilitator([userMessage('q')], undefined, { ...SYNTH_AT_T0, provider: 'inkling' })
      )
    );
    expect(last.type).toBe('done');
    expect(last.provenance).toEqual({ provider: 'inkling', modelId: 'tinker://sft-dpo-bf16' });
  });

  it('a failed synthesis (error terminal) still carries provenance', async () => {
    h.scripts = [errorRound('synthesis cut')];

    const last = terminal(
      await collect(runFacilitator([userMessage('q')], undefined, SYNTH_AT_T0))
    );
    expect(last.type).toBe('error');
    expect(last.provenance).toEqual({ provider: 'gemini', modelId: 'gemini-3.7-flash' });
  });
});
