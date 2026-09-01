import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the transport so we can count requests. auth-bridge is mocked so the
// token getter and refresh don't need a live AuthProvider.
vi.mock('expo/fetch', () => ({ fetch: vi.fn() }));
vi.mock('@/lib/api/auth-bridge', () => ({
  getAccessToken: vi.fn(async () => 'tok'),
  handleUnauthorized: vi.fn(async () => null),
}));

import { fetch as expoFetch } from 'expo/fetch';
import { streamChat } from '@/lib/api/streaming';

const SSE =
  'data: {"type":"text","content":"Hello"}\n\ndata: {"type":"done"}\n\n';

/** A response that exposes a streaming ReadableStream body (native/web happy path). */
function streamingResponse(text: string) {
  const encoder = new TextEncoder();
  let sent = false;
  return {
    status: 200,
    ok: true,
    body: {
      getReader: () => ({
        read: async () =>
          sent
            ? { done: true, value: undefined }
            : ((sent = true), { done: false, value: encoder.encode(text) }),
        releaseLock: () => {},
      }),
    },
    text: async () => {
      throw new Error('text() must not be called when a body reader exists');
    },
  };
}

/** A streaming response that yields the given chunks in order, one per read(). */
function chunkedResponse(chunks: string[]) {
  const encoder = new TextEncoder();
  let i = 0;
  return {
    status: 200,
    ok: true,
    body: {
      getReader: () => ({
        read: async () =>
          i < chunks.length
            ? { done: false, value: encoder.encode(chunks[i++]) }
            : { done: true, value: undefined },
        releaseLock: () => {},
      }),
    },
    text: async () => {
      throw new Error('text() must not be called when a body reader exists');
    },
  };
}

/** A response with NO streaming body — the runtime the old XHR fallback served. */
function bufferedResponse(text: string) {
  return { status: 200, ok: true, body: undefined, text: async () => text };
}

const textFrame = (s: string) =>
  `data: ${JSON.stringify({ type: 'text', content: s })}\n\n`;
const DONE = 'data: {"type":"done"}\n\n';

const mockFetch = expoFetch as unknown as ReturnType<typeof vi.fn>;

// Count requests across BOTH transports. The original bug's second POST went via
// XHR (not expo/fetch), so counting expo/fetch alone would miss it — the guard
// must see any request through either path.
let xhrConstructed = 0;
beforeEach(() => {
  mockFetch.mockReset();
  xhrConstructed = 0;
  (globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest = class {
    constructor() {
      xhrConstructed++;
    }
    open() {}
    setRequestHeader() {}
    send() {}
  };
});

describe('streamChat — exactly one request per send (no double-POST)', () => {
  it('issues ONE request and parses the answer when a streaming body IS available', async () => {
    mockFetch.mockResolvedValueOnce(streamingResponse(SSE));
    const answer = await streamChat({
      baseUrl: 'https://x',
      threadId: 't',
      message: 'hi',
    });
    expect(answer).toBe('Hello');
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(xhrConstructed).toBe(0);
  });

  it('issues ONE request and consumes the in-hand response when NO streaming body exists', async () => {
    mockFetch.mockResolvedValueOnce(bufferedResponse(SSE));
    const answer = await streamChat({
      baseUrl: 'https://x',
      threadId: 't',
      message: 'hi',
    });
    expect(answer).toBe('Hello');
    // The regression guard: a missing body must consume the response already in
    // hand, NOT re-send the POST (which would duplicate the message + re-invoke
    // the model) — via expo/fetch OR the old XHR fallback.
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(xhrConstructed).toBe(0);
  });
});

describe('streamChat — incremental progress + empty-answer guard', () => {
  it('delivers text deltas via onEvent progressively as chunks arrive, then the full answer', async () => {
    // A text frame split across two reads, a heartbeat between frames, and the
    // terminating done in its own chunk — the reader must reassemble across the
    // split and emit each text delta in order.
    const first = textFrame('Hello, ');
    const mid = Math.floor(first.length / 2);
    mockFetch.mockResolvedValueOnce(
      chunkedResponse([
        first.slice(0, mid),
        first.slice(mid),
        ': ping\n\n',
        textFrame('world.'),
        DONE,
      ]),
    );

    const deltas: string[] = [];
    const answer = await streamChat({
      baseUrl: 'https://x',
      threadId: 't',
      message: 'hi',
      onEvent: (e) => {
        if (e.type === 'text') deltas.push(e.content);
      },
    });

    expect(deltas).toEqual(['Hello, ', 'world.']);
    expect(answer).toBe('Hello, world.');
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('rejects a stream that reaches done with zero text frames (empty answer)', async () => {
    mockFetch.mockResolvedValueOnce(chunkedResponse([DONE]));
    await expect(
      streamChat({ baseUrl: 'https://x', threadId: 't', message: 'hi' }),
    ).rejects.toThrow(/empty answer/);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});
