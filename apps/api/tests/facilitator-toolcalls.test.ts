import { describe, it, expect, vi, beforeEach } from 'vitest';
import { unavailableResult } from '../lib/tools/resilience';
import type { ToolCallRecord } from '../db/schema/messages';

/**
 * Facilitator tool-record accumulation (spec 73, Phase 2).
 *
 * runFacilitator must hand callers an ordered tool_use/tool_result array covering
 * EVERY dispatch path — executed (ok / degraded / backstop), budget-skipped (T1 /
 * T2), limit-refused, unknown-tool — on BOTH terminal event kinds (`done` and
 * `error`) and via onMessage, with #76-coherent degradation detail.
 *
 * Harness mirrors facilitator-t1.test.ts: streamGemini is scripted per call; the
 * tool map is scripted per tool. The wire-facing tool_use/tool_result stream
 * events are asserted UNCHANGED (still the lossy {name} / {tool, query,
 * resultCount}) — no new data may cross the SSE surface.
 */

type AnyEvent = { type: string; data?: unknown; response?: unknown };
type Behavior = 'ok' | 'slow_ok' | 'degrade' | 'degrade_timeout_retried' | 'degrade_http' | 'throw';

const h = vi.hoisted(() => ({
  scripts: [] as Array<() => AsyncGenerator<AnyEvent>>,
  behavior: {} as Record<string, string>,
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

// A round that completes with a finishReason but NO text and NO tool calls — the
// degenerate-final shape (issue #60) that the empty-final ladder retries then fails.
function emptyRound(finishReason: string): () => AsyncGenerator<AnyEvent> {
  return async function* () {
    yield { type: 'done', response: doneResponse('', [], finishReason) };
  };
}

function toolRound(names: string[]): () => AsyncGenerator<AnyEvent> {
  return async function* () {
    for (const name of names) {
      yield { type: 'tool_call', data: { name, args: { query: `q-${name}` } } };
    }
    yield { type: 'done', response: doneResponse('', names.map((name) => ({ name, args: { query: `q-${name}` } }))) };
  };
}

function textRound(text: string): () => AsyncGenerator<AnyEvent> {
  return async function* () {
    if (text) yield { type: 'text', data: text };
    yield { type: 'done', response: doneResponse(text) };
  };
}

function throwingRound(message: string): () => AsyncGenerator<AnyEvent> {
  return async function* () {
    throw new Error(message);
  };
}

vi.mock('@sentry/nextjs', () => ({
  captureMessage: vi.fn(),
  captureException: vi.fn(),
  addBreadcrumb: vi.fn(),
}));

vi.mock('@/lib/ai/gemini-client', () => ({
  streamGemini: vi.fn(() => {
    const script = h.scripts.shift();
    if (script) return script();
    return textRound('default answer')();
  }),
}));

// The degenerate-final ladder reads config.gemini.model lazily for its log summary;
// validated config has no env here, so stub the two fields it touches.
vi.mock('@/lib/config', () => ({
  config: { gemini: { model: 'primary-model', fallbackModel: 'fallback-model' } },
}));

// The catch-all error path consults isInklingConfigured(), which reads validated
// config; stub it so the rescue rung is simply "not configured" in this harness.
vi.mock('@/lib/ai/inkling-client', () => ({
  isInklingConfigured: () => false,
  streamInkling: vi.fn(),
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
        const b = (h.behavior[name] ?? 'ok') as Behavior;
        if (b === 'throw') throw new Error(`simulated ${name} crash`);
        if (b === 'degrade') return unavailableResult(name);
        if (b === 'degrade_timeout_retried') {
          return unavailableResult(name, { errorClass: 'timeout', attempts: 2 });
        }
        if (b === 'degrade_http') {
          return unavailableResult(name, { errorClass: 'http_5xx', attempts: 1, status: 503 });
        }
        if (b === 'slow_ok') await new Promise((r) => setTimeout(r, 60));
        return {
          content: `real result for ${name}`,
          documents: [
            {
              type: 'document',
              source: { type: 'text', media_type: 'text/plain', data: `doc-${name}` },
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

import { runFacilitator, type Message, type FacilitatorStreamEvent } from '../lib/facilitator/agent';

async function collect(gen: AsyncGenerator<FacilitatorStreamEvent>): Promise<FacilitatorStreamEvent[]> {
  const events: FacilitatorStreamEvent[] = [];
  for await (const e of gen) events.push(e);
  return events;
}

function userMessage(text: string): Message {
  return { role: 'user', content: [{ type: 'text', text }] };
}

function terminal(events: FacilitatorStreamEvent[]): FacilitatorStreamEvent {
  const t = events[events.length - 1];
  expect(['done', 'error']).toContain(t.type);
  return t;
}

type UseRecord = Extract<ToolCallRecord, { type: 'tool_use' }>;
type ResultRecord = Extract<ToolCallRecord, { type: 'tool_result' }>;

/** Split a flat record array into correlated (use, result) pairs, asserting order + ids. */
function pairs(records: ToolCallRecord[]): Array<{ use: UseRecord; result: ResultRecord }> {
  expect(records.length % 2).toBe(0);
  const out: Array<{ use: UseRecord; result: ResultRecord }> = [];
  for (let i = 0; i < records.length; i += 2) {
    const use = records[i];
    const result = records[i + 1];
    expect(use.type).toBe('tool_use');
    expect(result.type).toBe('tool_result');
    if (use.type !== 'tool_use' || result.type !== 'tool_result') throw new Error('unreachable');
    expect(result.tool_use_id).toBe(use.id);
    out.push({ use, result });
  }
  return out;
}

beforeEach(() => {
  h.scripts = [];
  h.behavior = {};
  vi.clearAllMocks();
});

describe('runFacilitator accumulates tool records (spec 73)', () => {
  it('happy path: two calls in one round → ordered use/result pairs with full Gemini-facing content', async () => {
    h.scripts = [toolRound(['search_quran', 'search_hadith']), textRound('Answer.')];

    const events = await collect(runFacilitator([userMessage('q')]));
    const done = terminal(events);
    expect(done.type).toBe('done');
    const p = pairs(done.toolCalls!);
    expect(p).toHaveLength(2);

    expect(p[0].use).toMatchObject({ name: 'search_quran', input: { query: 'q-search_quran' } });
    expect(p[1].use).toMatchObject({ name: 'search_hadith', input: { query: 'q-search_hadith' } });
    expect(p[0].use.id).not.toBe(p[1].use.id);

    // Content is the full formatToolResultForGemini output — ground truth of what the model saw.
    expect(p[0].result.content).toEqual({
      results: [{ title: 'search_quran', context: 'src', content: 'doc-search_quran' }],
      summary: 'real result for search_quran',
    });
    expect(p[0].result.status).toBe('ok');
    expect(typeof p[0].result.duration_ms).toBe('number');
    expect(p[0].result.duration_ms).toBeGreaterThanOrEqual(0);
    expect(p[0].result).not.toHaveProperty('error_class');
    expect(p[0].result).not.toHaveProperty('attempts');
    expect(p[0].result).not.toHaveProperty('skip_trigger');
  });

  it('wire-facing tool_use / tool_result events stay lossy — no record data crosses the stream', async () => {
    h.scripts = [toolRound(['search_quran']), textRound('Answer.')];

    const events = await collect(runFacilitator([userMessage('q')]));
    const use = events.find((e) => e.type === 'tool_use')!;
    const result = events.find((e) => e.type === 'tool_result')!;
    expect(JSON.parse(use.data)).toEqual({ name: 'search_quran' });
    expect(JSON.parse(result.data)).toEqual({ tool: 'search_quran', query: 'q-search_quran', resultCount: 1 });
    expect(use.toolCalls).toBeUndefined();
    expect(result.toolCalls).toBeUndefined();
  });

  it('no-tool run → toolCalls absent on done, null via onMessage', async () => {
    h.scripts = [textRound('Plain answer.')];
    const onMessage = vi.fn(async () => {});

    const events = await collect(runFacilitator([userMessage('q')], onMessage));
    const done = terminal(events);
    expect(done.type).toBe('done');
    expect(done.toolCalls).toBeUndefined();
    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage.mock.calls[0][0]).toMatchObject({ toolCalls: null });
  });

  it('onMessage receives the same records as the done event', async () => {
    h.scripts = [toolRound(['search_quran']), textRound('Answer.')];
    const onMessage = vi.fn(async () => {});

    const events = await collect(runFacilitator([userMessage('q')], onMessage));
    const done = terminal(events);
    expect(onMessage.mock.calls[0][0].toolCalls).toEqual(done.toolCalls);
    expect(done.toolCalls).toHaveLength(2);
  });

  it('multi-round loop → one flat ordered array across iterations', async () => {
    h.scripts = [toolRound(['search_quran']), toolRound(['search_hadith']), textRound('Answer.')];

    const events = await collect(runFacilitator([userMessage('q')]));
    const p = pairs(terminal(events).toolCalls!);
    expect(p.map((x) => x.use.name)).toEqual(['search_quran', 'search_hadith']);
    expect(p.every((x) => x.result.status === 'ok')).toBe(true);
  });
});

describe('degradation detail (#76 coherence)', () => {
  it('a retried-timeout degrade carries status degraded, error_class timeout, attempts 2; a sibling ok call stays bare', async () => {
    h.behavior = { search_hadith: 'degrade_timeout_retried', search_quran: 'ok' };
    h.scripts = [toolRound(['search_quran', 'search_hadith']), textRound('Answer.')];

    const p = pairs(terminal(await collect(runFacilitator([userMessage('q')]))).toolCalls!);
    expect(p[0].result.status).toBe('ok');
    expect(p[0].result).not.toHaveProperty('error_class');
    expect(p[1].result).toMatchObject({ status: 'degraded', error_class: 'timeout', attempts: 2 });
    expect(p[1].result).not.toHaveProperty('http_status');
    expect(typeof p[1].result.duration_ms).toBe('number');
  });

  it('an HTTP degrade carries http_status alongside error_class and attempts', async () => {
    h.behavior = { search_mawsuah: 'degrade_http' };
    h.scripts = [toolRound(['search_mawsuah']), textRound('Answer.')];

    const p = pairs(terminal(await collect(runFacilitator([userMessage('q')]))).toolCalls!);
    expect(p[0].result).toMatchObject({ status: 'degraded', error_class: 'http_5xx', attempts: 1, http_status: 503 });
  });

  it('a detail-less degrade is status degraded with NO detail fields (isDegraded read off ToolResult, not the payload)', async () => {
    h.behavior = { search_quran: 'degrade' };
    h.scripts = [toolRound(['search_quran']), textRound('Answer.')];

    const p = pairs(terminal(await collect(runFacilitator([userMessage('q')]))).toolCalls!);
    expect(p[0].result.status).toBe('degraded');
    expect(p[0].result).not.toHaveProperty('error_class');
    expect(p[0].result).not.toHaveProperty('attempts');
    expect(p[0].result).not.toHaveProperty('http_status');
    // The model-facing payload never carries the marker — it is sourced from ToolResult.
    expect(JSON.stringify(p[0].result.content)).not.toContain('isDegraded');
  });

  it('a throwing tool (backstop) is status degraded with error_class network and no attempts', async () => {
    h.behavior = { search_quran: 'throw' };
    h.scripts = [toolRound(['search_quran']), textRound('Answer.')];

    const p = pairs(terminal(await collect(runFacilitator([userMessage('q')]))).toolCalls!);
    expect(p[0].result).toMatchObject({ status: 'degraded', error_class: 'network' });
    expect(p[0].result).not.toHaveProperty('attempts');
    expect(typeof p[0].result.duration_ms).toBe('number');
  });
});

describe('never-executed dispatches are still recorded', () => {
  it('T1 short-circuit: calls after the degraded threshold are budget_skipped with skip_trigger T1; synthesis done carries everything', async () => {
    h.behavior = { search_quran: 'degrade', search_hadith: 'degrade', search_mawsuah: 'ok' };
    h.scripts = [
      toolRound(['search_quran', 'search_hadith', 'search_mawsuah']),
      textRound('Best-effort synthesis.'),
    ];

    const events = await collect(runFacilitator([userMessage('q')]));
    const done = terminal(events);
    expect(done.type).toBe('done');
    const p = pairs(done.toolCalls!);
    expect(p).toHaveLength(3);
    expect(p[0].result.status).toBe('degraded');
    expect(p[1].result.status).toBe('degraded');
    expect(p[2].result).toMatchObject({ status: 'budget_skipped', skip_trigger: 'T1', duration_ms: null });
    expect(p[2].use.name).toBe('search_mawsuah');
    // Skipped content is the synthetic functionResponse the model actually received.
    expect(p[2].result.content).toMatchObject({ summary: expect.stringContaining('Skipped') });
  });

  it('T2 short-circuit: a call reached after the soft deadline is budget_skipped with skip_trigger T2', async () => {
    h.behavior = { search_quran: 'slow_ok', search_hadith: 'ok' };
    h.scripts = [toolRound(['search_quran', 'search_hadith']), textRound('Best-effort synthesis.')];

    // softDeadline = +20ms; the first (slow, 60ms) tool pushes the second past it.
    const events = await collect(runFacilitator([userMessage('q')], undefined, { budgetMs: 2000, reserveMs: 1980 }));
    const done = terminal(events);
    expect(done.type).toBe('done');
    const p = pairs(done.toolCalls!);
    expect(p).toHaveLength(2);
    expect(p[0].result.status).toBe('ok');
    expect(p[1].result).toMatchObject({ status: 'budget_skipped', skip_trigger: 'T2', duration_ms: null });
  });

  it('tool-limit refusal (same tool 3x consecutively) is limit_refused with null duration', async () => {
    h.scripts = [
      toolRound(['search_quran']),
      toolRound(['search_quran']),
      toolRound(['search_quran']),
      toolRound(['search_quran']),
      textRound('Answer.'),
    ];

    const p = pairs(terminal(await collect(runFacilitator([userMessage('q')]))).toolCalls!);
    expect(p).toHaveLength(4);
    expect(p.slice(0, 3).every((x) => x.result.status === 'ok')).toBe(true);
    expect(p[3].result).toMatchObject({ status: 'limit_refused', duration_ms: null });
    expect(p[3].result.content).toMatchObject({ summary: expect.stringContaining('limit') });
  });

  it('an unknown tool is unknown_tool with null duration', async () => {
    h.scripts = [toolRound(['no_such_tool']), textRound('Answer.')];

    const p = pairs(terminal(await collect(runFacilitator([userMessage('q')]))).toolCalls!);
    expect(p[0].use.name).toBe('no_such_tool');
    expect(p[0].result).toMatchObject({ status: 'unknown_tool', duration_ms: null });
  });
});

describe('terminal error events carry the accumulated records', () => {
  it('catch-all: a Gemini failure after a tool round → error event with the records', async () => {
    h.scripts = [toolRound(['search_quran', 'search_hadith']), throwingRound('vertex exploded')];

    const events = await collect(runFacilitator([userMessage('q')]));
    const t = terminal(events);
    expect(t.type).toBe('error');
    expect(t.data).toBe('vertex exploded');
    expect(pairs(t.toolCalls!)).toHaveLength(2);
  });

  it('synthesis failure after a T1 short-circuit → budget error event with the records', async () => {
    h.behavior = { search_quran: 'degrade', search_hadith: 'degrade' };
    h.scripts = [toolRound(['search_quran', 'search_hadith']), throwingRound('synthesis exploded')];

    const events = await collect(runFacilitator([userMessage('q')]));
    const t = terminal(events);
    expect(t.type).toBe('error');
    expect(pairs(t.toolCalls!)).toHaveLength(2);
    expect(t.toolCalls!.filter((r) => r.type === 'tool_result').every((r) => r.status === 'degraded')).toBe(true);
  });

  it('degenerate synthesis: a T1 short-circuit whose synthesis returns empty → budget error event with the records', async () => {
    h.behavior = { search_quran: 'degrade', search_hadith: 'degrade' };
    // Synthesis completes (a `done` arrives) but with no visible text — the
    // unusable-synthesis branch, distinct from the synthesis-throw branch.
    h.scripts = [toolRound(['search_quran', 'search_hadith']), emptyRound('STOP')];

    const events = await collect(runFacilitator([userMessage('q')]));
    const t = terminal(events);
    expect(t.type).toBe('error');
    expect(pairs(t.toolCalls!)).toHaveLength(2);
  });

  it('degenerate final: empty answers after a tool round exhaust the ladder → error event with the records', async () => {
    // Inkling is stubbed unavailable, so the ladder is one same-model retry: two empty
    // STOP finals after the tool round land on the degenerate-final error yield.
    h.scripts = [toolRound(['search_quran']), emptyRound('STOP'), emptyRound('STOP')];

    const events = await collect(runFacilitator([userMessage('q')]));
    const t = terminal(events);
    expect(t.type).toBe('error');
    expect(t.data).toMatch(/empty answer/i);
    expect(pairs(t.toolCalls!)).toHaveLength(1);
    expect(t.toolCalls![0]).toMatchObject({ type: 'tool_use', name: 'search_quran' });
  });

  it('max iterations: ten tool rounds → "Maximum iterations reached" error with every round recorded', async () => {
    h.scripts = Array.from({ length: 10 }, () => toolRound(['search_quran']));

    const events = await collect(runFacilitator([userMessage('q')]));
    const t = terminal(events);
    expect(t.type).toBe('error');
    expect(t.data).toBe('Maximum iterations reached');
    const p = pairs(t.toolCalls!);
    expect(p).toHaveLength(10);
    // The consecutive-same-tool limit refuses the 4th call onward; those never
    // executed but are still in the denominator, distinguishable by status.
    expect(p.slice(0, 3).map((x) => x.result.status)).toEqual(['ok', 'ok', 'ok']);
    expect(p.slice(3).every((x) => x.result.status === 'limit_refused' && x.result.duration_ms === null)).toBe(true);
  });

  it('an error before any dispatch carries no toolCalls', async () => {
    h.scripts = [throwingRound('immediate')];

    const t = terminal(await collect(runFacilitator([userMessage('q')])));
    expect(t.type).toBe('error');
    expect(t.toolCalls).toBeUndefined();
  });
});
