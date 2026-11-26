/**
 * Test helpers for the HTTP clients: a fake `fetch`, streamed responses, and a logger that keeps what it is told.
 *
 * Python counterpart: `httpx.MockTransport(handler)` plus Loguru sinks. The clients take `fetch` as an option, so a test
 * hands in `fakeFetch(...).fetch` and nothing touches the network or patches a module.
 */
import { createLogger, type Logger } from '../../src/logger';

/** `fetch`'s own parameter types: this project has no DOM library, so names like `RequestInfo` are not defined. */
type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = NonNullable<Parameters<typeof fetch>[1]>;

/** What a client sent, in a form a test can assert on. */
export interface SentRequest {
  url: string;
  path: string;
  method: string;
  headers: Record<string, string>;
  /** The body as text, or `undefined` when none was sent. */
  body: string | undefined;
  /** The body parsed as JSON, or `undefined` when there is none or it is not JSON. */
  json: unknown;
  redirect: FetchInit['redirect'];
  signal: AbortSignal | null | undefined;
}

export type Handler = (request: SentRequest) => Response | Promise<Response>;

/** A `fetch` that answers from `handler` and records every request. */
export function fakeFetch(handler: Handler): { fetch: typeof fetch; calls: SentRequest[] } {
  const calls: SentRequest[] = [];
  const fakeFetchFn = async (input: FetchInput, init?: FetchInit): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input);
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const body = typeof init?.body === 'string' ? init.body : undefined;
    let json: unknown;
    try {
      json = body === undefined ? undefined : JSON.parse(body);
    } catch {
      json = undefined;
    }
    const request: SentRequest = {
      url,
      path: new URL(url).pathname,
      method: init?.method ?? 'GET',
      headers,
      body,
      json,
      redirect: init?.redirect,
      signal: init?.signal,
    };
    calls.push(request);
    return handler(request);
  };
  return { fetch: fakeFetchFn as typeof fetch, calls };
}

/** Answers every request with the same JSON. */
export function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

/** An apps/api `/chat` stream: optional keep-alive comment lines, then one `data:` line per event. */
export function sse(events: unknown[], options: { ping?: boolean } = {}): string {
  const ping = options.ping ?? true ? ': ping\n\n' : '';
  return ping + events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('');
}

/**
 * A response whose body arrives in the given chunks, optionally with a pause before each. A chunk is text (encoded as
 * UTF-8) or raw bytes. Honours the request's abort signal like a real connection: aborting errors the stream.
 */
export function streamedResponse(
  chunks: Array<string | Uint8Array>,
  options: { status?: number; delayMs?: number; hangAfter?: boolean; signal?: AbortSignal | null } = {},
): Response {
  const encoder = new TextEncoder();
  let index = 0;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs));
      if (options.signal?.aborted) {
        controller.error(options.signal.reason ?? new Error('aborted'));
        return;
      }
      if (index < chunks.length) {
        const chunk = chunks[index++]!;
        controller.enqueue(typeof chunk === 'string' ? encoder.encode(chunk) : chunk);
        return;
      }
      if (options.hangAfter) {
        // Stay silent until the request is aborted
        await new Promise<void>((resolve) => {
          if (!options.signal) return;
          options.signal.addEventListener('abort', () => resolve(), { once: true });
        });
        controller.error(options.signal?.reason ?? new Error('aborted'));
        return;
      }
      controller.close();
    },
  });
  return new Response(body, { status: options.status ?? 200 });
}

/** Cut text into chunks of `size` UTF-8 BYTES, so a chunk can end inside a multi-byte character. */
export function bytesInChunks(text: string, size: number): Uint8Array[] {
  const bytes = new TextEncoder().encode(text);
  const chunks: Uint8Array[] = [];
  for (let i = 0; i < bytes.length; i += size) chunks.push(bytes.slice(i, i + size));
  return chunks;
}

/** A logger that keeps everything it is told. `text()` is all of it, `lines()` one entry per log call. */
export function capturingLogger(): { logger: Logger; text: () => string; lines: () => Array<{ level: string; message: string }> } {
  const out: string[] = [];
  const logger = createLogger({
    environment: 'production',
    level: 'DEBUG',
    sinks: { stdout: (line) => out.push(line), stderr: (line) => out.push(line) },
  });
  const lines = () => out.map((line) => JSON.parse(line) as { level: string; message: string });
  return { logger, text: () => out.join(''), lines };
}
