/**
 * The apps/api client.
 *
 * Python tests ported: the apps/api cases of `test_bsuid_auth_flow.py` (the JWT on every call, no body in logs) and the 401
 * case of `test_auth_statuses.py`. The Python tests patched `httpx.AsyncClient`; here the client takes `fetch`, so a test
 * hands in a fake and nothing touches the network.
 *
 * Phase 3 (spec 360) replaced the streamed chat and the thread calls with one JSON call and the preferences calls.
 */
import { describe, expect, it } from 'vitest';
import { ApiUnauthorizedError, MessageProcessingError, PreferencesError } from '../src/errors';
import { AnsariClientMock, AnsariClientReal, CHAT_RETENTION_PREFERENCE, CLIENT_ID } from '../src/services/ansariClient';
import { capturingLogger, fakeFetch, jsonResponse, type Handler } from './helpers/network';

const TOKEN = 'jwt-of-the-user';
const CHAT = { message: 'What does the Quran say about patience?', expiryHours: 3 };

function setup(handler: Handler, options: { chatTimeoutMs?: number } = {}) {
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

describe('every request', () => {
  it("carries the user's JWT and the client id, and never follows a redirect", async () => {
    const { client, calls } = setup((request) => {
      if (request.path === '/api/v2/chat/complete') return jsonResponse(200, { messages: ['ok'] });
      return jsonResponse(200, {});
    });

    await client.completeChat(TOKEN, CHAT);
    await client.getPreferences(TOKEN);
    await client.setPreference(TOKEN, CHAT_RETENTION_PREFERENCE, '3');

    expect(calls).toHaveLength(3);
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
    const { client, calls } = setup(() => jsonResponse(200, {}));
    await client.getPreferences(TOKEN);
    expect(calls[0]!.url).toBe('http://api.test/api/v2/preferences');
  });
});

describe('completeChat', () => {
  it('posts the message and the expiry, and returns the messages in order', async () => {
    const { client, calls } = setup(() => jsonResponse(200, { messages: ['*part one*', 'part two'] }));

    expect(await client.completeChat(TOKEN, CHAT)).toEqual(['*part one*', 'part two']);
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.path).toBe('/api/v2/chat/complete');
    expect(calls[0]!.json).toEqual({ message: CHAT.message, expiryHours: 3 });
  });

  it('returns an empty list when apps/api says nothing', async () => {
    const { client } = setup(() => jsonResponse(200, { messages: [] }));
    expect(await client.completeChat(TOKEN, CHAT)).toEqual([]);
  });

  it('refuses a 401 as a token problem, so the caller can exchange the token again', async () => {
    const { client } = setup(() => jsonResponse(401, { error: 'unauthorized' }));
    expect(await thrown(client.completeChat(TOKEN, CHAT))).toBeInstanceOf(ApiUnauthorizedError);
  });

  it.each([
    ['a 500', () => jsonResponse(500, { error: 'boom' })],
    ['a 422', () => jsonResponse(422, { error: 'bad' })],
    ['a redirect', () => new Response(null, { status: 302, headers: { Location: 'http://elsewhere.test' } })],
    ['a 200 that is not JSON', () => new Response('<html>', { status: 200 })],
    ['a 200 with no messages list', () => jsonResponse(200, { messages: 'one string' })],
    ['a 200 with a non-string message', () => jsonResponse(200, { messages: [1] })],
  ])('raises MessageProcessingError for %s', async (_name, respond) => {
    const { client } = setup(respond);
    expect(await thrown(client.completeChat(TOKEN, CHAT))).toBeInstanceOf(MessageProcessingError);
  });

  it('raises MessageProcessingError for a network fault, without the URL in the message', async () => {
    const { client } = setup(() => {
      throw new TypeError('fetch failed for http://api.test');
    });
    const error = await thrown(client.completeChat(TOKEN, CHAT));
    expect(error).toBeInstanceOf(MessageProcessingError);
    expect((error as Error).message).not.toContain('api.test');
  });

  it('gives up after the chat deadline, which is longer than the other calls', async () => {
    const { client } = setup(
      (request) =>
        new Promise<Response>((_resolve, reject) => {
          request.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'TimeoutError')));
        }),
      { chatTimeoutMs: 20 },
    );
    expect(await thrown(client.completeChat(TOKEN, CHAT))).toBeInstanceOf(MessageProcessingError);
  });

  it("keeps the user's message, the answer and any error body out of the logs", async () => {
    const secret = 'a-very-distinctive-question';
    const { client, log } = setup(() => jsonResponse(500, { error: `echo ${secret}` }));
    await thrown(client.completeChat(TOKEN, { message: secret, expiryHours: 3 }));
    expect(log.text()).not.toContain(secret);
    expect(log.text()).not.toContain(TOKEN);
  });
});

describe('preferences', () => {
  it('reads every preference the user has', async () => {
    const { client, calls } = setup(() => jsonResponse(200, { [CHAT_RETENTION_PREFERENCE]: '6' }));
    expect(await client.getPreferences(TOKEN)).toEqual({ [CHAT_RETENTION_PREFERENCE]: '6' });
    expect(calls[0]!.method).toBe('GET');
    expect(calls[0]!.path).toBe('/api/v2/preferences');
  });

  it('saves one preference with a PUT of just that key', async () => {
    const { client, calls } = setup(() => jsonResponse(200, {}));
    await client.setPreference(TOKEN, CHAT_RETENTION_PREFERENCE, '12');
    expect(calls[0]!.method).toBe('PUT');
    expect(calls[0]!.json).toEqual({ [CHAT_RETENTION_PREFERENCE]: '12' });
  });

  it('a 401 is a token problem for both reads and writes', async () => {
    const { client } = setup(() => jsonResponse(401, {}));
    expect(await thrown(client.getPreferences(TOKEN))).toBeInstanceOf(ApiUnauthorizedError);
    expect(await thrown(client.setPreference(TOKEN, 'k', 'v'))).toBeInstanceOf(ApiUnauthorizedError);
  });

  it('a server error on a write is a PreferencesError', async () => {
    const { client } = setup(() => jsonResponse(500, {}));
    expect(await thrown(client.setPreference(TOKEN, 'k', 'v'))).toBeInstanceOf(PreferencesError);
  });

  it('a read that is not an object of strings is a PreferencesError', async () => {
    const { client } = setup(() => jsonResponse(200, ['not', 'an', 'object']));
    expect(await thrown(client.getPreferences(TOKEN))).toBeInstanceOf(PreferencesError);
  });
});

describe('AnsariClientMock', () => {
  it('answers with one message and keeps preferences per token', async () => {
    const mock = new AnsariClientMock({ logger: capturingLogger().logger });
    expect(await mock.completeChat('alice', CHAT)).toHaveLength(1);
    expect(await mock.getPreferences('alice')).toEqual({});
    await mock.setPreference('alice', CHAT_RETENTION_PREFERENCE, '0');
    expect(await mock.getPreferences('alice')).toEqual({ [CHAT_RETENTION_PREFERENCE]: '0' });
    expect(await mock.getPreferences('bob')).toEqual({});
  });

  it('refuses an empty token', async () => {
    const mock = new AnsariClientMock({ logger: capturingLogger().logger });
    expect(await thrown(mock.getPreferences(''))).toBeInstanceOf(PreferencesError);
    expect(await thrown(mock.completeChat('', CHAT))).toBeInstanceOf(MessageProcessingError);
  });
});
