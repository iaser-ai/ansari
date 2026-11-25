/**
 * The line reader and idle timer shared by the clients.
 *
 * Python counterpart: `response.aiter_lines()` and httpx's read timeout. The chat client skips blank lines, so a wrong split of
 * `\r\n` or a lost chunk boundary can hide there; these tests read the lines themselves.
 */
import { describe, expect, it } from 'vitest';
import { describeNetworkError, IdleTimeout, readLines, trimTrailingSlashes } from '../src/services/http';
import { bytesInChunks, streamedResponse } from './helpers/network';

async function linesOf(chunks: Array<string | Uint8Array>): Promise<string[]> {
  const out: string[] = [];
  for await (const line of readLines(streamedResponse(chunks).body!)) out.push(line);
  return out;
}

describe('readLines', () => {
  it('splits at \\n, \\r\\n and \\r, as the Server-Sent Events standard says', async () => {
    expect(await linesOf(['a\nb\r\nc\rd'])).toEqual(['a', 'b', 'c', 'd']);
  });

  it('gives a blank line for each blank separator', async () => {
    expect(await linesOf(['a\n\nb\n'])).toEqual(['a', '', 'b']);
  });

  it('does not add a line after a final newline', async () => {
    expect(await linesOf(['a\n'])).toEqual(['a']);
  });

  it('returns a last line that has no newline', async () => {
    expect(await linesOf(['a\nb'])).toEqual(['a', 'b']);
  });

  it('returns nothing for an empty body', async () => {
    expect(await linesOf([])).toEqual([]);
  });

  it('joins a line cut between chunks', async () => {
    expect(await linesOf(['data: hel', 'lo\nnext'])).toEqual(['data: hello', 'next']);
  });

  // A \r at the end of a chunk may be half of \r\n. Treating it as a whole line end would invent a blank line.
  it('does not turn \\r\\n into two line ends when the chunk ends between them', async () => {
    expect(await linesOf(['a\r', '\nb'])).toEqual(['a', 'b']);
    expect(await linesOf(['a\r', '\r\nb'])).toEqual(['a', '', 'b']);
  });

  it('ends a line at a \\r that really is alone, once the next chunk shows it', async () => {
    expect(await linesOf(['a\r', 'b'])).toEqual(['a', 'b']);
  });

  it('ends a line at a final \\r when nothing more arrives', async () => {
    expect(await linesOf(['a\r'])).toEqual(['a']);
  });

  it('gives the same lines however the bytes are cut, even inside a multi-byte character', async () => {
    const text = 'caf\u00e9 \u0645\u0631\u062d\u0628\u0627\r\n\u{1F600} done\n';
    const expected = ['caf\u00e9 \u0645\u0631\u062d\u0628\u0627', '\u{1F600} done'];
    for (const size of [1, 2, 3, 4, 5, 9, 100]) {
      expect(await linesOf(bytesInChunks(text, size))).toEqual(expected);
    }
  });

  it('does not split at U+2028 or other characters Python\'s splitlines would', async () => {
    expect(await linesOf(['one\u2028two\u0085three\u000bfour\u000cfive\n'])).toEqual(['one\u2028two\u0085three\u000bfour\u000cfive']);
  });

  it('calls onChunk for every chunk', async () => {
    let chunks = 0;
    const body = streamedResponse(['a\n', 'b\n', 'c\n']).body!;
    for await (const line of readLines(body, () => (chunks += 1))) void line;
    expect(chunks).toBe(3);
  });

  it('releases the connection when the caller stops early', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('a\nb\nc\n'));
      },
      cancel() {
        cancelled = true;
      },
    });
    for await (const line of readLines(body)) {
      void line;
      break;
    }
    expect(cancelled).toBe(true);
  });
});

describe('IdleTimeout', () => {
  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  it('aborts after the idle time and says the timer did it', async () => {
    const idle = new IdleTimeout(30);
    await wait(80);
    expect(idle.signal.aborted).toBe(true);
    expect(idle.timedOut).toBe(true);
    idle.stop();
  });

  it('is pushed back by reset()', async () => {
    const idle = new IdleTimeout(60);
    for (let i = 0; i < 4; i++) {
      await wait(30);
      idle.reset();
    }
    expect(idle.signal.aborted).toBe(false);
    idle.stop();
  });

  it('does not fire after stop()', async () => {
    const idle = new IdleTimeout(20);
    idle.stop();
    await wait(60);
    expect(idle.signal.aborted).toBe(false);
    expect(idle.timedOut).toBe(false);
  });
});

describe('describeNetworkError', () => {
  it('names the error class and the system code, never the message', () => {
    const error = Object.assign(new TypeError('fetch failed for http://secret.test'), {
      cause: Object.assign(new Error('connect ECONNREFUSED http://secret.test'), { code: 'ECONNREFUSED' }),
    });
    expect(describeNetworkError(error)).toBe('TypeError/ECONNREFUSED');
  });

  it('gives just the class when there is no code', () => {
    expect(describeNetworkError(new TypeError('boom http://secret.test'))).toBe('TypeError');
  });

  it('copes with a value that is not an Error', () => {
    expect(describeNetworkError('text')).toBe('string');
    expect(describeNetworkError(undefined)).toBe('undefined');
  });
});

describe('trimTrailingSlashes', () => {
  it.each([
    ['http://h/', 'http://h'],
    ['http://h///', 'http://h'],
    ['http://h', 'http://h'],
    ['http://h/a/', 'http://h/a'],
  ])('%s -> %s', (input, expected) => {
    expect(trimTrailingSlashes(input)).toBe(expected);
  });
});
