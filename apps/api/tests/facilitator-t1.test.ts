import { describe, it, expect, vi, beforeEach } from 'vitest';
import { unavailableResult } from '../lib/tools/resilience';

/**
 * T1 fail-fast degraded-count trigger — Phase 3 (Spec 49). Once >= 2 tool calls in a request
 * return #54's degraded ("temporarily unavailable") result, runFacilitator stops gathering and
 * runs the synthesis pass — WITHOUT waiting for the 120s wall-clock backstop (T2). Detection is
 * via the machine-readable `isDegraded` marker (#54), not string-matching.
 *
 * We stub `streamGemini` (per-call scripts) and the tool map (per-tool behavior). Degraded tools
 * return the real `unavailableResult` (carries isDegraded: true); "throw" tools exercise
 * processToolCall's backstop, which ALSO returns unavailableResult — so both paths count.
 */

type AnyEvent = { type: string; data?: unknown; response?: unknown };

const h = vi.hoisted(() => ({
  scripts: [] as Array<() => AsyncGenerator<AnyEvent>>,
  behavior: {} as Record<string, 'degrade' | 'throw' | 'ok'>,
}));

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

function toolRound(names: string[]): () => AsyncGenerator<AnyEvent> {
  return async function* () {
    for (const name of names) {
      yield { type: 'tool_call', data: { name, args: { query: 'q' } } };
    }
    yield { type: 'done', response: doneResponse('', names.map((name) => ({ name, args: { query: 'q' } }))) };
  };
}

function textRound(text: string): () => AsyncGenerator<AnyEvent> {
  return async function* () {
    if (text) yield { type: 'text', data: text };
    yield { type: 'done', response: doneResponse(text) };
  };
}

vi.mock('@sentry/nextjs', () => ({
  captureMessage: vi.fn(),
  captureException: vi.fn(),
}));

// The agent now consults config.primaryBackend at request start (issue #95);
// these suites run without env vars, so the real config would throw on access.
vi.mock('@/lib/config', () => ({
  config: {
    get primaryBackend() {
      return 'gemini';
    },
    get gemini() {
      return { model: 'primary-model', fallbackModel: 'fallback-model' };
    },
  },
}));


vi.mock('@/lib/ai/gemini-client', () => ({
  streamGemini: vi.fn(() => {
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
      run: async () => {
        const b = h.behavior[name] ?? 'degrade';
        if (b === 'throw') throw new Error(`simulated ${name} crash`);
        if (b === 'ok') {
          return {
            content: `real result for ${name}`,
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
        }
        return unavailableResult(name); // degraded — carries isDegraded: true (#54)
      },
    });
    return new Map(
      ['search_quran', 'search_hadith', 'search_mawsuah', 'search_tafsir_encyclopedia'].map((n) => [n, make(n)]),
    );
  },
}));

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
  h.scripts = [];
  h.behavior = {};
  vi.clearAllMocks();
});

describe('runFacilitator T1 fail-fast on degradation — Phase 3 (Spec 49)', () => {
  it('>=2 degraded tools in one round → synthesizes fast, without waiting for the wall clock', async () => {
    const Sentry = await import('@sentry/nextjs');
    h.behavior = { search_quran: 'degrade', search_hadith: 'degrade' };
    h.scripts = [toolRound(['search_quran', 'search_hadith']), textRound('Best-effort synthesis.')];

    const start = Date.now();
    // Default budget (120s) → if T1 did not fire, this could not exit quickly.
    const events = await collect(runFacilitator([userMessage('q')]) as AsyncGenerator<Event>);
    const elapsed = Date.now() - start;
    const types = events.map((e) => e.type);

    expect(types).toContain('done');
    expect(types).not.toContain('error');
    expect(events.filter((e) => e.type === 'text').map((e) => e.data).join('')).toBe('Best-effort synthesis.');
    expect(elapsed).toBeLessThan(2000); // exited on degradation, not the 120s clock

    expect(Sentry.captureMessage).toHaveBeenCalledTimes(1);
    const extra = (Sentry.captureMessage as ReturnType<typeof vi.fn>).mock.calls[0][1].extra;
    expect(extra.trigger).toBe('T1');
    expect(extra.degradedCount).toBe(2);
  });

  it('1 degraded + 1 healthy → does NOT trigger T1 (continues to a normal answer)', async () => {
    const Sentry = await import('@sentry/nextjs');
    h.behavior = { search_quran: 'degrade', search_hadith: 'ok' };
    h.scripts = [toolRound(['search_quran', 'search_hadith']), textRound('Normal final answer.')];

    const events = await collect(runFacilitator([userMessage('q')]) as AsyncGenerator<Event>);
    const types = events.map((e) => e.type);

    expect(types).toContain('done');
    expect(events.filter((e) => e.type === 'text').map((e) => e.data).join('')).toBe('Normal final answer.');
    expect(events.filter((e) => e.type === 'tool_result')).toHaveLength(2);
    expect(Sentry.captureMessage).not.toHaveBeenCalled(); // no short-circuit
  });

  it('degraded count is cumulative ACROSS iterations (1 + 1 → T1 on the second round)', async () => {
    const Sentry = await import('@sentry/nextjs');
    h.behavior = { search_quran: 'degrade', search_hadith: 'degrade' };
    h.scripts = [toolRound(['search_quran']), toolRound(['search_hadith']), textRound('Synth after two rounds.')];

    const events = await collect(runFacilitator([userMessage('q')]) as AsyncGenerator<Event>);
    const types = events.map((e) => e.type);

    expect(types).toContain('done');
    expect(events.filter((e) => e.type === 'text').map((e) => e.data).join('')).toBe('Synth after two rounds.');
    expect(Sentry.captureMessage).toHaveBeenCalledTimes(1);
    expect((Sentry.captureMessage as ReturnType<typeof vi.fn>).mock.calls[0][1].extra.trigger).toBe('T1');
  });

  it('repeated degraded calls to the SAME tool count toward the threshold', async () => {
    const Sentry = await import('@sentry/nextjs');
    h.behavior = { search_quran: 'degrade' };
    h.scripts = [toolRound(['search_quran', 'search_quran']), textRound('Synth.')];

    const events = await collect(runFacilitator([userMessage('q')]) as AsyncGenerator<Event>);

    expect(events.map((e) => e.type)).toContain('done');
    expect(Sentry.captureMessage).toHaveBeenCalledTimes(1);
    expect((Sentry.captureMessage as ReturnType<typeof vi.fn>).mock.calls[0][1].extra.trigger).toBe('T1');
  });

  it('a tool that THROWS counts the same as a degraded return (backstop path)', async () => {
    const Sentry = await import('@sentry/nextjs');
    h.behavior = { search_quran: 'throw', search_hadith: 'degrade' };
    h.scripts = [toolRound(['search_quran', 'search_hadith']), textRound('Synth after backstop.')];

    const events = await collect(runFacilitator([userMessage('q')]) as AsyncGenerator<Event>);
    const types = events.map((e) => e.type);

    expect(types).toContain('done');
    expect(types).not.toContain('error'); // backstop degrades, never crashes the loop
    // The backstop's reportDegradedTool ALSO logs to Sentry, so find the short-circuit call.
    const calls = (Sentry.captureMessage as ReturnType<typeof vi.fn>).mock.calls;
    const shortCircuit = calls.find((c) => String(c[0]).includes('short-circuit'));
    expect(shortCircuit).toBeDefined();
    expect(shortCircuit![1].extra.trigger).toBe('T1');
  });

  it('a healthy result between two degraded ones does not reset the count (degrade, ok, degrade → T1)', async () => {
    const Sentry = await import('@sentry/nextjs');
    h.behavior = { search_quran: 'degrade', search_hadith: 'ok', search_mawsuah: 'degrade' };
    h.scripts = [toolRound(['search_quran', 'search_hadith', 'search_mawsuah']), textRound('Synth.')];

    const events = await collect(runFacilitator([userMessage('q')]) as AsyncGenerator<Event>);

    expect(events.map((e) => e.type)).toContain('done');
    expect(Sentry.captureMessage).toHaveBeenCalledTimes(1);
    const extra = (Sentry.captureMessage as ReturnType<typeof vi.fn>).mock.calls[0][1].extra;
    expect(extra.trigger).toBe('T1');
    expect(extra.degradedCount).toBe(2);
  });
});
