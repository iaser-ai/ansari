import { describe, it, expect, vi, beforeEach } from 'vitest';
import { unavailableResult } from '../lib/tools/resilience';
import type { DocumentBlock } from '../lib/tools/types';

/**
 * Facilitator citable documents on `done` (issue #66, Phase 1).
 *
 * runFacilitator must hand callers the turn's citable retrieved documents on the
 * terminal `done` event — normal and synthesis (T1/T2) paths — in dispatch order,
 * deduplicated, projected to the persisted `document` ContentBlock shape. Notices
 * (no results, unavailable, limit-refused, unknown tool) and budget-skipped calls
 * contribute nothing; a no-tool turn and every `error` event carry no `documents`
 * key at all; the wire-facing tool_result frame is unchanged.
 *
 * Harness mirrors facilitator-toolcalls.test.ts: streamGemini is scripted per
 * call; the tool map is scripted per tool.
 */

type AnyEvent = { type: string; data?: unknown; response?: unknown };
type Behavior = 'ok' | 'slow_ok' | 'two_docs' | 'shared' | 'no_results' | 'degrade';

const h = vi.hoisted(() => ({
  scripts: [] as Array<() => AsyncGenerator<AnyEvent>>,
  behavior: {} as Record<string, string>,
}));

function doneResponse(text: string, toolCalls: Array<{ name: string; args: unknown }> = []) {
  return {
    text,
    toolCalls,
    rawPayload: { role: 'model', parts: text ? [{ text }] : [] },
    allParts: text ? [{ text }] : [],
    hasThinking: false,
    usage: { promptTokenCount: 1, candidatesTokenCount: 1, thoughtsTokenCount: 0, totalTokenCount: 2 },
    finishReason: 'STOP',
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

vi.mock('@/lib/config', () => ({
  config: { gemini: { model: 'primary-model', fallbackModel: 'fallback-model' } },
}));

vi.mock('@/lib/ai/inkling-client', () => ({
  isInklingConfigured: () => false,
  streamInkling: vi.fn(),
}));

vi.mock('@/lib/ai/prompts/facilitator', () => ({
  FACILITATOR_SYSTEM_PROMPT: 'BASE_PROMPT',
  TOOL_CONTINUATION_DIRECTIVE: 'CONTINUATION_DIRECTIVE',
}));

function citable(title: string, data: string, context = 'src'): DocumentBlock {
  return {
    type: 'document',
    source: { type: 'text', media_type: 'text/plain', data },
    title,
    context,
    citations: { enabled: true },
  };
}

vi.mock('@/lib/tools', () => ({
  getGeminiToolDescriptions: () => [{ name: 'search_quran' }],
  createToolMap: () => {
    const make = (name: string) => ({
      run: async () => {
        const b = (h.behavior[name] ?? 'ok') as Behavior;
        if (b === 'degrade') return unavailableResult(name);
        if (b === 'no_results') {
          return {
            content: 'No results found.',
            documents: [
              {
                type: 'document',
                source: { type: 'text', media_type: 'text/plain', data: 'No results found.' },
                title: 'No Results',
                context: 'System',
                citations: { enabled: false },
              },
            ],
          };
        }
        if (b === 'slow_ok') await new Promise((r) => setTimeout(r, 60));
        const documents =
          b === 'two_docs'
            ? [citable(`${name}-1`, `doc-${name}-1`), citable(`${name}-2`, `doc-${name}-2`)]
            : b === 'shared'
              ? [citable('shared', 'shared-text')]
              : [citable(name, `doc-${name}`)];
        return { content: `real result for ${name}`, documents };
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

async function terminalOf(
  options?: Parameters<typeof runFacilitator>[2]
): Promise<{ events: FacilitatorStreamEvent[]; terminal: FacilitatorStreamEvent }> {
  const events = await collect(runFacilitator([userMessage('q')], undefined, options));
  return { events, terminal: events[events.length - 1] };
}

const titles = (e: FacilitatorStreamEvent) => e.documents!.map((d) => d.title);

beforeEach(() => {
  h.scripts = [];
  h.behavior = {};
  vi.clearAllMocks();
});

describe('done carries the turn\'s citable documents', () => {
  it('single tool → one document in the persisted shape, no citations key', async () => {
    h.scripts = [toolRound(['search_quran']), textRound('Answer.')];

    const { terminal } = await terminalOf();
    expect(terminal.type).toBe('done');
    expect(terminal.documents).toEqual([
      {
        type: 'document',
        source: { type: 'text', media_type: 'text/plain', data: 'doc-search_quran' },
        title: 'search_quran',
        context: 'src',
      },
    ]);
    for (const d of terminal.documents!) {
      expect(Object.keys(d).sort()).toEqual(['context', 'source', 'title', 'type']);
    }
  });

  it('parallel calls in one round → documents in dispatch order', async () => {
    h.behavior = { search_hadith: 'two_docs' };
    h.scripts = [toolRound(['search_hadith', 'search_quran']), textRound('Answer.')];

    const { terminal } = await terminalOf();
    expect(titles(terminal)).toEqual(['search_hadith-1', 'search_hadith-2', 'search_quran']);
  });

  it('multi-round with a cross-round duplicate → the duplicate appears once, at its first position', async () => {
    h.behavior = { search_quran: 'shared', search_mawsuah: 'shared' };
    h.scripts = [
      toolRound(['search_quran', 'search_hadith']),
      toolRound(['search_mawsuah', 'search_tafsir_encyclopedia']),
      textRound('Answer.'),
    ];

    const { terminal } = await terminalOf();
    expect(titles(terminal)).toEqual(['shared', 'search_hadith', 'search_tafsir_encyclopedia']);
  });

  it('T1 synthesis path → done carries the successful tool\'s documents only', async () => {
    h.behavior = { search_hadith: 'degrade', search_mawsuah: 'degrade' };
    h.scripts = [
      toolRound(['search_quran', 'search_hadith', 'search_mawsuah', 'search_tafsir_encyclopedia']),
      textRound('Best-effort synthesis.'),
    ];

    const { terminal } = await terminalOf();
    expect(terminal.type).toBe('done');
    // search_tafsir_encyclopedia was budget-skipped by T1 and contributes nothing.
    expect(terminal.toolCalls!.at(-1)).toMatchObject({ status: 'budget_skipped', skip_trigger: 'T1' });
    expect(titles(terminal)).toEqual(['search_quran']);
  });

  it('T2 synthesis path → done carries documents from executed calls; the skipped call adds none', async () => {
    h.behavior = { search_quran: 'slow_ok' };
    h.scripts = [toolRound(['search_quran', 'search_hadith']), textRound('Best-effort synthesis.')];

    // softDeadline = +20ms; the first (slow, 60ms) tool pushes the second past it.
    const { terminal } = await terminalOf({ budgetMs: 2000, reserveMs: 1980 });
    expect(terminal.type).toBe('done');
    expect(terminal.toolCalls!.at(-1)).toMatchObject({ status: 'budget_skipped', skip_trigger: 'T2' });
    expect(titles(terminal)).toEqual(['search_quran']);
  });

  it('the tool_result frame is unchanged: still only {tool, query, resultCount}', async () => {
    h.scripts = [toolRound(['search_quran']), textRound('Answer.')];

    const { events } = await terminalOf();
    const frame = events.find((e) => e.type === 'tool_result')!;
    expect(JSON.parse(frame.data)).toEqual({ tool: 'search_quran', query: 'q-search_quran', resultCount: 1 });
    expect('documents' in frame).toBe(false);
    for (const e of events.slice(0, -1)) expect('documents' in e).toBe(false);
  });
});

describe('notices and skipped calls contribute nothing', () => {
  it('no results → done has no documents key', async () => {
    h.behavior = { search_quran: 'no_results' };
    h.scripts = [toolRound(['search_quran']), textRound('Answer.')];

    const { terminal } = await terminalOf();
    expect(terminal.type).toBe('done');
    expect('documents' in terminal).toBe(false);
  });

  it('degraded/unavailable → done has no documents key', async () => {
    h.behavior = { search_quran: 'degrade' };
    h.scripts = [toolRound(['search_quran']), textRound('Answer.')];

    const { terminal } = await terminalOf();
    expect(terminal.type).toBe('done');
    expect('documents' in terminal).toBe(false);
  });

  it('unknown tool → done has no documents key', async () => {
    h.scripts = [toolRound(['no_such_tool']), textRound('Answer.')];

    const { terminal } = await terminalOf();
    expect(terminal.type).toBe('done');
    expect('documents' in terminal).toBe(false);
  });

  it('limit-refused calls add nothing; the three executed calls dedupe to one document', async () => {
    h.scripts = [
      toolRound(['search_quran']),
      toolRound(['search_quran']),
      toolRound(['search_quran']),
      toolRound(['search_quran']),
      textRound('Answer.'),
    ];

    const { terminal } = await terminalOf();
    expect(terminal.toolCalls!.at(-1)).toMatchObject({ status: 'limit_refused' });
    expect(titles(terminal)).toEqual(['search_quran']);
  });

  it('mixed degraded + success → only the successful tool\'s documents', async () => {
    h.behavior = { search_hadith: 'degrade' };
    h.scripts = [toolRound(['search_hadith', 'search_quran']), textRound('Answer.')];

    const { terminal } = await terminalOf();
    expect(titles(terminal)).toEqual(['search_quran']);
  });
});

describe('turns without documents', () => {
  it('no-tool turn → done has no documents key', async () => {
    h.scripts = [textRound('Plain answer.')];

    const { terminal } = await terminalOf();
    expect(terminal.type).toBe('done');
    expect('documents' in terminal).toBe(false);
  });

  it('T1 synthesis done with nothing citable → no documents key', async () => {
    h.behavior = { search_quran: 'degrade', search_hadith: 'degrade' };
    h.scripts = [toolRound(['search_quran', 'search_hadith']), textRound('Best-effort synthesis.')];

    const { terminal } = await terminalOf();
    expect(terminal.type).toBe('done');
    expect(terminal.toolCalls).toBeDefined();
    expect('documents' in terminal).toBe(false);
  });

  it('an error terminal event carries no documents even after a successful retrieval', async () => {
    h.scripts = [toolRound(['search_quran']), throwingRound('vertex exploded')];

    const { terminal } = await terminalOf();
    expect(terminal.type).toBe('error');
    expect(terminal.toolCalls).toBeDefined();
    expect('documents' in terminal).toBe(false);
  });
});
