import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Plain message when a prompt is too large for a model — issue #400.
 *
 * A model that refuses a request because the prompt exceeds its limit used to
 * reach the user as the provider's own text (Gemini's "input token count
 * exceeds…", or Inkling's "[inkling] provider error in stream — …exceeds the
 * model's context window…" on a rescue of a thread it cannot fit). The
 * facilitator's terminal error now says it in plain words; the provider's text
 * goes to the log and Sentry only. Any other error keeps its own text.
 *
 * Mock scaffolding mirrors tests/facilitator-inkling-rung.test.ts.
 */

type AnyEvent = { type: string; data?: unknown; response?: unknown };

const h = vi.hoisted(() => ({
  scripts: [] as Array<() => AsyncGenerator<AnyEvent>>,
  inklingScripts: [] as Array<() => AsyncGenerator<AnyEvent>>,
  inklingCalls: 0,
  inklingConfigured: true,
}));

function errorRound(message: string): () => AsyncGenerator<AnyEvent> {
  // eslint-disable-next-line require-yield
  return async function* () {
    throw new Error(message);
  };
}

vi.mock('@sentry/nextjs', () => ({
  captureMessage: vi.fn(),
  captureException: vi.fn(),
  addBreadcrumb: vi.fn(),
}));

vi.mock('@/lib/config', () => ({
  config: {
    get primaryBackend() {
      return 'gemini';
    },
    get gemini() {
      return { model: 'primary-model', fallbackModel: 'fallback-model' };
    },
    get inkling() {
      return { model: 'thinkingmachines/Inkling', timeoutMs: 180000 };
    },
  },
}));

vi.mock('@/lib/ai/gemini-client', () => ({
  streamGemini: vi.fn(() => {
    const script = h.scripts.shift();
    if (!script) throw new Error('test: no Gemini script left');
    return script();
  }),
}));

vi.mock('@/lib/ai/inkling-client', () => ({
  isInklingConfigured: vi.fn(() => h.inklingConfigured),
  streamInkling: vi.fn(() => {
    h.inklingCalls++;
    const script = h.inklingScripts.shift();
    if (!script) throw new Error('test: no Inkling script left');
    return script();
  }),
}));

vi.mock('@/lib/ai/prompts/facilitator', () => ({
  FACILITATOR_SYSTEM_PROMPT: 'BASE_PROMPT',
  TOOL_CONTINUATION_DIRECTIVE: 'CONTINUATION_DIRECTIVE',
}));

vi.mock('@/lib/tools', () => ({
  getGeminiToolDescriptions: () => [{ name: 'search_quran' }],
  createToolMap: () => new Map(),
}));

// Import AFTER mocks.
import * as Sentry from '@sentry/nextjs';
import {
  runFacilitator,
  userFacingModelError,
  PROMPT_TOO_LARGE_MESSAGE,
  type Message,
} from '../lib/facilitator/agent';

type Event = { type: string; data?: string };

async function terminalError(): Promise<string | undefined> {
  const history: Message[] = [{ role: 'user', content: [{ type: 'text', text: 'q' }] }];
  const events: Event[] = [];
  for await (const e of runFacilitator(history) as AsyncGenerator<Event>) events.push(e);
  expect(events.map((e) => e.type)).toEqual(['error']);
  return events[0].data;
}

// The Gemini refusal is the wording issue #399's investigation quotes from production
// (codev/state/bugfix-399_thread.md); the full error text is not on record there. The
// Inkling one is the frame Tinker returned for a prompt over its window, as
// inkling-client surfaces it (PR #401).
const GEMINI_REFUSAL = 'input token count exceeds the maximum number of tokens allowed 1048576';
const INKLING_REFUSAL =
  "[inkling] provider error in stream — invalid_request_error: Prompt length plus max_tokens exceeds the model's context window: 72453 prompt tokens + 8192 max_tokens > 65536.";

beforeEach(() => {
  vi.clearAllMocks();
  h.scripts = [];
  h.inklingScripts = [];
  h.inklingCalls = 0;
  h.inklingConfigured = true;
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('userFacingModelError', () => {
  it('recognises each provider wording of a prompt over the limit', () => {
    for (const refusal of [
      GEMINI_REFUSAL,
      // Wrapped in an API error body, and with the counts in brackets: forms the same
      // refusal could take, accepted so a reworded envelope does not bring the raw text back.
      `{"error":{"code":400,"message":"The ${GEMINI_REFUSAL}.","status":"INVALID_ARGUMENT"}}`,
      'The input token count (1203456) exceeds the maximum number of tokens allowed (1048576).',
      INKLING_REFUSAL,
    ]) {
      expect(userFacingModelError(new Error(refusal)), refusal).toBe(PROMPT_TOO_LARGE_MESSAGE);
    }
  });

  it('leaves every other error with its own text', () => {
    for (const other of [
      'No response from Gemini for 60s - possible hang',
      'ApiError: 429 dual-pool exhausted',
      '[inkling] stream ended before completion ([DONE] or finish_reason) — truncated after 0 chars',
      '[inkling] HTTP 500: upstream error',
      // Near-misses: a limit on something else, and a count that does not exceed anything.
      'The output token count exceeds the maximum number of tokens allowed 8192.',
      'input token count: 1200',
      "The model's context window is 65536 tokens.",
    ]) {
      expect(userFacingModelError(new Error(other)), other).toBe(other);
    }
    expect(userFacingModelError('not an Error')).toBe('Unknown error');
  });

  it('the plain message names no provider, model or token count', () => {
    expect(PROMPT_TOO_LARGE_MESSAGE).not.toMatch(/gemini|inkling|token|\d/i);
  });
});

describe('runFacilitator: a prompt too large for the model', () => {
  it('Gemini refuses and no rescue is configured → the plain message; the provider text is logged, not shown', async () => {
    h.inklingConfigured = false;
    h.scripts = [errorRound(GEMINI_REFUSAL)];

    expect(await terminalError()).toBe(PROMPT_TOO_LARGE_MESSAGE);
    const logged = vi.mocked(console.error).mock.calls.find(([label]) => label === 'Facilitator error:');
    expect((logged?.[1] as Error).message).toBe(GEMINI_REFUSAL);
    expect(Sentry.captureException).toHaveBeenCalledWith(expect.objectContaining({ message: GEMINI_REFUSAL }));
  });

  it('Gemini hangs, the Inkling rescue cannot fit the thread → the plain message', async () => {
    h.scripts = [errorRound('No response from Gemini for 60s - possible hang')];
    h.inklingScripts = [errorRound(INKLING_REFUSAL)];

    expect(await terminalError()).toBe(PROMPT_TOO_LARGE_MESSAGE);
    expect(h.inklingCalls).toBe(1);
    expect(Sentry.captureException).toHaveBeenCalledWith(expect.objectContaining({ message: INKLING_REFUSAL }));
  });

  it('Gemini refuses, then the rescue refuses too → the plain message', async () => {
    h.scripts = [errorRound(GEMINI_REFUSAL)];
    h.inklingScripts = [errorRound(INKLING_REFUSAL)];

    expect(await terminalError()).toBe(PROMPT_TOO_LARGE_MESSAGE);
  });

  it('any other terminal error still surfaces with its own text', async () => {
    h.inklingConfigured = false;
    h.scripts = [errorRound('Vertex returned HTML instead of JSON')];

    expect(await terminalError()).toBe('Vertex returned HTML instead of JSON');
  });
});
