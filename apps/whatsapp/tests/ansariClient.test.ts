/**
 * The apps/api client.
 *
 * Python tests ported: the apps/api cases of `test_bsuid_auth_flow.py` (JWT on every call, the event stream, an `error`
 * event or a missing `done` is a failure, no body in logs) and the 401 case of `test_auth_statuses.py`. The Python tests
 * patched `httpx.AsyncClient`; here the client takes `fetch`, so a test hands in a fake and nothing touches the network.
 *
 * Streams are cut in awkward places on purpose (mid-line, mid-character), because real connections do that and the
 * Python tests could not.
 */
import { describe, expect, it } from 'vitest';
import {
  ApiUnauthorizedError,
  MessageProcessingError,
  ThreadCreationError,
  ThreadDeletionError,
  ThreadInfoError,
} from '../src/errors';
import { AnsariClientMock, AnsariClientReal, CLIENT_ID } from '../src/services/ansariClient';
import {
  bytesInChunks,
  capturingLogger,
  fakeFetch,
  jsonResponse,
  sse,
  streamedResponse,
  type Handler,
} from './helpers/network';

const TOKEN = 'jwt-of-the-user';

function setup(handler: Handler, options: { chatIdleTimeoutMs?: number } = {}) {
  const net = fakeFetch(handler);
  const log = capturingLogger();
  const client = new AnsariClientReal({ baseUrl: 'http://api.test/', logger: log.logger, fetch: net.fetch, ...options });
  return { client, log, ...net };
}

async function thrown(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected an error, but the call succeeded');
}

const ANSWER = sse([{ type: 'text', content: 'As-salamu ' }, { type: 'text', content: 'alaykum' }, { type: 'done' }]);

describe('every request', () => {
  it('carries the user\'s JWT and the client id, and never follows a redirect', async () => {
    const { client, calls } = setup((request) => {
      if (request.method === 'GET') return jsonResponse(200, []);
      if (request.path.endsWith('/chat')) return new Response(ANSWER, { status: 200 });
      if (request.method === 'DELETE') return new Response(null, { status: 204 });
      return jsonResponse(200, { thread_id: 't2' });
    });

    await client.getLastThreadInfo(TOKEN);
    await client.createThread(TOKEN, 'title');
    await client.processMessage(TOKEN, 't1', 'hi');
    await client.deleteThread(TOKEN, 't1');

    expect(calls).toHaveLength(4);
    for (const call of calls) {
      expect(call.headers.authorization).toBe(`Bearer ${TOKEN}`);
      expect(call.headers['x-ansari-client']).toBe(CLIENT_ID);
      expect(call.redirect).toBe('manual');
      expect(call.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it('uses the lowercase attribution id apps/api expects', () => {
    expect(CLIENT_ID).toBe('askansari-whatsapp');
  });

  it('builds URLs from the base URL without doubling the slash', async () => {
    const { client, calls } = setup(() => jsonResponse(200, []));
    await client.getLastThreadInfo(TOKEN);
    expect(calls[0]!.url).toBe('http://api.test/api/v2/threads');
  });

  it('keeps a thread id from changing the path', async () => {
    const { client, calls } = setup(() => new Response(null, { status: 204 }));
    await client.deleteThread(TOKEN, '../../admin?x=1');
    expect(calls[0]!.url).toBe('http://api.test/api/v2/threads/..%2F..%2Fadmin%3Fx%3D1');
  });
});

describe('threads', () => {
  it('finds the newest thread this service created, ignoring other clients\' threads', async () => {
    const { client } = setup(() =>
      jsonResponse(200, [
        { thread_id: 'web-1', source: 'web', updated_at: '2026-10-26T10:00:00.000Z' },
        { thread_id: 't1', source: 'whatsapp', updated_at: '2026-10-25T10:00:00.000Z' },
        { thread_id: 't0', source: 'whatsapp', updated_at: '2026-10-24T10:00:00.000Z' },
      ]),
    );
    expect(await client.getLastThreadInfo(TOKEN)).toEqual({ threadId: 't1', lastMessageTime: '2026-10-25T10:00:00.000Z' });
  });

  it.each([[[]], [[{ thread_id: 'w', source: 'web', updated_at: 'x' }]]])('reports no thread for %j', async (list) => {
    const { client } = setup(() => jsonResponse(200, list));
    expect(await client.getLastThreadInfo(TOKEN)).toEqual({ threadId: null, lastMessageTime: null });
  });

  it('creates a thread named by the title, marked as coming from WhatsApp', async () => {
    const { client, calls } = setup(() => jsonResponse(200, { thread_id: 't2' }));
    expect(await client.createThread(TOKEN, 'my title')).toEqual({ threadId: 't2' });
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.json).toEqual({ name: 'my title', source: 'whatsapp' });
  });

  it('deletes a thread, and treats a thread that is already gone as done', async () => {
    const { client } = setup(() => new Response(null, { status: 404 }));
    await expect(client.deleteThread(TOKEN, 't1')).resolves.toBeUndefined();
  });

  it.each([
    ['listing', (c: AnsariClientReal) => c.getLastThreadInfo(TOKEN), ThreadInfoError],
    ['creating', (c: AnsariClientReal) => c.createThread(TOKEN, 't'), ThreadCreationError],
    ['deleting', (c: AnsariClientReal) => c.deleteThread(TOKEN, 't'), ThreadDeletionError],
  ] as const)('%s: a server error, a network fault and a redirect each raise the method\'s own error', async (_name, call, expected) => {
    for (const handler of [
      () => jsonResponse(500, { detail: 'boom' }),
      () => {
        throw new TypeError('fetch failed');
      },
      () => new Response(null, { status: 302, headers: { Location: 'http://evil.test/' } }),
    ] as Handler[]) {
      const { client } = setup(handler);
      const error = await thrown(call(client));
      expect(error).toBeInstanceOf(expected);
    }
  });

  it.each([
    ['listing', (c: AnsariClientReal) => c.getLastThreadInfo(TOKEN)],
    ['creating', (c: AnsariClientReal) => c.createThread(TOKEN, 't')],
    ['deleting', (c: AnsariClientReal) => c.deleteThread(TOKEN, 't')],
    ['chatting', (c: AnsariClientReal) => c.processMessage(TOKEN, 't', 'hi')],
  ] as const)('%s: a 401 is "refresh the token", not a generic failure', async (_name, call) => {
    const { client } = setup(() => jsonResponse(401, { message: 'expired' }));
    expect(await thrown(call(client))).toBeInstanceOf(ApiUnauthorizedError);
  });

  it.each([
    ['not JSON', () => new Response('<html>', { status: 200 })],
    ['not an object', () => jsonResponse(200, 'thread')],
    ['no thread_id', () => jsonResponse(200, {})],
    ['an empty thread_id', () => jsonResponse(200, { thread_id: '' })],
    ['a numeric thread_id', () => jsonResponse(200, { thread_id: 7 })],
  ] as const)('creating: an answer that is %s raises ThreadCreationError', async (_name, answer) => {
    const { client } = setup(answer);
    expect(await thrown(client.createThread(TOKEN, 't'))).toBeInstanceOf(ThreadCreationError);
  });

  it.each([
    ['not JSON', () => new Response('<html>', { status: 200 })],
    ['not a list', () => jsonResponse(200, { threads: [] })],
    ['a thread without an id', () => jsonResponse(200, [{ source: 'whatsapp', updated_at: 'x' }])],
    ['a thread without a time', () => jsonResponse(200, [{ thread_id: 't', source: 'whatsapp' }])],
    ['a list holding null', () => jsonResponse(200, [null])],
  ] as const)('listing: an answer that is %s raises ThreadInfoError', async (_name, answer) => {
    const { client } = setup(answer);
    expect(await thrown(client.getLastThreadInfo(TOKEN))).toBeInstanceOf(ThreadInfoError);
  });
});

describe('the chat stream', () => {
  it('sends the message in the body and joins the text events into one answer', async () => {
    const { client, calls } = setup(() => new Response(ANSWER, { status: 200 }));
    expect(await client.processMessage(TOKEN, 't1', 'hi there')).toBe('As-salamu alaykum');
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.path).toBe('/api/v2/threads/t1/chat');
    expect(calls[0]!.json).toEqual({ message: 'hi there' });
  });

  it('ignores tool events, keep-alive comments and blank lines', async () => {
    const stream = ': ping\n\n' + sse([{ type: 'tool_call', name: 'search_quran' }, { type: 'tool_result', resultCount: 3 }, { type: 'text', content: 'ok' }, { type: 'done' }], { ping: false }) + ': ping\n\n\n';
    const { client } = setup(() => new Response(stream, { status: 200 }));
    expect(await client.processMessage(TOKEN, 't1', 'hi')).toBe('ok');
  });

  it('gives an empty answer when apps/api finishes without saying anything', async () => {
    const { client } = setup(() => new Response(sse([{ type: 'done' }]), { status: 200 }));
    expect(await client.processMessage(TOKEN, 't1', 'hi')).toBe('');
  });

  it('ignores a text event without content', async () => {
    const { client } = setup(() => new Response(sse([{ type: 'text' }, { type: 'text', content: null }, { type: 'text', content: 5 }, { type: 'text', content: 'x' }, { type: 'done' }]), { status: 200 }));
    expect(await client.processMessage(TOKEN, 't1', 'hi')).toBe('x');
  });

  // `done` follows the error, so only the error event itself can make this fail (not the missing-done check)
  it('treats an error event as a failure, not as an answer', async () => {
    const stream = sse([{ type: 'text', content: 'partial' }, { type: 'error', message: 'model overloaded' }, { type: 'done' }]);
    const { client } = setup(() => new Response(stream, { status: 200 }));
    expect(await thrown(client.processMessage(TOKEN, 't1', 'hi'))).toBeInstanceOf(MessageProcessingError);
  });

  it('treats a stream cut off before done as a failure, so half an answer is never sent on', async () => {
    const { client } = setup(() => new Response(sse([{ type: 'text', content: 'half an ans' }]), { status: 200 }));
    expect(await thrown(client.processMessage(TOKEN, 't1', 'hi'))).toBeInstanceOf(MessageProcessingError);
  });

  it('treats a malformed event as a failure', async () => {
    const { client } = setup(() => new Response('data: this is not json\n\n', { status: 200 }));
    expect(await thrown(client.processMessage(TOKEN, 't1', 'hi'))).toBeInstanceOf(MessageProcessingError);
  });

  it.each([[500], [400], [503], [302]])('treats HTTP %s as a failure', async (status) => {
    const { client } = setup(() => new Response('boom', { status }));
    const error = (await thrown(client.processMessage(TOKEN, 't1', 'hi'))) as Error;
    expect(error).toBeInstanceOf(MessageProcessingError);
    expect(error.message).toContain(String(status));
  });

  it('treats a 200 with no body as a failure', async () => {
    const { client } = setup(() => new Response(null, { status: 200 }));
    expect(await thrown(client.processMessage(TOKEN, 't1', 'hi'))).toBeInstanceOf(MessageProcessingError);
  });

  it('never lets an error body reach the logs or the raised error', async () => {
    const { client, log } = setup(() => new Response('{"detail":"echo of the user: a-very-distinctive-question"}', { status: 400 }));
    const error = (await thrown(client.processMessage(TOKEN, 't1', 'hi'))) as Error;
    expect(error.message).toContain('400');
    expect(error.message).not.toContain('a-very-distinctive-question');
    expect(log.text()).not.toContain('a-very-distinctive-question');
  });

  it('keeps the user\'s message and the answer out of the logs', async () => {
    const stream = sse([{ type: 'text', content: 'the-secret-answer' }, { type: 'done' }]);
    const { client, log } = setup(() => new Response(stream, { status: 200 }));
    await client.processMessage(TOKEN, 't1', 'the-secret-question');
    expect(log.text()).not.toContain('the-secret-answer');
    expect(log.text()).not.toContain('the-secret-question');
    expect(log.text()).not.toContain(TOKEN);
  });

  it('reports the chat error text apps/api sent, which is its own text', async () => {
    const stream = sse([{ type: 'error', message: 'model overloaded' }]);
    const { client, log } = setup(() => new Response(stream, { status: 200 }));
    await thrown(client.processMessage(TOKEN, 't1', 'hi'));
    expect(log.text()).toContain('apps/api reported a chat error: model overloaded');
  });
});

describe('a stream that arrives in pieces', () => {
  it('reads the same answer however the bytes are cut, even inside a multi-byte character', async () => {
    const text = 'As-salamu alaykum \u0645\u0631\u062d\u0628\u0627 \u{1F600} caf\u00e9';
    const stream = sse([{ type: 'text', content: text }, { type: 'done' }]);
    for (const size of [1, 2, 3, 5, 7, 64]) {
      const { client } = setup(() => streamedResponse(bytesInChunks(stream, size)));
      expect(await client.processMessage(TOKEN, 't1', 'hi')).toBe(text);
    }
  });

  it('reads CRLF line endings, including one split between \\r and \\n', async () => {
    const stream = sse([{ type: 'text', content: 'ab' }, { type: 'done' }]).replaceAll('\n', '\r\n');
    for (const size of [1, 2, 3, 11]) {
      const { client } = setup(() => streamedResponse(bytesInChunks(stream, size)));
      expect(await client.processMessage(TOKEN, 't1', 'hi')).toBe('ab');
    }
  });

  it('reads a final event that has no trailing newline', async () => {
    const stream = 'data: {"type":"text","content":"x"}\n\ndata: {"type":"done"}';
    const { client } = setup(() => new Response(stream, { status: 200 }));
    expect(await client.processMessage(TOKEN, 't1', 'hi')).toBe('x');
  });

  it('is not cut in two by a raw U+2028 inside the answer', async () => {
    const text = 'before\u2028after';
    const stream = `data: ${JSON.stringify({ type: 'text', content: text }).replace('\\u2028', '\u2028')}\n\ndata: {"type":"done"}\n\n`;
    const { client } = setup(() => new Response(stream, { status: 200 }));
    expect(await client.processMessage(TOKEN, 't1', 'hi')).toBe(text);
  });

  it('stays open past the idle timeout while data keeps arriving', async () => {
    const chunks = [': ping\n\n', 'data: {"type":"text","content":"a"}\n\n', ': ping\n\n', 'data: {"type":"text","content":"b"}\n\n', 'data: {"type":"done"}\n\n'];
    const { client } = setup((request) => streamedResponse(chunks, { delayMs: 40, signal: request.signal }), { chatIdleTimeoutMs: 100 });
    // 5 chunks x 40 ms = 200 ms in total, over the 100 ms idle limit, but never silent for 100 ms
    expect(await client.processMessage(TOKEN, 't1', 'hi')).toBe('ab');
  });

  it('gives up when apps/api goes silent, and says it timed out', async () => {
    const { client, log } = setup((request) => streamedResponse(['data: {"type":"text","content":"a"}\n\n'], { hangAfter: true, signal: request.signal }), {
      chatIdleTimeoutMs: 80,
    });
    const error = (await thrown(client.processMessage(TOKEN, 't1', 'hi'))) as Error;
    expect(error).toBeInstanceOf(MessageProcessingError);
    expect(error.message).toContain('timed out');
    expect(log.text()).toContain('Timeout processing message');
  });

  it('gives up when apps/api never starts to answer', async () => {
    const { client } = setup(
      (request) =>
        new Promise<Response>((_resolve, reject) => {
          request.signal?.addEventListener('abort', () => reject(request.signal?.reason ?? new Error('aborted')), { once: true });
        }),
      { chatIdleTimeoutMs: 60 },
    );
    const error = (await thrown(client.processMessage(TOKEN, 't1', 'hi'))) as Error;
    expect(error).toBeInstanceOf(MessageProcessingError);
    expect(error.message).toContain('timed out');
  });

  it('raises a network error, without leaking the URL, when the connection drops mid-answer', async () => {
    const { client, log } = setup(() => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: {"type":"text","content":"a"}\n\n'));
          controller.error(Object.assign(new TypeError('terminated'), { cause: Object.assign(new Error('read ECONNRESET http://api.test'), { code: 'ECONNRESET' }) }));
        },
      });
      return new Response(body, { status: 200 });
    });
    const error = (await thrown(client.processMessage(TOKEN, 't1', 'hi'))) as Error;
    expect(error).toBeInstanceOf(MessageProcessingError);
    expect(error.message).toContain('Network error');
    expect(log.text()).toContain('TypeError/ECONNRESET');
    expect(log.text()).not.toContain('api.test');
  });

  it('raises a network error when the request cannot be made at all', async () => {
    const { client } = setup(() => {
      throw new TypeError('fetch failed');
    });
    expect(await thrown(client.processMessage(TOKEN, 't1', 'hi'))).toBeInstanceOf(MessageProcessingError);
  });

  it('stops reading as soon as it has failed, so the connection is released', async () => {
    let cancelled = false;
    const { client } = setup(() => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(sse([{ type: 'error', message: 'x' }])));
        },
        cancel() {
          cancelled = true;
        },
      });
      return new Response(body, { status: 200 });
    });
    await thrown(client.processMessage(TOKEN, 't1', 'hi'));
    expect(cancelled).toBe(true);
  });
});

describe('AnsariClientMock', () => {
  function mock() {
    return new AnsariClientMock({ logger: capturingLogger().logger, now: (() => { let t = Date.UTC(2026, 10, 10); return () => new Date((t += 1000)); })() });
  }

  it('keeps one user\'s threads apart from another\'s', async () => {
    const m = mock();
    const { threadId } = await m.createThread('alice', 'a');
    expect(await m.getLastThreadInfo('bob')).toEqual({ threadId: null, lastMessageTime: null });
    expect((await m.getLastThreadInfo('alice')).threadId).toBe(threadId);
    expect(await thrown(m.processMessage('bob', threadId, 'hi'))).toBeInstanceOf(MessageProcessingError);
    expect(await thrown(m.deleteThread('bob', threadId))).toBeInstanceOf(ThreadDeletionError);
  });

  it('answers a message and moves the thread\'s last activity forward', async () => {
    const m = mock();
    const { threadId } = await m.createThread('alice', 'a');
    const before = (await m.getLastThreadInfo('alice')).lastMessageTime!;
    expect(await m.processMessage('alice', threadId, 'hello')).toContain('hello');
    expect((await m.getLastThreadInfo('alice')).lastMessageTime! > before).toBe(true);
  });

  it('picks the most recently active of a user\'s threads', async () => {
    const m = mock();
    const first = await m.createThread('alice', '1');
    const second = await m.createThread('alice', '2');
    await m.processMessage('alice', first.threadId, 'x');
    expect((await m.getLastThreadInfo('alice')).threadId).toBe(first.threadId);
    await m.processMessage('alice', second.threadId, 'y');
    expect((await m.getLastThreadInfo('alice')).threadId).toBe(second.threadId);
  });

  it('deletes a thread and its messages, and a missing thread is not an error', async () => {
    const m = mock();
    const { threadId } = await m.createThread('alice', 'a');
    await m.deleteThread('alice', threadId);
    expect(await m.getLastThreadInfo('alice')).toEqual({ threadId: null, lastMessageTime: null });
    await expect(m.deleteThread('alice', threadId)).resolves.toBeUndefined();
  });

  it('refuses a missing token and an unknown thread', async () => {
    const m = mock();
    expect(await thrown(m.createThread('', 'a'))).toBeInstanceOf(ThreadCreationError);
    expect(await thrown(m.getLastThreadInfo(''))).toBeInstanceOf(ThreadInfoError);
    expect(await thrown(m.processMessage('alice', 'nope', 'hi'))).toBeInstanceOf(MessageProcessingError);
  });
});
