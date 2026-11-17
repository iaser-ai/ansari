import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resetEnvCache } from '@/lib/config';
import type { FacilitatorStreamEvent, Message } from '@/lib/facilitator/agent';
import {
  assessHistory,
  estimateHistoryTokens,
  limitThreadTurn,
  BYTES_PER_TOKEN,
  HISTORY_BLOCK_MESSAGE,
  HISTORY_WARNING_MESSAGE,
} from '@/lib/facilitator/history-limit';

/**
 * Thread history limits — issue #400.
 *
 * The size of a thread is estimated from the text a turn would send (UTF-8 bytes
 * over BYTES_PER_TOKEN), never read from a stored token count. From the warn
 * threshold an answer opens with a notice; from the block threshold the notice is
 * the answer and no model runs. The real config schema is used throughout.
 */

const user = (text: string): Message => ({ role: 'user', content: [{ type: 'text', text }] });
const assistant = (text: string): Message => ({ role: 'assistant', content: [{ type: 'text', text }] });

/** A user message whose estimate is exactly `tokens`. */
const userOfTokens = (tokens: number): Message => user('a'.repeat(tokens * BYTES_PER_TOKEN));

async function collect(turn: AsyncGenerator<FacilitatorStreamEvent>): Promise<FacilitatorStreamEvent[]> {
  const events: FacilitatorStreamEvent[] = [];
  for await (const event of turn) events.push(event);
  return events;
}

function setThresholds(warn: number, block: number): void {
  vi.stubEnv('THREAD_HISTORY_WARN_TOKENS', String(warn));
  vi.stubEnv('THREAD_HISTORY_BLOCK_TOKENS', String(block));
  resetEnvCache();
}

beforeEach(() => {
  resetEnvCache();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  resetEnvCache();
});

describe('estimateHistoryTokens', () => {
  it('is the UTF-8 bytes of the text over 4, rounded up', () => {
    expect(BYTES_PER_TOKEN).toBe(4);
    expect(estimateHistoryTokens([user('a'.repeat(400))])).toBe(100);
    expect(estimateHistoryTokens([user('abcde')])).toBe(2);
    expect(estimateHistoryTokens([])).toBe(0);
  });

  it('counts bytes, not characters: Arabic weighs twice its length', () => {
    const arabic = 'سلام'; // 4 characters, 8 bytes
    expect(arabic).toHaveLength(4);
    expect(estimateHistoryTokens([user(arabic.repeat(100))])).toBe(200);
    expect(estimateHistoryTokens([user('salam'.repeat(80) + arabic.repeat(100))])).toBe(300);
  });

  it('sums every message of the thread, the newest included', () => {
    const thread = [user('a'.repeat(400)), assistant('b'.repeat(800)), user('c'.repeat(40))];
    expect(estimateHistoryTokens(thread)).toBe(310);
  });

  it('measures what is replayed: the stored payload when there is one, the text when there is none', () => {
    const withPayload: Message = {
      role: 'assistant',
      content: [{ type: 'text', text: 'x'.repeat(4000) }],
      rawPayload: { role: 'model', parts: [{ text: 'y'.repeat(400) }, { text: 'z'.repeat(400) }] },
    };
    expect(estimateHistoryTokens([withPayload])).toBe(200);
    expect(estimateHistoryTokens([{ ...withPayload, rawPayload: null }])).toBe(1000);
  });

  it('does not count a thoughtSignature', () => {
    const signed: Message = {
      role: 'assistant',
      content: [{ type: 'text', text: 'answer' }],
      rawPayload: {
        role: 'model',
        parts: [{ text: 'y'.repeat(400), thoughtSignature: 'S'.repeat(40_000) }],
      },
    };
    expect(estimateHistoryTokens([signed])).toBe(100);
  });
});

describe('assessHistory', () => {
  it('defaults: warn from 150,000 and block from 200,000 estimated tokens', () => {
    expect(assessHistory([userOfTokens(149_999)])).toEqual({ verdict: 'ok', estimatedTokens: 149_999 });
    expect(assessHistory([userOfTokens(150_000)])).toEqual({ verdict: 'warn', estimatedTokens: 150_000 });
    expect(assessHistory([userOfTokens(199_999)])).toEqual({ verdict: 'warn', estimatedTokens: 199_999 });
    expect(assessHistory([userOfTokens(200_000)])).toEqual({ verdict: 'block', estimatedTokens: 200_000 });
  });

  it('follows the configured thresholds', () => {
    setThresholds(100, 200);
    expect(assessHistory([userOfTokens(99)]).verdict).toBe('ok');
    expect(assessHistory([userOfTokens(100)]).verdict).toBe('warn');
    expect(assessHistory([userOfTokens(199)]).verdict).toBe('warn');
    expect(assessHistory([userOfTokens(200)]).verdict).toBe('block');
  });
});

describe('the warning wording', () => {
  // apps/frontend/lib/history-notice.test.ts puts this same sentence through the web
  // app's citation strips. It cannot import from here, so the words are pinned on both
  // sides: a rewording has to visit both files.
  it('is the sentence the frontend test carries', () => {
    expect(HISTORY_WARNING_MESSAGE).toBe(
      'Note: this conversation is getting long. Please start a new conversation soon. Ansari cannot continue a conversation beyond a certain length.'
    );
  });
});

describe('limitThreadTurn', () => {
  const answer: FacilitatorStreamEvent[] = [
    { type: 'tool_use', data: '{"name":"search_quran"}' },
    { type: 'text', data: 'Sabr means ' },
    { type: 'text', data: 'patience.' },
    { type: 'done', data: '', usage: { promptTokenCount: 7, candidatesTokenCount: 3, thoughtsTokenCount: 0, totalTokenCount: 10 } },
  ];
  const runs = (events: FacilitatorStreamEvent[]) =>
    vi.fn(async function* () {
      yield* events;
    });

  beforeEach(() => setThresholds(100, 200));

  it('under the warn threshold: the turn is passed through untouched, with no log line', async () => {
    const run = runs(answer);
    expect(await collect(limitThreadTurn([userOfTokens(99)], 'thread-1', run))).toEqual(answer);
    expect(run).toHaveBeenCalledTimes(1);
    expect(console.warn).not.toHaveBeenCalled();
  });

  it("from the warn threshold: the warning is one text event just ahead of the answer's first text", async () => {
    const run = runs(answer);
    const events = await collect(limitThreadTurn([userOfTokens(100)], 'thread-1', run));
    expect(run).toHaveBeenCalledTimes(1);
    expect(events).toEqual([
      answer[0],
      { type: 'text', data: `${HISTORY_WARNING_MESSAGE}\n\n` },
      ...answer.slice(1),
    ]);
  });

  it('the warning is sent once, and waits for the first text that is not blank', async () => {
    const blankFirst: FacilitatorStreamEvent[] = [
      { type: 'text', data: '\n' },
      { type: 'text', data: 'Sabr' },
      { type: 'text', data: ' is patience.' },
      { type: 'done', data: '' },
    ];
    const events = await collect(limitThreadTurn([userOfTokens(100)], 'thread-1', runs(blankFirst)));
    expect(events).toEqual([
      blankFirst[0],
      { type: 'text', data: `${HISTORY_WARNING_MESSAGE}\n\n` },
      ...blankFirst.slice(1),
    ]);
  });

  it('a warned turn with no answer text gets no warning: an empty answer stays empty', async () => {
    for (const empty of [
      [{ type: 'done', data: '' }],
      [{ type: 'text', data: ' \n' }, { type: 'done', data: '' }],
      [{ type: 'error', data: 'The model returned an empty answer. Please try again.' }],
    ] as FacilitatorStreamEvent[][]) {
      expect(await collect(limitThreadTurn([userOfTokens(150)], 'thread-1', runs(empty)))).toEqual(empty);
    }
  });

  it('from the block threshold: the facilitator never starts and the notice is the whole answer', async () => {
    const run = runs(answer);
    const events = await collect(limitThreadTurn([userOfTokens(200)], 'thread-1', run));
    expect(run).not.toHaveBeenCalled();
    expect(events).toEqual([
      { type: 'text', data: HISTORY_BLOCK_MESSAGE },
      { type: 'done', data: '' },
    ]);
  });

  it('logs the thread id, verdict and estimate for a warned or blocked turn, and no content', async () => {
    await collect(limitThreadTurn([userOfTokens(150)], 'thread-w', runs(answer)));
    await collect(limitThreadTurn([userOfTokens(250)], 'thread-b', runs(answer)));
    expect(vi.mocked(console.warn).mock.calls).toEqual([
      ['[history-limit] thread history over a threshold', { threadId: 'thread-w', verdict: 'warn', estimatedTokens: 150 }],
      ['[history-limit] thread history over a threshold', { threadId: 'thread-b', verdict: 'block', estimatedTokens: 250 }],
    ]);
  });
});
