import { describe, it, expect, vi, beforeEach } from 'vitest';
import { unavailableResult } from '../lib/tools/resilience';

/**
 * End-to-end (Spec 43): a degraded search tool must never make `runFacilitator`
 * emit an `error` event or hang — it always continues and terminates with `done`.
 * We stub the Gemini stream (one tool-call round, then a text round) and the tool
 * map so we can drive degraded/throwing tools deterministically.
 */

const h = vi.hoisted(() => ({
  streamCalls: 0,
  toolNames: ['search_mawsuah'] as string[],
  toolBehavior: 'degrade' as 'degrade' | 'throw',
}));

vi.mock('@sentry/nextjs', () => ({
  captureMessage: vi.fn(),
  captureException: vi.fn(),
}));

vi.mock('@/lib/ai/gemini-client', () => ({
  streamGemini: vi.fn(() => {
    const call = h.streamCalls++;
    async function* gen() {
      if (call === 0) {
        // First round: the model asks to use one or more tools.
        for (const name of h.toolNames) {
          yield { type: 'tool_call', data: { name, args: { query: 'masakin' } } };
        }
        yield {
          type: 'done',
          response: {
            text: '',
            toolCalls: h.toolNames.map((name) => ({ name, args: { query: 'masakin' } })),
            rawPayload: { role: 'model', parts: [] },
            allParts: [],
            hasThinking: false,
            usage: { promptTokenCount: 1, candidatesTokenCount: 0, thoughtsTokenCount: 0, totalTokenCount: 1 },
          },
        };
      } else {
        // Continuation: the model produces a best-effort answer from what it has.
        yield { type: 'text', data: 'Best-effort answer despite unavailable sources.' };
        yield {
          type: 'done',
          response: {
            text: 'Best-effort answer despite unavailable sources.',
            toolCalls: [],
            rawPayload: { role: 'model', parts: [{ text: 'Best-effort answer despite unavailable sources.' }] },
            allParts: [{ text: 'Best-effort answer despite unavailable sources.' }],
            hasThinking: false,
            usage: { promptTokenCount: 1, candidatesTokenCount: 5, thoughtsTokenCount: 0, totalTokenCount: 6 },
          },
        };
      }
    }
    return gen();
  }),
}));

vi.mock('@/lib/tools', () => ({
  getGeminiToolDescriptions: () => [],
  createToolMap: () => {
    const make = (name: string) => ({
      getToolName: () => name,
      getToolDescription: () => ({
        name,
        description: '',
        input_schema: { type: 'object', properties: {}, required: [] },
      }),
      run: async () => {
        if (h.toolBehavior === 'throw') {
          throw new Error('simulated tool crash');
        }
        return unavailableResult(name);
      },
    });
    return new Map(
      ['search_quran', 'search_hadith', 'search_mawsuah', 'search_tafsir_encyclopedia'].map((n) => [
        n,
        make(n),
      ]),
    );
  },
}));

// Import AFTER mocks so the SUT picks up the mocked modules.
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
  h.streamCalls = 0;
  h.toolNames = ['search_mawsuah'];
  h.toolBehavior = 'degrade';
  vi.clearAllMocks();
});

describe('runFacilitator graceful degradation (Spec 43)', () => {
  it('continues and answers when a single tool degrades (no error, ends with done)', async () => {
    h.toolNames = ['search_mawsuah'];

    const events = await collect(runFacilitator([userMessage('hukm al-masakin')]) as AsyncGenerator<Event>);
    const types = events.map((e) => e.type);

    expect(types).not.toContain('error');
    expect(types).toContain('done');
    const text = events.filter((e) => e.type === 'text').map((e) => e.data).join('');
    expect(text).toMatch(/best-effort answer/i);
  });

  it('does not error or hang when ALL four tools are unavailable in one turn', async () => {
    h.toolNames = ['search_quran', 'search_hadith', 'search_mawsuah', 'search_tafsir_encyclopedia'];

    const events = await collect(runFacilitator([userMessage('comprehensive fiqh question')]) as AsyncGenerator<Event>);
    const types = events.map((e) => e.type);

    expect(types).not.toContain('error');
    expect(types).toContain('done');
    // All four tool calls were processed (none threw / crashed the loop).
    expect(events.filter((e) => e.type === 'tool_result')).toHaveLength(4);
  });

  it('backstop converts a throwing tool into a degraded result (no error event)', async () => {
    const Sentry = await import('@sentry/nextjs');
    h.toolNames = ['search_mawsuah'];
    h.toolBehavior = 'throw';

    const events = await collect(runFacilitator([userMessage('hukm question')]) as AsyncGenerator<Event>);
    const types = events.map((e) => e.type);

    expect(types).not.toContain('error');
    expect(types).toContain('done');
    // The backstop reported the degraded event (NON-PII) to Sentry.
    expect(Sentry.captureMessage).toHaveBeenCalled();
  });
});
