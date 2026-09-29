import { describe, it, expect, vi, beforeEach } from 'vitest';
import { unavailableResult } from '../lib/tools/resilience';
import type { ToolCallRecord } from '../db/schema/messages';

/**
 * Per-result citability on persisted tool_result records (spec 168).
 *
 * Every record path — executed hit, zero-result notice (status 'ok'!),
 * degraded, backstop throw, limit-refused, unknown tool, budget-skipped — must
 * carry `citations` index-aligned with `content.results`, holding the tool's own
 * citations.enabled. And the Gemini functionResponse must be byte-identical to
 * the pre-168 format: the flag is persisted BESIDE `content`, never sent to the
 * model. Harness mirrors facilitator-toolcalls.test.ts.
 */

type AnyEvent = { type: string; data?: unknown; response?: unknown };

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

type Behavior = 'hit' | 'noresults' | 'degrade' | 'throw';

const HIT_DOCS = [
  { title: 'Quran 2:153', context: 'Retrieved from the Holy Quran', data: '{"ar":"يا أيها","en":"O you who believe"}' },
  { title: 'Quran 2:155', context: 'Retrieved from the Holy Quran', data: '{"ar":"ولنبلونكم","en":"And We will test you"}' },
];

vi.mock('@/lib/tools', () => ({
  getGeminiToolDescriptions: () => [{ name: 'search_quran' }],
  createToolMap: () => {
    const make = (name: string) => ({
      run: async () => {
        const b = (h.behavior[name] ?? 'hit') as Behavior;
        if (b === 'throw') throw new Error(`simulated ${name} crash`);
        if (b === 'degrade') return unavailableResult(name);
        if (b === 'noresults') {
          return {
            content: 'No Quran verses found for this query.',
            documents: [
              {
                type: 'document',
                source: { type: 'text', media_type: 'text/plain', data: 'No results found.' },
                title: 'No Results',
                context: 'Quran Search',
                citations: { enabled: false },
              },
            ],
          };
        }
        return {
          content: 'Please see the Quran verses below.',
          documents: HIT_DOCS.map((d) => ({
            type: 'document',
            source: { type: 'text', media_type: 'text/plain', data: d.data },
            title: d.title,
            context: d.context,
            citations: { enabled: true },
          })),
        };
      },
    });
    return new Map(
      ['search_quran', 'search_hadith', 'search_mawsuah', 'search_tafsir_encyclopedia'].map((n) => [n, make(n)]),
    );
  },
}));

import { streamGemini } from '@/lib/ai/gemini-client';
import { runFacilitator, type Message, type FacilitatorStreamEvent } from '../lib/facilitator/agent';

async function collect(gen: AsyncGenerator<FacilitatorStreamEvent>): Promise<FacilitatorStreamEvent[]> {
  const events: FacilitatorStreamEvent[] = [];
  for await (const e of gen) events.push(e);
  return events;
}

function userMessage(text: string): Message {
  return { role: 'user', content: [{ type: 'text', text }] };
}

type ResultRecord = Extract<ToolCallRecord, { type: 'tool_result' }>;

/** The run's tool_result records, each asserted index-aligned (spec 168 invariant). */
async function resultsOf(): Promise<ResultRecord[]> {
  const events = await collect(runFacilitator([userMessage('q')]));
  const t = events[events.length - 1];
  expect(['done', 'error']).toContain(t.type);
  const results = (t.toolCalls ?? []).filter((r): r is ResultRecord => r.type === 'tool_result');
  for (const r of results) {
    const entries = (r.content as { results: unknown[] }).results;
    expect(r.citations).toBeDefined();
    expect(r.citations).toHaveLength(entries.length);
  }
  return results;
}

beforeEach(() => {
  h.scripts = [];
  h.behavior = {};
  vi.clearAllMocks();
});

describe('tool_result records carry per-result citability', () => {
  it('a real hit and a zero-result search in one round: both status ok, only the hit is citable', async () => {
    h.behavior = { search_quran: 'hit', search_hadith: 'noresults' };
    h.scripts = [toolRound(['search_quran', 'search_hadith']), textRound('Answer.')];

    const [hit, empty] = await resultsOf();
    // Status alone cannot separate them — that is the whole point of the flag.
    expect(hit.status).toBe('ok');
    expect(empty.status).toBe('ok');
    expect(hit.citations).toEqual([{ enabled: true }, { enabled: true }]);
    expect(empty.citations).toEqual([{ enabled: false }]);
  });

  it('a degraded tool is not citable', async () => {
    h.behavior = { search_quran: 'degrade' };
    h.scripts = [toolRound(['search_quran']), textRound('Answer.')];
    const [r] = await resultsOf();
    expect(r.status).toBe('degraded');
    expect(r.citations).toEqual([{ enabled: false }]);
  });

  it('a throwing tool (backstop) is not citable', async () => {
    h.behavior = { search_quran: 'throw' };
    h.scripts = [toolRound(['search_quran']), textRound('Answer.')];
    const [r] = await resultsOf();
    expect(r.status).toBe('degraded');
    expect(r.citations).toEqual([{ enabled: false }]);
  });

  it('a limit-refused call is not citable', async () => {
    h.scripts = [
      toolRound(['search_quran']),
      toolRound(['search_quran']),
      toolRound(['search_quran']),
      toolRound(['search_quran']),
      textRound('Answer.'),
    ];
    const results = await resultsOf();
    expect(results[3].status).toBe('limit_refused');
    expect(results[3].citations).toEqual([{ enabled: false }]);
    expect(results.slice(0, 3).every((r) => r.citations!.every((c) => c.enabled))).toBe(true);
  });

  it('an unknown tool is not citable', async () => {
    h.scripts = [toolRound(['no_such_tool']), textRound('Answer.')];
    const [r] = await resultsOf();
    expect(r.status).toBe('unknown_tool');
    expect(r.citations).toEqual([{ enabled: false }]);
  });

  it('a budget-skipped call carries citations: [] (no results)', async () => {
    h.behavior = { search_quran: 'degrade', search_hadith: 'degrade', search_mawsuah: 'hit' };
    h.scripts = [toolRound(['search_quran', 'search_hadith', 'search_mawsuah']), textRound('Synthesis.')];
    const results = await resultsOf();
    expect(results[2].status).toBe('budget_skipped');
    expect(results[2].citations).toEqual([]);
  });
});

describe('the Gemini functionResponse is byte-identical to the pre-168 format', () => {
  function functionResponses(): Array<{ name: string; response: unknown }> {
    const calls = vi.mocked(streamGemini).mock.calls;
    // History is passed by reference; the last call sees every pushed round.
    const history = (calls[calls.length - 1][1] as { history: Array<{ parts: Array<Record<string, unknown>> }> }).history;
    return history
      .flatMap((c) => c.parts)
      .filter((p) => 'functionResponse' in p)
      .map((p) => p.functionResponse as { name: string; response: unknown });
  }

  it('hit + notice: exact pre-168 bytes, no citations key, and persisted content equals what was sent', async () => {
    h.behavior = { search_quran: 'hit', search_hadith: 'noresults' };
    h.scripts = [toolRound(['search_quran', 'search_hadith']), textRound('Answer.')];

    const records = await resultsOf();
    const sent = functionResponses();
    expect(sent).toHaveLength(2);

    // Pre-168 formatToolResultForGemini output, written out literally.
    expect(JSON.stringify(sent[0].response)).toBe(
      '{"results":[' +
        '{"title":"Quran 2:153","context":"Retrieved from the Holy Quran","content":"{\\"ar\\":\\"يا أيها\\",\\"en\\":\\"O you who believe\\"}"},' +
        '{"title":"Quran 2:155","context":"Retrieved from the Holy Quran","content":"{\\"ar\\":\\"ولنبلونكم\\",\\"en\\":\\"And We will test you\\"}"}' +
        '],"summary":"Please see the Quran verses below."}'
    );
    expect(JSON.stringify(sent[1].response)).toBe(
      '{"results":[{"title":"No Results","context":"Quran Search","content":"No results found."}],' +
        '"summary":"No Quran verses found for this query."}'
    );
    for (const s of sent) expect(JSON.stringify(s)).not.toContain('citations');

    // The record's content IS the payload; the flag sits beside it.
    expect(records[0].content).toEqual(sent[0].response);
    expect(records[1].content).toEqual(sent[1].response);
    expect(Object.keys(records[0].content)).toEqual(['results', 'summary']);
  });
});
