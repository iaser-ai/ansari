import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Empty-final-completion handling — issue #60.
 *
 * Vertex's degraded-completion family can finish a call with a real finishReason=STOP
 * and zero visible text. Before the fix, runFacilitator yielded a silent empty `done`,
 * which mcp-complete shipped as a 200-with-attribution-footer and the web routes hid as
 * a user-message-with-no-reply thread.
 *
 * The fix: STOP + empty + no tool calls → ONE bounded retry (nothing was delivered, so
 * re-issuing duplicates nothing — the #42 no-retry-after-finishReason rule protects
 * delivered tokens only). Retry exhausted, or SAFETY / MAX_TOKENS / missing reason →
 * an explicit `error` event, never a silent empty `done`.
 *
 * Mock scaffolding mirrors tests/facilitator-budget.test.ts: streamGemini is stubbed
 * with per-call scripts; the real runFacilitator loop is exercised end to end.
 */

type AnyEvent = { type: string; data?: unknown; response?: unknown };

const h = vi.hoisted(() => ({
  calls: [] as Array<{ message: string; options: Record<string, unknown> }>,
  scripts: [] as Array<() => AsyncGenerator<AnyEvent>>,
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

  it('STOP + empty twice → explicit error event, never a silent empty done', async () => {
    const Sentry = await import('@sentry/nextjs');
    h.scripts = [emptyRound('STOP'), emptyRound('STOP')];

    const events = await collect(runFacilitator([userMessage('q')]) as AsyncGenerator<Event>);
    const types = events.map((e) => e.type);

    expect(h.calls).toHaveLength(2); // strictly bounded: no third attempt
    expect(types).toContain('error');
    expect(types).not.toContain('done');
    expect(events.find((e) => e.type === 'error')?.data).toMatch(/empty answer/i);
    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      'facilitator empty final completion',
      expect.objectContaining({ level: 'error' })
    );
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
    h.scripts = [fragmentRound('}'), fragmentRound('}')];

    const events = await collect(runFacilitator([userMessage('q')]) as AsyncGenerator<Event>);
    const types = events.map((e) => e.type);

    expect(h.calls).toHaveLength(2); // strictly bounded: no third attempt
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
      h.scripts = [fragmentRound(frag), fragmentRound(frag)];

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
