/**
 * Small helpers shared by the three HTTP clients.
 *
 * Python used `httpx`; Node ships `fetch`. Three differences that the clients have to handle:
 * - `httpx` does not follow redirects, `fetch` does. Every call here passes `redirect: 'manual'` and treats a 3xx as a
 *   failure, so a token is never sent to a place the operator did not configure.
 * - `httpx`'s timeout is per wait (connecting, then each read). `fetch` has none, only an `AbortSignal` you build yourself.
 *   A plain deadline is right for a short call; a streamed answer needs `IdleTimeout` below.
 * - A `fetch` response whose body is never read keeps its connection busy until it is garbage-collected, so every
 *   response a client gives up on goes through `discardBody`.
 */

/** The type of `fetch`. Clients take it as an option so tests can hand in a fake. */
export type FetchLike = typeof fetch;

/** Release a response we will not read. Errors are ignored: the body may already be consumed or locked. */
export async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // already consumed or locked
  }
}

/**
 * A short, safe description of why a `fetch` failed, for logs: the error's class, plus the system error code when there
 * is one (`TypeError/ECONNREFUSED`). Never the message: Node's can include the URL.
 */
export function describeNetworkError(error: unknown): string {
  if (!(error instanceof Error)) return typeof error;
  const cause: unknown = error.cause;
  const code = cause instanceof Error && 'code' in cause ? String((cause as { code: unknown }).code) : undefined;
  return code ? `${error.name}/${code}` : error.name;
}

/**
 * An abort signal that fires after `ms` of silence rather than after `ms` in total: call `reset()` whenever something
 * arrives. This is what `httpx`'s per-read timeout gave the Python client, and what lets a chat answer stream for
 * minutes as long as apps/api keeps sending its `: ping` lines.
 */
export class IdleTimeout {
  readonly signal: AbortSignal;
  /** True once the timer, not the caller, aborted the request. */
  timedOut = false;

  readonly #controller = new AbortController();
  readonly #ms: number;
  #timer: ReturnType<typeof setTimeout> | undefined;

  constructor(ms: number) {
    this.#ms = ms;
    this.signal = this.#controller.signal;
    this.reset();
  }

  reset(): void {
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.timedOut = true;
      this.#controller.abort();
    }, this.#ms);
  }

  /** Stop the timer. Always call it when the request is over, or the timer keeps the process alive. */
  stop(): void {
    clearTimeout(this.#timer);
  }
}

/**
 * Read a response body line by line (Python: `response.aiter_lines()`).
 *
 * A body arrives in chunks that can end anywhere: in the middle of a line, in the middle of a multi-byte character, or
 * between the `\r` and the `\n` of a line ending. So the bytes go through a streaming `TextDecoder` (which holds back an
 * unfinished character), and a trailing `\r` is held until the next chunk shows whether a `\n` follows.
 *
 * Lines end at `\n`, `\r\n` or `\r`, as the Server-Sent Events standard says. Python's `str.splitlines()` also splits at
 * U+2028 and a few other characters; apps/api's JSON can contain a raw U+2028 inside a string, which would cut that
 * event in two, so this does not split there. `onChunk` is called for every chunk, so a caller can restart an idle timer.
 */
export async function* readLines(
  body: ReadableStream<Uint8Array>,
  onChunk: () => void = () => {},
): AsyncGenerator<string> {
  const decoder = new TextDecoder('utf-8');
  const reader = body.getReader();
  let buffer = '';
  const LINE_END = /\r\n|\n|\r/;

  function* drain(final: boolean): Generator<string> {
    for (;;) {
      const match = LINE_END.exec(buffer);
      if (!match) return;
      // A \r at the very end might be the first half of \r\n: wait, unless nothing more can arrive
      if (match[0] === '\r' && match.index === buffer.length - 1 && !final) return;
      yield buffer.slice(0, match.index);
      buffer = buffer.slice(match.index + match[0].length);
    }
  }

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      onChunk();
      buffer += decoder.decode(value, { stream: true });
      yield* drain(false);
    }
    buffer += decoder.decode();
    yield* drain(true);
    if (buffer !== '') yield buffer;
  } finally {
    // Stop reading if the caller left early (an error event, a failed check): the connection is released
    await reader.cancel().catch(() => {});
  }
}

/** Remove trailing slashes, so `http://host/` + `/path` does not become `http://host//path`. */
export function trimTrailingSlashes(url: string): string {
  return url.replace(/\/+$/, '');
}
