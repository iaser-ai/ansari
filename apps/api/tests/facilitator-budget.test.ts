import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Overall request-time budget — Phase 2 (Spec 49): the wall-clock backstop (T2) and the
 * graceful tools-disabled synthesis pass.
 *
 * We stub `streamGemini` (per-call scripts + captured args) and the tool map so we can drive
 * the budget deterministically via a small per-call budget override plus short real delays in
 * the tool `run`. The real `runFacilitator` loop is exercised end to end.
 */

type AnyEvent = { type: string; data?: unknown; response?: unknown };

const h = vi.hoisted(() => ({
  calls: [] as Array<{ message: string; options: Record<string, unknown> }>,
  scripts: [] as Array<(options?: Record<string, unknown>) => AsyncGenerator<AnyEvent>>,
  toolDelayMs: 0,
}));

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function doneResponse(text: string, toolCalls: Array<{ name: string; args: unknown }> = []) {
  return {
    text,
    toolCalls,
    rawPayload: { role: 'model', parts: text ? [{ text }] : [] },
    allParts: text ? [{ text }] : [],
    hasThinking: false,
    usage: { promptTokenCount: 1, candidatesTokenCount: 1, thoughtsTokenCount: 0, totalTokenCount: 2 },
  };
}

// A round where the model requests one or more tools.
function toolRound(names: string[]): () => AsyncGenerator<AnyEvent> {
  return async function* () {
    for (const name of names) {
      yield { type: 'tool_call', data: { name, args: { query: 'q' } } };
    }
    yield { type: 'done', response: doneResponse('', names.map((name) => ({ name, args: { query: 'q' } }))) };
  };
}

// A round that streams a final text answer (no tools).
function textRound(text: string): () => AsyncGenerator<AnyEvent> {
  return async function* () {
    if (text) yield { type: 'text', data: text };
    yield { type: 'done', response: doneResponse(text) };
  };
}

// A faithful streamGemini stand-in that self-bounds on the timeoutMs runFacilitator passes,
// then throws — exactly as the real client does when a call is cut at its deadline. Lets us
// assert the terminal-before-budget invariant at the runFacilitator level.
function hangHonoringTimeout(): (options?: Record<string, unknown>) => AsyncGenerator<AnyEvent> {
  return async function* (options?: Record<string, unknown>) {
    const ms = typeof options?.timeoutMs === 'number' ? (options.timeoutMs as number) : 60_000;
    await sleep(Math.max(0, ms));
    throw new Error(`Gemini stream exceeded ${Math.round(ms / 1000)}s overall deadline`);
    // eslint-disable-next-line no-unreachable
    yield { type: 'done', response: doneResponse('') };
  };
}

vi.mock('@sentry/nextjs', () => ({
  captureMessage: vi.fn(),
  captureException: vi.fn(),
}));

vi.mock('@/lib/ai/gemini-client', () => ({
  streamGemini: vi.fn((message: string, options: Record<string, unknown>) => {
    h.calls.push({ message, options });
    const script = h.scripts.shift();
    if (script) return script(options);
    return textRound('default answer')();
  }),
}));

// Inkling unavailable here: these tests pin the Gemini-only budget behavior; the #79
// error rescue (which probes isInklingConfigured on pre-deadline failures) stays off.
vi.mock('@/lib/ai/inkling-client', () => ({
  isInklingConfigured: () => false,
  streamInkling: vi.fn(() => {
    throw new Error('streamInkling must not be called in these tests');
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
        if (h.toolDelayMs) await sleep(h.toolDelayMs);
        return {
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
        };
      },
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

function functionResponseCount(history: unknown): number {
  if (!Array.isArray(history)) return 0;
  let count = 0;
  for (const content of history) {
    const parts = (content as { parts?: unknown[] }).parts;
    if (Array.isArray(parts)) {
      for (const p of parts) if ((p as { functionResponse?: unknown }).functionResponse) count++;
    }
  }
  return count;
}

beforeEach(() => {
  h.calls = [];
  h.scripts = [];
  h.toolDelayMs = 0;
  vi.clearAllMocks();
});

describe('runFacilitator request-time budget — Phase 2 (Spec 49)', () => {
  it('happy path under budget: normal done, no synthesis, no budget observability', async () => {
    const Sentry = await import('@sentry/nextjs');
    h.scripts = [textRound('Direct answer.')];

    const events = await collect(runFacilitator([userMessage('q')]) as AsyncGenerator<Event>);
    const types = events.map((e) => e.type);

    expect(types).toContain('done');
    expect(types).not.toContain('error');
    expect(events.filter((e) => e.type === 'text').map((e) => e.data).join('')).toBe('Direct answer.');
    expect(h.calls).toHaveLength(1); // only the one gathering call; no synthesis pass
    expect(Sentry.captureMessage).not.toHaveBeenCalled(); // no short-circuit
  });

  it('T2 top-of-loop: after the soft deadline, stops gathering and runs ONE tools-disabled synthesis', async () => {
    const Sentry = await import('@sentry/nextjs');
    h.toolDelayMs = 200; // iteration 1 tool run pushes the clock past the soft deadline
    h.scripts = [toolRound(['search_quran']), textRound('Synthesized answer.')];

    const events = await collect(
      runFacilitator([userMessage('q')], undefined, { budgetMs: 300, reserveMs: 150 }) as AsyncGenerator<Event>,
    );
    const types = events.map((e) => e.type);

    expect(types).toContain('done');
    expect(types).not.toContain('error');
    expect(events.filter((e) => e.type === 'text').map((e) => e.data).join('')).toBe('Synthesized answer.');

    // Exactly two Gemini calls: the tool-gathering round + one synthesis pass.
    expect(h.calls).toHaveLength(2);
    // Synthesis call: tools omitted, directive in systemPrompt, empty message.
    expect(h.calls[1].options.tools).toBeUndefined();
    expect(String(h.calls[1].options.systemPrompt)).toMatch(/run out of time/i);
    expect(h.calls[1].message).toBe('');

    // Tool-gathering call was bounded to (a positive slice of) the budget; synthesis bounded too.
    expect(typeof h.calls[0].options.timeoutMs).toBe('number');
    expect(h.calls[0].options.timeoutMs as number).toBeGreaterThan(0);
    expect(h.calls[0].options.timeoutMs as number).toBeLessThanOrEqual(300);
    expect(typeof h.calls[1].options.timeoutMs).toBe('number');
    expect(h.calls[1].options.timeoutMs as number).toBeLessThanOrEqual(300);

    // Timing-only, NON-PII observability.
    expect(Sentry.captureMessage).toHaveBeenCalledTimes(1);
    const [msg, opts] = (Sentry.captureMessage as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(String(msg)).toMatch(/short-circuit/i);
    expect((opts as { level?: string }).level).toBe('warning');
    const extra = (opts as { extra?: Record<string, unknown> }).extra ?? {};
    expect(Object.keys(extra).sort()).toEqual([
      'degradedCount',
      'elapsedMs',
      'iterations',
      'terminalPath',
      'toolCallCount',
      'trigger',
    ]);
    expect(extra.trigger).toBe('T2');
    expect(extra.terminalPath).toBe('done');
    // No token counts, no query text.
    const serialized = JSON.stringify(extra);
    expect(serialized.toLowerCase()).not.toContain('token');
    expect(serialized).not.toContain('q'); // the query text 'q' must not leak
  });

  it('mid-loop short-circuit: skipped tools get a synthetic functionResponse + tool_result, history stays valid', async () => {
    h.toolDelayMs = 200; // the first tool run crosses the soft deadline mid-fan-out
    h.scripts = [toolRound(['search_quran', 'search_hadith']), textRound('Synth.')];

    const events = await collect(
      runFacilitator([userMessage('q')], undefined, { budgetMs: 300, reserveMs: 150 }) as AsyncGenerator<Event>,
    );

    const toolResults = events.filter((e) => e.type === 'tool_result');
    expect(toolResults).toHaveLength(2); // one executed, one skipped
    const counts = toolResults.map((e) => JSON.parse(e.data as string).resultCount).sort();
    expect(counts).toEqual([0, 1]); // skipped → 0, executed → 1

    expect(events.map((e) => e.type)).toContain('done');
    // The synthesis call's history has a matching functionResponse for BOTH requested calls.
    expect(functionResponseCount(h.calls[1].options.history)).toBe(2);
  });

  it('synthesis produces no usable text → a single clean error (no hang, no done)', async () => {
    h.toolDelayMs = 200;
    h.scripts = [toolRound(['search_quran']), textRound('')]; // synthesis yields empty

    const events = await collect(
      runFacilitator([userMessage('q')], undefined, { budgetMs: 300, reserveMs: 150 }) as AsyncGenerator<Event>,
    );
    const types = events.map((e) => e.type);

    expect(types).toContain('error');
    expect(types).not.toContain('done');
    const err = events.find((e) => e.type === 'error');
    expect(err?.data).toMatch(/taking longer than expected/i);
  });

  it('tool-gathering call cut after the soft deadline → falls back to synthesis (not an error)', async () => {
    const Sentry = await import('@sentry/nextjs');
    h.scripts = [
      // First call throws AFTER crossing the soft deadline (simulates a deadline cut).
      async function* () {
        await sleep(200);
        throw new Error('deadline cut');
        // eslint-disable-next-line no-unreachable
        yield { type: 'done', response: doneResponse('') };
      },
      textRound('Recovered synthesis.'),
    ];

    const events = await collect(
      runFacilitator([userMessage('q')], undefined, { budgetMs: 300, reserveMs: 150 }) as AsyncGenerator<Event>,
    );
    const types = events.map((e) => e.type);

    expect(types).toContain('done');
    expect(types).not.toContain('error');
    expect(events.filter((e) => e.type === 'text').map((e) => e.data).join('')).toBe('Recovered synthesis.');
    expect(Sentry.captureMessage).toHaveBeenCalledTimes(1); // short-circuit, not a raw error
  });

  it('genuine early failure (before the soft deadline) still surfaces an error event, not synthesis', async () => {
    const Sentry = await import('@sentry/nextjs');
    h.scripts = [
      async function* () {
        throw new Error('genuine LLM failure');
        // eslint-disable-next-line no-unreachable
        yield { type: 'done', response: doneResponse('') };
      },
    ];

    // Large budget → soft deadline far away → the immediate throw is a genuine error.
    const events = await collect(
      runFacilitator([userMessage('q')], undefined, { budgetMs: 120_000, reserveMs: 25_000 }) as AsyncGenerator<Event>,
    );
    const types = events.map((e) => e.type);

    expect(types).toContain('error');
    expect(types).not.toContain('done');
    expect(events.find((e) => e.type === 'error')?.data).toBe('genuine LLM failure');
    expect(h.calls).toHaveLength(1); // no synthesis pass was attempted
    expect(Sentry.captureMessage).not.toHaveBeenCalled(); // not a budget short-circuit
    expect(Sentry.captureException).toHaveBeenCalled(); // genuine error path
  });

  it('terminal-before-budget: a slow synthesis call is cut at its deadline → clean error within budget', async () => {
    const Sentry = await import('@sentry/nextjs');
    h.toolDelayMs = 200; // push past the soft deadline during iteration 1
    // Synthesis call self-bounds on the timeoutMs runFacilitator passes (faithful stand-in),
    // then throws — exercising the exception path and the whole-request timing bound.
    h.scripts = [toolRound(['search_quran']), hangHonoringTimeout()];

    const start = Date.now();
    const events = await collect(
      runFacilitator([userMessage('q')], undefined, { budgetMs: 300, reserveMs: 150 }) as AsyncGenerator<Event>,
    );
    const elapsed = Date.now() - start;
    const types = events.map((e) => e.type);

    expect(types).toContain('error');
    expect(types).not.toContain('done');
    expect(events.find((e) => e.type === 'error')?.data).toMatch(/taking longer than expected/i);
    // The terminal event lands within the budget window (gathering ~soft deadline + synthesis
    // bounded to the reserve), not Gemini's 60s/3-min defaults.
    expect(elapsed).toBeLessThan(300 + 300);
    expect(Sentry.captureMessage).toHaveBeenCalledTimes(1); // short-circuit logged, terminalPath 'error'
    const extra = (Sentry.captureMessage as ReturnType<typeof vi.fn>).mock.calls[0][1].extra;
    expect(extra.terminalPath).toBe('error');
  });
});
