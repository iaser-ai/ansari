import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Unit tests for the minimal OpenAI-compat Inkling client (issue #74).
 *
 * The client is exercised against a mocked global fetch that replays
 * OpenAI-style SSE chat-completion chunks. Behavior under test:
 *  - request shape (endpoint, auth, max_tokens window, temp 0, message and
 *    tool conversion from the Gemini formats);
 *  - streaming: text deltas emitted live, reasoning_content NEVER emitted
 *    or persisted, fragmented tool_calls reassembled;
 *  - GeminiResponse-shaped `done` (Gemini-format rawPayload, mapped
 *    finishReason, mapped usage);
 *  - fail-fast on HTTP errors, malformed args, and a missing key.
 */

const h = vi.hoisted(() => ({
  apiKey: 'test-tinker-key' as string | undefined,
  // Config defaults (issue #90): the real schema defaults these when the
  // INKLING_MODEL / INKLING_MAX_TOKENS / INKLING_TIMEOUT_MS env vars are unset.
  model: 'thinkingmachines/Inkling',
  maxTokens: 8192,
  timeoutMs: 180000,
}));

vi.mock('@sentry/nextjs', () => ({
  addBreadcrumb: vi.fn(),
  captureException: vi.fn(),
  captureMessage: vi.fn(),
}));

vi.mock('@/lib/config', () => ({
  config: {
    get inkling() {
      return { apiKey: h.apiKey, model: h.model, maxTokens: h.maxTokens, timeoutMs: h.timeoutMs };
    },
  },
}));

import { streamInkling, isInklingConfigured } from '../lib/ai/inkling-client';
import type { GeminiStreamEvent } from '../lib/ai/gemini-client';

function sseBody(chunks: object[]): string {
  return chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n';
}

function sseResponse(chunks: object[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(sseBody(chunks)));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

/** Build a 200 SSE Response from a RAW body string — no auto-appended `[DONE]` (issue #2). */
function rawSseResponse(body: string): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

function delta(d: object, finish?: string): object {
  return { choices: [{ delta: d, finish_reason: finish ?? null }] };
}

const fetchMock = vi.fn();

async function collect(gen: AsyncGenerator<GeminiStreamEvent>): Promise<GeminiStreamEvent[]> {
  const events: GeminiStreamEvent[] = [];
  for await (const e of gen) events.push(e);
  return events;
}

function doneOf(events: GeminiStreamEvent[]) {
  const done = events.find((e) => e.type === 'done');
  if (!done || done.type !== 'done') throw new Error('no done event');
  return done.response;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.apiKey = 'test-tinker-key';
  h.model = 'thinkingmachines/Inkling';
  h.maxTokens = 8192;
  h.timeoutMs = 180000;
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('isInklingConfigured', () => {
  it('false when TINKER_API_KEY is unset (warns once), true when set', () => {
    h.apiKey = undefined;
    expect(isInklingConfigured()).toBe(false);
    expect(isInklingConfigured()).toBe(false);
    // Logged once per process, not per call.
    expect(vi.mocked(console.warn).mock.calls.length).toBeLessThanOrEqual(1);

    h.apiKey = 'k';
    expect(isInklingConfigured()).toBe(true);
  });
});

describe('streamInkling', () => {
  it('throws immediately when the key is unset (fail fast, no request)', async () => {
    h.apiKey = undefined;
    await expect(collect(streamInkling('q'))).rejects.toThrow(/TINKER_API_KEY/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('streams text deltas and finishes with a Gemini-shaped response', async () => {
    fetchMock.mockResolvedValue(
      sseResponse([
        delta({ content: 'Patience ' }),
        delta({ content: 'is a virtue.' }, 'stop'),
        {
          choices: [],
          usage: {
            prompt_tokens: 10,
            completion_tokens: 7,
            total_tokens: 17,
            completion_tokens_details: { reasoning_tokens: 3 },
          },
        },
      ])
    );

    const events = await collect(streamInkling('What is sabr?', { systemPrompt: 'SYS' }));
    const texts = events.filter((e) => e.type === 'text').map((e) => e.data);
    expect(texts.join('')).toBe('Patience is a virtue.');

    const response = doneOf(events);
    expect(response.text).toBe('Patience is a virtue.');
    expect(response.finishReason).toBe('STOP');
    expect(response.toolCalls).toEqual([]);
    expect(response.rawPayload).toEqual({
      role: 'model',
      parts: [{ text: 'Patience is a virtue.' }],
    });
    expect(response.usage).toEqual({
      promptTokenCount: 10,
      candidatesTokenCount: 7,
      thoughtsTokenCount: 3,
      totalTokenCount: 17,
    });
  });

  it('sends the right request: endpoint, bearer auth, max_tokens 8–16K, temperature 0, stream', async () => {
    fetchMock.mockResolvedValue(sseResponse([delta({ content: 'ok' }, 'stop')]));

    await collect(streamInkling('hello', { systemPrompt: 'SYS' }));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      'https://tinker.thinkingmachines.dev/services/tinker-prod/oai/api/v1/chat/completions'
    );
    expect(init.headers.Authorization).toBe('Bearer test-tinker-key');
    const body = JSON.parse(init.body);
    expect(body.model).toBe('thinkingmachines/Inkling');
    // Load-bearing (#74): small max_tokens → the hidden reasoning pass starves
    // the visible answer (null content). Must sit in the 8–16K window; the
    // config-supplied default is exactly 8192.
    expect(body.max_tokens).toBe(8192);
    expect(body.temperature).toBe(0);
    expect(body.stream).toBe(true);
    expect(body.stream_options).toEqual({ include_usage: true });
    expect(body.messages).toEqual([
      { role: 'system', content: 'SYS' },
      { role: 'user', content: 'hello' },
    ]);
    expect(body.tools).toBeUndefined();
  });

  it('uses config-overridden model and max_tokens in the request (issue #90)', async () => {
    h.model = 'tinker://ac84a01f-1cbb-55b0-80f4-f9f2b6e3df99:train:0/sampler_weights/final';
    h.maxTokens = 32768;
    fetchMock.mockResolvedValue(sseResponse([delta({ content: 'ok' }, 'stop')]));

    await collect(streamInkling('hello'));

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.model).toBe(
      'tinker://ac84a01f-1cbb-55b0-80f4-f9f2b6e3df99:train:0/sampler_weights/final'
    );
    expect(body.max_tokens).toBe(32768);
  });

  it('uses the config timeout as the backstop when the caller passes no timeoutMs (issue #90)', async () => {
    vi.useFakeTimers();
    try {
      h.timeoutMs = 60000;
      // A fetch that never settles on its own but honors the abort signal —
      // the only way it can end is the client's own timeout firing.
      fetchMock.mockImplementation(
        (_url: string, init: { signal: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            init.signal.addEventListener('abort', () => reject(init.signal.reason));
          })
      );

      const pending = collect(streamInkling('hello'));
      // The rejection message names the applied timeout — 60s proves the config
      // value fired, not a hardcoded 180s default.
      const expectation = expect(pending).rejects.toThrow(/timed out after 60s/);
      await vi.advanceTimersByTimeAsync(60000);
      await expectation;
    } finally {
      vi.useRealTimers();
    }
  });

  it('an explicit timeoutMs option still overrides the config backstop', async () => {
    vi.useFakeTimers();
    try {
      h.timeoutMs = 60000;
      fetchMock.mockImplementation(
        (_url: string, init: { signal: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            init.signal.addEventListener('abort', () => reject(init.signal.reason));
          })
      );

      const pending = collect(streamInkling('hello', { timeoutMs: 5000 }));
      const expectation = expect(pending).rejects.toThrow(/timed out after 5s/);
      await vi.advanceTimersByTimeAsync(5000);
      await expectation;
    } finally {
      vi.useRealTimers();
    }
  });

  it('never leaks reasoning_content into the stream, text, or rawPayload', async () => {
    fetchMock.mockResolvedValue(
      sseResponse([
        delta({ reasoning_content: 'SECRET-HIDDEN-PASS thinking about fiqh...' }),
        delta({ reasoning_content: 'more hidden reasoning' }),
        delta({ content: 'The ruling is X.' }, 'stop'),
      ])
    );

    const events = await collect(streamInkling('q'));
    const texts = events.filter((e) => e.type === 'text').map((e) => e.data);
    expect(texts.join('')).toBe('The ruling is X.');

    const response = doneOf(events);
    expect(response.text).toBe('The ruling is X.');
    // Nothing anywhere in the emitted events or persisted payload carries it.
    expect(JSON.stringify(events)).not.toContain('SECRET-HIDDEN-PASS');
    expect(JSON.stringify(response.rawPayload)).not.toContain('hidden');
  });

  it('reassembles fragmented streaming tool calls and reports them Gemini-style', async () => {
    fetchMock.mockResolvedValue(
      sseResponse([
        delta({ tool_calls: [{ index: 0, function: { name: 'search_quran', arguments: '{"que' } }] }),
        delta({ tool_calls: [{ index: 0, function: { arguments: 'ry":"sabr"}' } }] }),
        delta({}, 'tool_calls'),
      ])
    );

    const events = await collect(streamInkling('q'));
    const toolEvents = events.filter((e) => e.type === 'tool_call');
    expect(toolEvents).toHaveLength(1);
    expect(toolEvents[0].data).toEqual({ name: 'search_quran', args: { query: 'sabr' } });

    const response = doneOf(events);
    expect(response.toolCalls).toEqual([{ name: 'search_quran', args: { query: 'sabr' } }]);
    expect(response.finishReason).toBe('STOP'); // tool_calls maps into the ladder vocabulary
    expect(response.rawPayload.parts).toEqual([
      { functionCall: { name: 'search_quran', args: { query: 'sabr' } } },
    ]);
  });

  it('converts Gemini Content history to OpenAI messages with FIFO tool-call ids', async () => {
    fetchMock.mockResolvedValue(sseResponse([delta({ content: 'ok' }, 'stop')]));

    await collect(
      streamInkling('follow-up', {
        systemPrompt: 'SYS',
        history: [
          { role: 'user', parts: [{ text: 'What is sabr?' }] },
          {
            role: 'model',
            parts: [
              { text: 'Let me search.' },
              { thought: true, text: 'INTERNAL THOUGHT' },
              { functionCall: { name: 'search_quran', args: { query: 'sabr' } } },
            ],
          },
          {
            role: 'user',
            parts: [{ functionResponse: { name: 'search_quran', response: { summary: 'verses' } } }],
          },
        ],
      })
    );

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.messages).toEqual([
      { role: 'system', content: 'SYS' },
      { role: 'user', content: 'What is sabr?' },
      {
        role: 'assistant',
        content: 'Let me search.',
        tool_calls: [
          {
            id: 'call_0',
            type: 'function',
            function: { name: 'search_quran', arguments: '{"query":"sabr"}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call_0', content: '{"summary":"verses"}' },
      { role: 'user', content: 'follow-up' },
    ]);
    // Thought parts never cross to another provider.
    expect(JSON.stringify(body.messages)).not.toContain('INTERNAL THOUGHT');
  });

  it('synthesizes the assistant tool_call when a 3.6-flash tool-round rawPayload dropped the functionCall (issue #81)', async () => {
    const Sentry = await import('@sentry/nextjs');
    fetchMock.mockResolvedValue(sseResponse([delta({ content: 'ok' }, 'stop')]));

    // Verbatim shape of a gemini-3.6-flash model turn whose stored rawPayload
    // is the LAST streamed chunk's parts ("last chunk wins", gemini-client.ts):
    // a thought part + thoughtSignature, with the functionCall chunk already
    // gone — even though the tool actually ran and its functionResponse is in
    // history. Before the fix this threw and crashed the Inkling rung.
    await collect(
      streamInkling('follow-up', {
        systemPrompt: 'SYS',
        history: [
          { role: 'user', parts: [{ text: 'ما حقوق الزوج؟' }] },
          {
            role: 'model',
            parts: [
              { thought: true, text: 'INTERNAL THOUGHT' },
              { thoughtSignature: 'sig-abc' },
            ],
          },
          {
            role: 'user',
            parts: [{ functionResponse: { name: 'search_quran', response: { summary: 'verses' } } }],
          },
        ] as never,
      })
    );

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.messages).toEqual([
      { role: 'system', content: 'SYS' },
      { role: 'user', content: 'ما حقوق الزوج؟' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_0',
            type: 'function',
            function: { name: 'search_quran', arguments: '{}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call_0', content: '{"summary":"verses"}' },
      { role: 'user', content: 'follow-up' },
    ]);
    // Internal thoughts still never cross.
    expect(JSON.stringify(body.messages)).not.toContain('INTERNAL THOUGHT');
    // Recovery is flagged, no PII (counters only).
    expect(Sentry.addBreadcrumb).toHaveBeenCalledWith(
      expect.objectContaining({
        category: 'inkling',
        message: expect.stringContaining('synthesized assistant tool_call'),
        data: { synthesizedCallCount: 1 },
      })
    );
  });

  it('still fails fast when a functionResponse has no tool name (genuinely unusable history)', async () => {
    fetchMock.mockResolvedValue(sseResponse([delta({ content: 'ok' }, 'stop')]));

    await expect(
      collect(
        streamInkling('q', {
          history: [
            { role: 'user', parts: [{ functionResponse: { response: { x: 1 } } }] },
          ] as never,
        })
      )
    ).rejects.toThrow(/functionResponse in history without a preceding functionCall/);
  });

  it('converts Gemini tool declarations to OpenAI function tools (lowercased types)', async () => {
    fetchMock.mockResolvedValue(sseResponse([delta({ content: 'ok' }, 'stop')]));

    await collect(
      streamInkling('q', {
        tools: [
          {
            functionDeclarations: [
              {
                name: 'search_quran',
                description: 'Search the Quran.',
                parameters: {
                  type: 'OBJECT',
                  properties: { query: { type: 'STRING', description: 'The query.' } },
                  required: ['query'],
                },
              },
            ],
          },
        ] as never,
      })
    );

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.tools).toEqual([
      {
        type: 'function',
        function: {
          name: 'search_quran',
          description: 'Search the Quran.',
          parameters: {
            type: 'object',
            properties: { query: { type: 'string', description: 'The query.' } },
            required: ['query'],
          },
        },
      },
    ]);
  });

  it('requests usage in the stream and maps the final usage-only chunk (#77 regression)', async () => {
    // OpenAI-compat servers emit the usage chunk ONLY when the request sets
    // stream_options.include_usage — without it, token accounting persists
    // zeros for every Inkling-served request (issue #77). The final chunk
    // mirrors the real wire shape: empty choices, usage alongside.
    fetchMock.mockResolvedValue(
      sseResponse([
        delta({ content: 'OK' }, 'stop'),
        {
          choices: [],
          usage: { prompt_tokens: 42, completion_tokens: 5, total_tokens: 47 },
        },
      ])
    );

    const events = await collect(streamInkling('q'));

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.stream_options).toEqual({ include_usage: true });

    expect(doneOf(events).usage).toEqual({
      promptTokenCount: 42,
      candidatesTokenCount: 5,
      thoughtsTokenCount: 0,
      totalTokenCount: 47,
    });
  });

  it('maps finish_reason length → MAX_TOKENS (surfaces the output-cap bug loudly)', async () => {
    fetchMock.mockResolvedValue(sseResponse([delta({ content: 'trunc' }, 'length')]));

    const events = await collect(streamInkling('q'));
    expect(doneOf(events).finishReason).toBe('MAX_TOKENS');
  });

  it('empty completion still yields a done with finishReason (ladder classifies it)', async () => {
    fetchMock.mockResolvedValue(sseResponse([delta({}, 'stop')]));

    const events = await collect(streamInkling('q'));
    const response = doneOf(events);
    expect(response.text).toBe('');
    expect(response.finishReason).toBe('STOP');
    expect(response.rawPayload).toEqual({ role: 'model', parts: [] });
  });

  it('fails fast on non-2xx with status in the error', async () => {
    fetchMock.mockResolvedValue(new Response('capacity exhausted', { status: 429 }));

    await expect(collect(streamInkling('q'))).rejects.toThrow(/HTTP 429/);
  });

  it('fails fast on malformed tool-call JSON arguments', async () => {
    fetchMock.mockResolvedValue(
      sseResponse([
        delta({ tool_calls: [{ index: 0, function: { name: 'search_quran', arguments: '{broken' } }] }),
        delta({}, 'tool_calls'),
      ])
    );

    await expect(collect(streamInkling('q'))).rejects.toThrow(/malformed JSON arguments/);
  });

  describe('truncated-stream detection (issue #2)', () => {
    // The last rung must not ship an incomplete answer marked complete. A legitimate stream
    // ends with the `[DONE]` marker AND/OR a finish_reason; a raw connection cut yields neither.

    it('EOF after partial content with no finish_reason and no [DONE] → truncation error', async () => {
      // Body ends mid-answer: content deltas, then the connection drops. No terminal proof.
      fetchMock.mockResolvedValue(
        rawSseResponse(
          `data: ${JSON.stringify(delta({ content: 'Patience is ' }))}\n\n` +
            `data: ${JSON.stringify(delta({ content: 'a vir' }))}\n\n`
        )
      );

      await expect(collect(streamInkling('q'))).rejects.toThrow(/truncated/i);
    });

    it('a finish_reason WITHOUT a trailing [DONE] is accepted as complete (the "or" branch)', async () => {
      // Some OpenAI-compat servers close the body right after the finish_reason chunk, never
      // emitting `[DONE]`. The finish_reason itself proves completion — this must NOT truncate.
      fetchMock.mockResolvedValue(
        rawSseResponse(
          `data: ${JSON.stringify(delta({ content: 'Complete answer.' }, 'stop'))}\n\n`
        )
      );

      const events = await collect(streamInkling('q'));
      const response = doneOf(events);
      expect(response.text).toBe('Complete answer.');
      expect(response.finishReason).toBe('STOP');
    });

    it('parses a final data line with NO trailing newline (finish_reason not lost)', async () => {
      // The last chunk carries the finish_reason but the body ends without the terminating
      // "\n\n". The buffered-line flush must still parse it, so the stream is proven complete
      // (not falsely truncated) and its content is delivered.
      fetchMock.mockResolvedValue(
        rawSseResponse(`data: ${JSON.stringify(delta({ content: 'No trailing newline.' }, 'stop'))}`)
      );

      const events = await collect(streamInkling('q'));
      const texts = events.filter((e) => e.type === 'text').map((e) => e.data);
      expect(texts.join('')).toBe('No trailing newline.');
      expect(doneOf(events).finishReason).toBe('STOP');
    });

    it('a proper [DONE] terminator with no finish_reason is accepted (not truncated)', async () => {
      // The server declared the stream complete via [DONE] even though no finish_reason chunk
      // arrived — a valid completion. sseResponse appends the [DONE] marker.
      fetchMock.mockResolvedValue(sseResponse([delta({ content: 'Answer.' })]));

      const events = await collect(streamInkling('q'));
      expect(doneOf(events).text).toBe('Answer.');
    });
  });
});
