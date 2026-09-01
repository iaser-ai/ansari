import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * PRIMARY_BACKEND switch — env-gated OpenAI-compatible primary (issue #95).
 *
 * Unlike the facilitator-inkling-rung suite (which mocks both clients), this
 * suite runs the REAL facilitator loop, the REAL inkling-client, and the REAL
 * tools module against a mocked OpenAI-compatible server (a URL-dispatching
 * global-fetch stub). Under test:
 *  - default client selection pinned: provider unset/'gemini' → streamGemini,
 *    the OpenAI-compat endpoint is never contacted;
 *  - PRIMARY_BACKEND=inkling: a full facilitator loop (tool round + final)
 *    against the mock — the primary call carries the real tool schemas, the
 *    tool dispatches (mocked Kalemat HTTP), the tool round feeds back as
 *    OpenAI messages, the final answer streams, persistence gets a guarded
 *    rawPayload with zero functionCall parts, and Gemini is NEVER called;
 *  - reasoning_content never reaches the user-visible stream or persistence
 *    on the primary path;
 *  - rescue rung short-circuited: an inkling-primary failure surfaces loudly
 *    after ONE attempt (no Gemini rescue, no silent retry);
 *  - an explicit caller provider option overrides the env switch.
 */

const INKLING_URL = 'https://example--gemma-checkpoint.modal.run/v1/chat/completions';

const h = vi.hoisted(() => ({
  primaryBackend: 'gemini' as 'gemini' | 'inkling',
  geminiCalls: [] as Array<{ message: string; options: Record<string, unknown> }>,
}));

vi.mock('@sentry/nextjs', () => ({
  addBreadcrumb: vi.fn(),
  captureException: vi.fn(),
  captureMessage: vi.fn(),
}));

vi.mock('@/lib/config', () => ({
  config: {
    get primaryBackend() {
      return h.primaryBackend;
    },
    get inkling() {
      return {
        apiKey: 'inkling-key',
        baseUrl: INKLING_URL,
        model: 'thinkingmachines/Inkling',
        maxTokens: 8192,
        timeoutMs: 180000,
      };
    },
    // Deliberately throwing: an inkling-only deployment has NO Gemini credentials,
    // so the real getter throws. Nothing in this suite may read it — not the
    // healthy paths, and (issue #95 / codex finding) not the degenerate-final
    // retry bookkeeping under inkling-primary either.
    get gemini(): { model: string; fallbackModel: string } {
      throw new Error('config.gemini must not be read in this suite');
    },
    get tools() {
      return {
        kalemat: { apiKey: 'kalemat-key' },
        usul: { apiToken: 'usul-token', baseUrl: 'https://api.usul.ai/v1/vector-search' },
      };
    },
  },
}));

vi.mock('@/lib/ai/gemini-client', () => ({
  streamGemini: vi.fn((message: string, options: Record<string, unknown>) => {
    h.geminiCalls.push({ message, options });
    return (async function* () {
      yield { type: 'text', data: 'gemini answer' };
      yield {
        type: 'done',
        response: {
          text: 'gemini answer',
          toolCalls: [],
          rawPayload: { role: 'model', parts: [{ text: 'gemini answer' }] },
          allParts: [{ text: 'gemini answer' }],
          hasThinking: false,
          finishReason: 'STOP',
        },
      };
    })();
  }),
}));

// Real modules under test — imported AFTER the mocks above.
import { runFacilitator, type Message } from '../lib/facilitator/agent';
import { streamGemini } from '../lib/ai/gemini-client';
import { getGeminiToolDescriptions } from '../lib/tools';
import { FACILITATOR_SYSTEM_PROMPT, TOOL_CONTINUATION_DIRECTIVE } from '../lib/ai/prompts/facilitator';

type Event = { type: string; data?: string; rawPayload?: unknown; toolCalls?: unknown };

function sse(chunks: object[]): Response {
  const body = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n';
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(body));
        controller.close();
      },
    }),
    { status: 200, headers: { 'Content-Type': 'text/event-stream' } }
  );
}

function delta(d: object, finish?: string): object {
  return { choices: [{ delta: d, finish_reason: finish ?? null }] };
}

const fetchMock = vi.fn();

/** Queue of SSE responses served to the mocked OpenAI-compat endpoint, in order. */
let inklingResponses: Array<() => Response> = [];
/** Every request body POSTed to the mocked OpenAI-compat endpoint. */
let inklingRequests: Array<Record<string, unknown>> = [];

beforeEach(() => {
  vi.clearAllMocks();
  h.primaryBackend = 'gemini';
  h.geminiCalls = [];
  inklingResponses = [];
  inklingRequests = [];
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url === INKLING_URL) {
      inklingRequests.push(JSON.parse(init?.body as string));
      const next = inklingResponses.shift();
      if (!next) throw new Error(`unexpected inkling request #${inklingRequests.length}`);
      return next();
    }
    if (url.startsWith('https://api.kalimat.dev/search')) {
      return new Response(
        JSON.stringify([{ id: '2:153', text: 'آية الصبر', en_text: 'Verse about patience' }]),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }
    throw new Error(`unexpected fetch to ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function userMessage(text: string): Message {
  return { role: 'user', content: [{ type: 'text', text }] };
}

async function collect(gen: AsyncGenerator<Event>): Promise<Event[]> {
  const events: Event[] = [];
  for await (const e of gen) events.push(e);
  return events;
}

describe('PRIMARY_BACKEND=gemini / unset (default — byte-identical behavior)', () => {
  it('selects streamGemini and never contacts the OpenAI-compat endpoint', async () => {
    const events = await collect(runFacilitator([userMessage('What is sabr?')]));

    expect(h.geminiCalls).toHaveLength(1);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(events.at(-1)?.type).toBe('done');
    expect(events.filter((e) => e.type === 'text').map((e) => e.data).join('')).toBe(
      'gemini answer'
    );
  });
});

describe('PRIMARY_BACKEND=inkling (env-gated OpenAI-compatible primary)', () => {
  beforeEach(() => {
    h.primaryBackend = 'inkling';
  });

  it('runs a full facilitator loop (tool round + final) against the mocked server; Gemini never called', async () => {
    inklingResponses = [
      // Round 1: hidden reasoning, then a tool call for the real search_quran tool.
      () =>
        sse([
          delta({ reasoning_content: 'HIDDEN-REASONING-1' }),
          delta({
            tool_calls: [
              { index: 0, function: { name: 'search_quran', arguments: '{"query":"sabr"}' } },
            ],
          }),
          delta({}, 'tool_calls'),
        ]),
      // Round 2: final streamed answer.
      () =>
        sse([
          delta({ reasoning_content: 'HIDDEN-REASONING-2' }),
          delta({ content: 'Patience (sabr) is ' }),
          delta({ content: 'praised in Quran 2:153.' }, 'stop'),
        ]),
    ];

    const persisted: Message[] = [];
    const events = await collect(
      runFacilitator([userMessage('What does the Quran say about sabr?')], async (m) => {
        persisted.push(m);
      })
    );

    // Gemini is not called at all.
    expect(vi.mocked(streamGemini)).not.toHaveBeenCalled();
    expect(h.geminiCalls).toHaveLength(0);

    // The primary call went to the configured endpoint with the REAL tool schemas.
    expect(inklingRequests).toHaveLength(2);
    const first = inklingRequests[0];
    expect(first.model).toBe('thinkingmachines/Inkling');
    const realToolNames = getGeminiToolDescriptions()
      .flatMap((t) => t.functionDeclarations ?? [])
      .map((fn) => fn.name);
    const sentTools = first.tools as Array<{ function: { name: string; parameters: { type: string } } }>;
    expect(sentTools.map((t) => t.function.name)).toEqual(realToolNames);
    expect(realToolNames).toContain('search_quran');
    // Gemini's uppercase schema types are converted for the OpenAI surface.
    expect(sentTools.every((t) => t.function.parameters.type === 'object')).toBe(true);
    const firstMessages = first.messages as Array<{ role: string; content: string | null }>;
    expect(firstMessages[0]).toEqual({ role: 'system', content: FACILITATOR_SYSTEM_PROMPT });
    expect(firstMessages.at(-1)).toEqual({
      role: 'user',
      content: 'What does the Quran say about sabr?',
    });

    // The tool actually dispatched (mocked Kalemat HTTP) and its result fed round 2.
    expect(events.some((e) => e.type === 'tool_use')).toBe(true);
    const toolResult = events.find((e) => e.type === 'tool_result');
    expect(toolResult).toBeDefined();
    expect(JSON.parse(toolResult!.data as string)).toMatchObject({
      tool: 'search_quran',
      resultCount: 1,
    });
    const second = inklingRequests[1];
    const secondMessages = second.messages as Array<Record<string, unknown>>;
    expect(
      secondMessages.some(
        (m) => m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length === 1
      )
    ).toBe(true);
    const toolMsg = secondMessages.find((m) => m.role === 'tool');
    expect(toolMsg).toBeDefined();
    expect(String(toolMsg!.content)).toContain('Verse about patience');
    expect(secondMessages.at(-1)).toEqual({
      role: 'user',
      content: TOOL_CONTINUATION_DIRECTIVE,
    });

    // The final answer streamed and completed.
    expect(events.filter((e) => e.type === 'text').map((e) => e.data).join('')).toBe(
      'Patience (sabr) is praised in Quran 2:153.'
    );
    const done = events.at(-1)!;
    expect(done.type).toBe('done');

    // raw_payload guard holds: the persisted final turn carries zero functionCall parts.
    expect(done.rawPayload).toEqual({
      role: 'model',
      parts: [{ text: 'Patience (sabr) is praised in Quran 2:153.' }],
    });
    expect(persisted).toHaveLength(1);
    expect(persisted[0].rawPayload).toEqual(done.rawPayload);

    // reasoning_content never reaches the stream, events, or persistence.
    expect(JSON.stringify(events)).not.toContain('HIDDEN-REASONING');
    expect(JSON.stringify(persisted)).not.toContain('HIDDEN-REASONING');

    // Tool-call persistence (spec 73) works unchanged under inkling-primary:
    // loop-level records accumulate with correct statuses and paired ids, and
    // ride both the terminal event and the persisted message.
    const records = done.toolCalls as Array<Record<string, unknown>>;
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      type: 'tool_use',
      name: 'search_quran',
      input: { query: 'sabr' },
    });
    expect(records[1]).toMatchObject({
      type: 'tool_result',
      tool_use_id: records[0].id,
      status: 'ok',
    });
    expect(persisted[0].toolCalls).toEqual(records);
  });

  it('a degenerate (empty) final retries same-model on inkling — without ever reading config.gemini', async () => {
    inklingResponses = [
      // Round 1: a completed stream with zero visible text (Inkling's empty-final shape).
      () => sse([delta({}, 'stop')]),
      // Retry: a real answer.
      () => sse([delta({ content: 'A real answer this time.' }, 'stop')]),
    ];

    const events = await collect(runFacilitator([userMessage('q')]));

    // Same-model retry happened (two requests to the mock), and it could only
    // have happened if the degenerate-final bookkeeping avoided config.gemini —
    // this suite's gemini getter throws (inkling-only deployment shape).
    expect(inklingRequests).toHaveLength(2);
    expect(vi.mocked(streamGemini)).not.toHaveBeenCalled();
    expect(events.at(-1)?.type).toBe('done');
    expect(events.filter((e) => e.type === 'text').map((e) => e.data).join('')).toBe(
      'A real answer this time.'
    );
  });

  it('rescue rung is short-circuited: an inkling failure surfaces loudly after one attempt', async () => {
    inklingResponses = [() => new Response('boom', { status: 500 })];

    const events = await collect(runFacilitator([userMessage('q')]));

    const error = events.find((e) => e.type === 'error');
    expect(error).toBeDefined();
    expect(error!.data).toMatch(/HTTP 500/);
    // Exactly one attempt: no Gemini rescue, no silent inkling retry.
    expect(inklingRequests).toHaveLength(1);
    expect(vi.mocked(streamGemini)).not.toHaveBeenCalled();
  });

  it('an explicit caller provider option overrides the env switch', async () => {
    const events = await collect(
      runFacilitator([userMessage('q')], undefined, { provider: 'gemini' })
    );

    expect(h.geminiCalls).toHaveLength(1);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(events.at(-1)?.type).toBe('done');
  });
});
