import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Empty-final-completion handling — issues #60 / #66 / #70.
 *
 * Vertex's degraded-completion family can finish a call with a real finishReason=STOP
 * and zero visible text. Before the fix, runFacilitator yielded a silent empty `done`,
 * which mcp-complete shipped as a 200-with-attribution-footer and the web routes hid as
 * a user-message-with-no-reply thread.
 *
 * The policy (#60 as strengthened by #70, restructured by #79): STOP or
 * MALFORMED_FUNCTION_CALL + degenerate text + no tool calls → bounded retries (nothing
 * was delivered, so re-issuing duplicates nothing — the #42 no-retry-after-finishReason
 * rule protects delivered tokens only). Retry 1 re-issues on the same model; retry 2
 * escalates straight to Inkling off Vertex (#79 dropped the second-Vertex-pool rung —
 * config.gemini.fallbackModel is now only the #45 429 failover inside gemini-client).
 * With Inkling unconfigured (as in this file), the ladder is the single same-model
 * retry. Retries exhausted, or SAFETY / MAX_TOKENS / missing reason → an explicit
 * `error` event, never a silent empty `done`.
 *
 * Mock scaffolding mirrors tests/facilitator-budget.test.ts: streamGemini is stubbed
 * with per-call scripts; the real runFacilitator loop is exercised end to end.
 */

type AnyEvent = { type: string; data?: unknown; response?: unknown };

const h = vi.hoisted(() => ({
  calls: [] as Array<{ message: string; options: Record<string, unknown> }>,
  scripts: [] as Array<() => AsyncGenerator<AnyEvent>>,
  // Mutable per-test model config (issue #70): distinct fallback by default.
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

// A round that completes with a finishReason but NO visible text and NO tool calls —
// the issue #60 failure shape.
function emptyRound(finishReason?: string): () => AsyncGenerator<AnyEvent> {
  return async function* () {
    yield { type: 'done', response: doneResponse('', [], finishReason) };
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

// A round that finishes with a real finishReason and a trivial punctuation-only fragment
// (a lone '}' etc.) as the entire visible text — the issue #66 surviving shape. The #42
// gate opens on the finishReason, so the fragment is streamed just like a tiny real answer;
// it is non-empty, so #60's empty-check would wave it through without this fix.
function fragmentRound(fragment: string, finishReason = 'STOP'): () => AsyncGenerator<AnyEvent> {
  return async function* () {
    if (fragment) yield { type: 'text', data: fragment };
    yield { type: 'done', response: doneResponse(fragment, [], finishReason) };
  };
}

vi.mock('@sentry/nextjs', () => ({
  captureMessage: vi.fn(),
  captureException: vi.fn(),
}));

// agent.ts reads config.gemini lazily in the degenerate-final branch (#70); stub it so
// tests control the primary/fallback pair without real env.
vi.mock('@/lib/config', () => ({
  config: {
    get gemini() {
      return h.gemini;
    },
    // Inkling unset here: the #74 final rung is exercised in
    // tests/facilitator-inkling-rung.test.ts; these tests pin the
    // Gemini-only ladder behavior when the rung is unavailable.
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

beforeEach(() => {
  vi.clearAllMocks();
  h.calls = [];
  h.scripts = [];
  h.gemini = { model: 'primary-model', fallbackModel: 'fallback-model' };
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('empty final completion (issue #60)', () => {
  it('STOP + empty → retried once and the retry answer is delivered', async () => {
    const Sentry = await import('@sentry/nextjs');
    h.scripts = [emptyRound('STOP'), textRound('Recovered answer.')];

    const events = await collect(runFacilitator([userMessage('q')]) as AsyncGenerator<Event>);
    const types = events.map((e) => e.type);

    expect(h.calls).toHaveLength(2); // original + one bounded retry
    expect(types).toContain('done');
    expect(types).not.toContain('error');
    expect(events.filter((e) => e.type === 'text').map((e) => e.data).join('')).toBe('Recovered answer.');
    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      'facilitator empty final completion (retrying)',
      expect.objectContaining({ level: 'warning' })
    );
  });

  it('STOP + empty after tool use (the prod shape) → retried once, answer delivered', async () => {
    h.scripts = [toolRound(['search_quran']), emptyRound('STOP'), textRound('Sabr means patience.')];

    const events = await collect(runFacilitator([userMessage('q')]) as AsyncGenerator<Event>);
    const types = events.map((e) => e.type);

    expect(h.calls).toHaveLength(3); // tool round + empty continuation + retry
    expect(types).toContain('tool_result');
    expect(types).toContain('done');
    expect(types).not.toContain('error');
    expect(events.filter((e) => e.type === 'text').map((e) => e.data).join('')).toBe('Sabr means patience.');
  });

  it('STOP + empty twice → single same-model retry, then explicit error — the distinct fallbackModel is NEVER used (#79)', async () => {
    const Sentry = await import('@sentry/nextjs');
    h.scripts = [emptyRound('STOP'), emptyRound('STOP'), textRound('should never be reached')];

    const events = await collect(runFacilitator([userMessage('q')]) as AsyncGenerator<Event>);
    const types = events.map((e) => e.type);

    expect(h.calls).toHaveLength(2); // strictly bounded: no third Gemini attempt (#79)
    // Both attempts run on the configured primary — no model override, no 3.1-pro rung.
    expect(h.calls[0].options.model).toBeUndefined();
    expect(h.calls[1].options.model).toBeUndefined();
    expect(types).toContain('error');
    expect(types).not.toContain('done');
    expect(events.find((e) => e.type === 'error')?.data).toMatch(/empty answer/i);
    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      'facilitator empty final completion',
      expect.objectContaining({
        level: 'error',
        // The terminal event records the model that produced the last empty final —
        // still the primary: the ladder never touched the fallback pool.
        extra: expect.objectContaining({ model: 'primary-model' }),
      })
    );
  });

  it('post-ladder T2 synthesis runs on the configured primary — no model override (#79)', async () => {
    // A slow empty final burns most of the soft window (150ms); the retry then hangs and
    // is cut past the soft deadline → T2 synthesis. Synthesis carries no per-call model
    // override: the #70 sticky-fallback-model plumbing is gone.
    const slowEmptyRound = (delayMs: number): (() => AsyncGenerator<AnyEvent>) =>
      async function* () {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        yield { type: 'done', response: doneResponse('', [], 'STOP') };
      };
    const slowThrowRound = (delayMs: number): (() => AsyncGenerator<AnyEvent>) =>
      // eslint-disable-next-line require-yield
      async function* () {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        throw new Error('cut at deadline');
      };
    h.scripts = [slowEmptyRound(100), slowThrowRound(100), textRound('Synthesized from context.')];

    const events = await collect(
      runFacilitator([userMessage('q')], undefined, {
        budgetMs: 300,
        reserveMs: 150,
      }) as AsyncGenerator<Event>
    );
    const types = events.map((e) => e.type);

    expect(h.calls).toHaveLength(3);
    // The third call is the synthesis pass (empty message, tools omitted), not a loop
    // retry — and it carries no model override.
    expect(h.calls[2].message).toBe('');
    expect(h.calls[2].options.tools).toBeUndefined();
    expect(h.calls[2].options.model).toBeUndefined();
    expect(types).toContain('done');
    expect(types).not.toContain('error');
    expect(events.filter((e) => e.type === 'text').map((e) => e.data).join('')).toBe(
      'Synthesized from context.'
    );
  });

  it('MALFORMED_FUNCTION_CALL + empty → retried like STOP, recovery answer delivered (#70)', async () => {
    const Sentry = await import('@sentry/nextjs');
    h.scripts = [emptyRound('MALFORMED_FUNCTION_CALL'), textRound('Recovered answer.')];

    const events = await collect(runFacilitator([userMessage('q')]) as AsyncGenerator<Event>);
    const types = events.map((e) => e.type);

    expect(h.calls).toHaveLength(2);
    expect(types).toContain('done');
    expect(types).not.toContain('error');
    expect(events.filter((e) => e.type === 'text').map((e) => e.data).join('')).toBe('Recovered answer.');
    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      'facilitator empty final completion (retrying)',
      expect.objectContaining({
        extra: expect.objectContaining({ finishReason: 'MALFORMED_FUNCTION_CALL' }),
      })
    );
  });

  it('MALFORMED_FUNCTION_CALL exhausts the same ladder: one same-model retry, then error (#79)', async () => {
    h.scripts = [
      emptyRound('MALFORMED_FUNCTION_CALL'),
      emptyRound('MALFORMED_FUNCTION_CALL'),
      textRound('should never be reached'),
    ];

    const events = await collect(runFacilitator([userMessage('q')]) as AsyncGenerator<Event>);
    const types = events.map((e) => e.type);

    expect(h.calls).toHaveLength(2);
    expect(h.calls[1].options.model).toBeUndefined();
    expect(types).toContain('error');
    expect(types).not.toContain('done');
  });

  it('SAFETY + empty → immediate blocked error, no retry', async () => {
    h.scripts = [emptyRound('SAFETY')];

    const events = await collect(runFacilitator([userMessage('q')]) as AsyncGenerator<Event>);
    const types = events.map((e) => e.type);

    expect(h.calls).toHaveLength(1); // a retry would likely re-block
    expect(types).toContain('error');
    expect(types).not.toContain('done');
    expect(events.find((e) => e.type === 'error')?.data).toMatch(/blocked/i);
  });

  it('MAX_TOKENS + empty → immediate loud error, no retry (config bug, issue #51)', async () => {
    const Sentry = await import('@sentry/nextjs');
    h.scripts = [emptyRound('MAX_TOKENS')];

    const events = await collect(runFacilitator([userMessage('q')]) as AsyncGenerator<Event>);
    const types = events.map((e) => e.type);

    expect(h.calls).toHaveLength(1);
    expect(types).toContain('error');
    expect(types).not.toContain('done');
    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      'facilitator empty final completion',
      expect.objectContaining({
        level: 'error',
        extra: expect.objectContaining({ finishReason: 'MAX_TOKENS' }),
      })
    );
  });

  it('normal non-empty answer is unaffected (single call, no retry, no logging)', async () => {
    const Sentry = await import('@sentry/nextjs');
    h.scripts = [textRound('A normal answer.')];

    const events = await collect(runFacilitator([userMessage('q')]) as AsyncGenerator<Event>);
    const types = events.map((e) => e.type);

    expect(h.calls).toHaveLength(1);
    expect(types).toContain('done');
    expect(types).not.toContain('error');
    expect(Sentry.captureMessage).not.toHaveBeenCalled();
  });
});

describe('user question survives a first-call retry into history (issue #2)', () => {
  // Regression for the `iterations === 1` history guard: a degenerate FIRST call is retried at
  // iterations === 2 (the retry does `continue` after `iterations++`). If that retry then
  // requests a tool, the old guard (`iterations === 1`) was already false, so the user's
  // question was never pushed into geminiHistory — every continuation asked the model to answer
  // a question it had never seen. The guard is now `!userMessageInHistory`.
  function historyTexts(history: unknown): string[] {
    if (!Array.isArray(history)) return [];
    const texts: string[] = [];
    for (const content of history as Array<{ role?: string; parts?: Array<{ text?: string }> }>) {
      if (content.role !== 'user') continue;
      for (const part of content.parts ?? []) {
        if (typeof part.text === 'string') texts.push(part.text);
      }
    }
    return texts;
  }

  it('empty first call → tool retry: the continuation history contains the user query', async () => {
    // [empty first call] → [tool round at iterations===2] → [final answer]. The old bug dropped
    // the user query from the history sent on the continuation call.
    h.scripts = [emptyRound('STOP'), toolRound(['search_quran']), textRound('Sabr means patience.')];

    const events = await collect(
      runFacilitator([userMessage('What is sabr?')]) as AsyncGenerator<Event>
    );
    const types = events.map((e) => e.type);

    expect(h.calls).toHaveLength(3); // empty + tool round + continuation
    expect(types).toContain('tool_result');
    expect(types).toContain('done');
    expect(types).not.toContain('error');

    // The continuation call (after the tool round) MUST carry the user's question in history.
    const continuationHistory = h.calls[2].options.history;
    expect(historyTexts(continuationHistory)).toContain('What is sabr?');
    // And it must appear exactly once — not duplicated by a double push.
    expect(historyTexts(continuationHistory).filter((t) => t === 'What is sabr?')).toHaveLength(1);

    expect(events.filter((e) => e.type === 'text').map((e) => e.data).join('')).toBe(
      'Sabr means patience.'
    );
  });

  it('the normal first-call tool round still records the user query exactly once', async () => {
    // Guards against a double-push regression on the healthy path (no leading empty round).
    h.scripts = [toolRound(['search_quran']), textRound('Answer.')];

    await collect(runFacilitator([userMessage('What is zakat?')]) as AsyncGenerator<Event>);

    expect(h.calls).toHaveLength(2);
    const continuationHistory = h.calls[1].options.history;
    expect(historyTexts(continuationHistory).filter((t) => t === 'What is zakat?')).toHaveLength(1);
  });
});

describe('degenerate fragment final completion (issue #66)', () => {
  it('STOP + lone "}" → retried once and the retry answer is delivered', async () => {
    const Sentry = await import('@sentry/nextjs');
    h.scripts = [fragmentRound('}'), textRound('Recovered answer.')];

    const events = await collect(runFacilitator([userMessage('q')]) as AsyncGenerator<Event>);
    const types = events.map((e) => e.type);

    expect(h.calls).toHaveLength(2); // original + one bounded retry
    expect(types).toContain('done');
    expect(types).not.toContain('error');
    // EXACT output: the stray "}" is suppressed by the live-emission gate, so a successful
    // retry delivers ONLY the clean answer — not "}Recovered answer." (issue #66 / CMAP).
    expect(events.filter((e) => e.type === 'text').map((e) => e.data).join('')).toBe(
      'Recovered answer.'
    );
    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      'facilitator empty final completion (retrying)',
      expect.objectContaining({ extra: expect.objectContaining({ degenerateKind: 'fragment' }) })
    );
  });

  it('STOP + "}" twice → explicit error, never shipped as a done (the #66 core regression)', async () => {
    const Sentry = await import('@sentry/nextjs');
    h.scripts = [fragmentRound('}'), fragmentRound('}'), fragmentRound('}')];

    const events = await collect(runFacilitator([userMessage('q')]) as AsyncGenerator<Event>);
    const types = events.map((e) => e.type);

    expect(h.calls).toHaveLength(2); // strictly bounded (#79 ladder): no third Gemini attempt
    expect(h.calls[1].options.model).toBeUndefined();
    expect(types).toContain('error');
    expect(types).not.toContain('done');
    // The fragment is never emitted, so nothing degenerate reaches/persists on any surface.
    expect(events.filter((e) => e.type === 'text').map((e) => e.data).join('')).toBe('');
    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      'facilitator empty final completion',
      expect.objectContaining({
        level: 'error',
        extra: expect.objectContaining({ degenerateKind: 'fragment', fragmentLength: 1 }),
      })
    );
  });

  it('STOP + "}" after tool use (the prod shape) → retried once, real answer delivered', async () => {
    h.scripts = [toolRound(['search_quran']), fragmentRound('}'), textRound('Sabr means patience.')];

    const events = await collect(runFacilitator([userMessage('q')]) as AsyncGenerator<Event>);
    const types = events.map((e) => e.type);

    expect(h.calls).toHaveLength(3); // tool round + fragment continuation + retry
    expect(types).toContain('tool_result');
    expect(types).toContain('done');
    expect(types).not.toContain('error');
    // EXACT output: the mid-turn "}" fragment is suppressed; only the clean retry answer ships.
    expect(events.filter((e) => e.type === 'text').map((e) => e.data).join('')).toBe(
      'Sabr means patience.'
    );
  });

  it('a real answer that STARTS with punctuation streams in full (gate flushes, no over-suppression)', async () => {
    // First chunk is punctuation-only (held by the gate); once letters arrive the gate opens
    // and flushes the buffered prefix, so the complete answer is delivered byte-for-byte.
    const punctThenText = (): AsyncGenerator<AnyEvent> =>
      (async function* () {
        yield { type: 'text', data: '**' };
        yield { type: 'text', data: 'Yes' };
        yield { type: 'text', data: '**, permitted.' };
        yield { type: 'done', response: doneResponse('**Yes**, permitted.', [], 'STOP') };
      })();
    h.scripts = [punctThenText];

    const events = await collect(runFacilitator([userMessage('q')]) as AsyncGenerator<Event>);
    const types = events.map((e) => e.type);

    expect(h.calls).toHaveLength(1); // real answer → no retry
    expect(types).toContain('done');
    expect(types).not.toContain('error');
    expect(events.filter((e) => e.type === 'text').map((e) => e.data).join('')).toBe(
      '**Yes**, permitted.'
    );
  });

  it('other bracket/punctuation fragments ("]", "].", "{}") are all treated as degenerate', async () => {
    for (const frag of [']', '].', '{}', '. }']) {
      vi.clearAllMocks();
      h.calls = [];
      h.scripts = [fragmentRound(frag), fragmentRound(frag), fragmentRound(frag)];

      const events = await collect(runFacilitator([userMessage('q')]) as AsyncGenerator<Event>);
      const types = events.map((e) => e.type);

      expect(h.calls, `fragment ${JSON.stringify(frag)}`).toHaveLength(2);
      expect(types, `fragment ${JSON.stringify(frag)}`).toContain('error');
      expect(types, `fragment ${JSON.stringify(frag)}`).not.toContain('done');
    }
  });

  it('MAX_TOKENS + "}" → immediate error, no retry (non-STOP fragment, like empty)', async () => {
    h.scripts = [fragmentRound('}', 'MAX_TOKENS')];

    const events = await collect(runFacilitator([userMessage('q')]) as AsyncGenerator<Event>);
    const types = events.map((e) => e.type);

    expect(h.calls).toHaveLength(1); // non-STOP is not retried
    expect(types).toContain('error');
    expect(types).not.toContain('done');
  });

  // False-positive guard (issue #66 care point): legitimate ultra-short answers contain a
  // letter or number in SOME script, so they must ship untouched — never retried, never errored.
  it.each(['Yes.', 'No.', 'لا', 'نعم', '42', '3.14', 'A', '١٢٣'])(
    'legitimate short answer %j ships normally (no retry, no error, no logging)',
    async (answer) => {
      const Sentry = await import('@sentry/nextjs');
      h.scripts = [textRound(answer)];

      const events = await collect(runFacilitator([userMessage('q')]) as AsyncGenerator<Event>);
      const types = events.map((e) => e.type);

      expect(h.calls).toHaveLength(1);
      expect(types).toContain('done');
      expect(types).not.toContain('error');
      expect(events.filter((e) => e.type === 'text').map((e) => e.data).join('')).toBe(answer);
      expect(Sentry.captureMessage).not.toHaveBeenCalled();
    }
  );
});
