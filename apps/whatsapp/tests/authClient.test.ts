/**
 * The apps/auth client.
 *
 * Python tests ported: `test_auth_statuses.py` (each status means something different, the 429 cool-down, `forget`) and the
 * auth-client cases of `test_bsuid_auth_flow.py` (bearer key, one token per BSUID, failures not cached, no token in the
 * answer). The Python tests patched `httpx.AsyncClient` and `time.monotonic`; here the client takes `fetch` and a clock.
 */
import { describe, expect, it } from 'vitest';
import { Secret } from '../src/config';
import {
  AuthBadRequestError,
  AuthKeyRejectedError,
  AuthRateLimitedError,
  AuthTokenError,
  AuthUserBannedError,
} from '../src/errors';
import {
  AuthClientMock,
  AuthClientReal,
  DEFAULT_RETRY_AFTER_SECONDS,
  SESSION_PATH,
  TOKEN_CACHE_SECONDS,
} from '../src/services/authClient';
import { capturingLogger, fakeFetch, jsonResponse, type Handler } from './helpers/network';

const BSUID = 'US.13491208655302741918';
const OTHER = 'US.99999999999999999999';

function setup(handler: Handler, options: { maxEntries?: number } = {}) {
  const net = fakeFetch(handler);
  const log = capturingLogger();
  const clock = { now: 1_000_000 };
  const client = new AuthClientReal({
    baseUrl: 'http://auth.test/',
    apiKey: new Secret('the-service-key'),
    logger: log.logger,
    fetch: net.fetch,
    now: () => clock.now,
    ...options,
  });
  return { client, clock, log, ...net };
}

/** Run `promise` and return what it threw. */
async function thrown(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected an error, but the call succeeded');
}

describe('the exchange', () => {
  it('sends the BSUID with the service key as a bearer token, and returns the token', async () => {
    const { client, calls } = setup(() => jsonResponse(200, { token: 'jwt-123' }));

    expect(await client.getToken(BSUID)).toBe('jwt-123');

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`http://auth.test${SESSION_PATH}`);
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.headers.authorization).toBe('Bearer the-service-key');
    expect(calls[0]!.headers['x-whatsapp-api-key']).toBeUndefined();
    expect(calls[0]!.json).toEqual({ bsuid: BSUID });
  });

  it('never follows a redirect, so the key is not sent anywhere else', async () => {
    const { client, calls } = setup(() => new Response(null, { status: 302, headers: { Location: 'http://evil.test/' } }));
    expect(await thrown(client.getToken(BSUID))).toBeInstanceOf(AuthTokenError);
    expect(calls[0]!.redirect).toBe('manual');
    expect(calls).toHaveLength(1);
  });

  it('gives the request a deadline', async () => {
    const { client, calls } = setup(() => jsonResponse(200, { token: 't' }));
    await client.getToken(BSUID);
    expect(calls[0]!.signal).toBeInstanceOf(AbortSignal);
  });

  it('never logs the service key or the token', async () => {
    const { client, log } = setup(() => jsonResponse(200, { token: 'jwt-secret-value' }));
    await client.getToken(BSUID);
    expect(log.text()).not.toContain('the-service-key');
    expect(log.text()).not.toContain('jwt-secret-value');
  });
});

describe('the token cache', () => {
  it('reuses a token per BSUID until it is nearly expired', async () => {
    const seen: string[] = [];
    const { client, clock } = setup((request) => {
      seen.push((request.json as { bsuid: string }).bsuid);
      return jsonResponse(200, { token: `jwt-${seen.length}` });
    });

    const first = await client.getToken(BSUID);
    const again = await client.getToken(BSUID);
    const other = await client.getToken(OTHER);
    clock.now += (TOKEN_CACHE_SECONDS + 1) * 1000;
    const renewed = await client.getToken(BSUID);

    expect([first, again]).toEqual(['jwt-1', 'jwt-1']);
    expect(other).toBe('jwt-2');
    expect(renewed).toBe('jwt-3');
    expect(seen).toEqual([BSUID, OTHER, BSUID]);
  });

  it('reuses a token for a bit less than the 15 minutes it lives', () => {
    expect(TOKEN_CACHE_SECONDS).toBe(14 * 60);
  });

  it('does not cache a failure', async () => {
    const answers = [jsonResponse(500, { message: 'boom' }), jsonResponse(200, { token: 'jwt-ok' })];
    const { client } = setup(() => answers.shift()!);

    expect(await thrown(client.getToken(BSUID))).toBeInstanceOf(AuthTokenError);
    expect(await client.getToken(BSUID)).toBe('jwt-ok');
  });

  it('drops only that user\'s token on forget()', async () => {
    const asked: string[] = [];
    const { client } = setup((request) => {
      asked.push((request.json as { bsuid: string }).bsuid);
      return jsonResponse(200, { token: `jwt-${asked.length}` });
    });
    await client.getToken(BSUID);
    await client.getToken(OTHER);

    client.forget(BSUID);

    expect(await client.getToken(BSUID)).toBe('jwt-3');
    expect(await client.getToken(OTHER)).toBe('jwt-2');
    expect(asked).toEqual([BSUID, OTHER, BSUID]);
  });

  it('stops remembering new users once the cache is full of live entries, instead of growing', async () => {
    const { client, calls } = setup(() => jsonResponse(200, { token: 't' }), { maxEntries: 2 });
    for (const id of ['US.1', 'US.2', 'US.3']) await client.getToken(id);
    const callsBefore = calls.length;
    await client.getToken('US.1');
    await client.getToken('US.3');
    expect(calls.length - callsBefore).toBe(1);
  });

  it('makes room by dropping expired tokens first', async () => {
    const { client, clock, calls } = setup(() => jsonResponse(200, { token: 't' }), { maxEntries: 2 });
    await client.getToken('US.1');
    await client.getToken('US.2');
    clock.now += (TOKEN_CACHE_SECONDS + 1) * 1000;
    await client.getToken('US.3');
    const callsBefore = calls.length;
    await client.getToken('US.3');
    expect(calls.length).toBe(callsBefore);
  });
});

describe('each status means something different', () => {
  it.each([
    [400, AuthBadRequestError],
    [401, AuthKeyRejectedError],
    [403, AuthUserBannedError],
    [500, AuthTokenError],
  ] as const)('HTTP %s raises exactly its own error', async (status, expected) => {
    const { client } = setup(() => jsonResponse(status, { message: 'x' }));
    const error = await thrown(client.getToken(BSUID));
    expect(error).toBeInstanceOf(expected);
    expect((error as Error).constructor).toBe(expected);
  });

  it('does not mistake a 500 for a more specific refusal', async () => {
    const { client } = setup(() => jsonResponse(500, { message: 'Internal error' }));
    const error = await thrown(client.getToken(BSUID));
    for (const specific of [AuthBadRequestError, AuthKeyRejectedError, AuthUserBannedError, AuthRateLimitedError]) {
      expect(error).not.toBeInstanceOf(specific);
    }
  });

  it('treats any other failing status as a plain exchange failure', async () => {
    const { client } = setup(() => jsonResponse(502, {}));
    const error = await thrown(client.getToken(BSUID));
    expect((error as Error).constructor).toBe(AuthTokenError);
  });

  it('keeps every refusal an AuthTokenError, so a caller can catch them all', async () => {
    for (const status of [400, 401, 403, 429, 500]) {
      const { client } = setup(() => jsonResponse(status, {}));
      expect(await thrown(client.getToken(BSUID))).toBeInstanceOf(AuthTokenError);
    }
  });
});

describe('a spent budget (HTTP 429)', () => {
  it('carries how long to wait', async () => {
    const { client } = setup(() => jsonResponse(429, { message: 'Too many requests' }, { 'X-Retry-After': '420' }));
    const error = (await thrown(client.getToken(BSUID))) as AuthRateLimitedError;
    expect(error).toBeInstanceOf(AuthRateLimitedError);
    expect(error.retryAfter).toBe(420);
  });

  // Python's int() accepts these shapes too; a header of "12.5", "1e3" or "" is not a whole number in either language
  it.each([[null], ['soon'], ['0'], ['-5'], [''], ['12.5'], ['1e3']])(
    'falls back to a default when the wait is %j',
    async (header) => {
      const headers: Record<string, string> = header === null ? {} : { 'X-Retry-After': header };
      const { client } = setup(() => jsonResponse(429, {}, headers));
      const error = (await thrown(client.getToken(BSUID))) as AuthRateLimitedError;
      expect(error.retryAfter).toBe(DEFAULT_RETRY_AFTER_SECONDS);
    },
  );

  it('reads a wait padded with spaces, like Python', async () => {
    const { client } = setup(() => jsonResponse(429, {}, { 'X-Retry-After': ' 90 ' }));
    expect(((await thrown(client.getToken(BSUID))) as AuthRateLimitedError).retryAfter).toBe(90);
  });

  it('falls back to the user\'s whole fifteen-minute window', () => {
    expect(DEFAULT_RETRY_AFTER_SECONDS).toBe(15 * 60);
  });

  it('does not ask apps/auth again for that user until the budget frees up', async () => {
    const answers = [jsonResponse(429, {}, { 'X-Retry-After': '120' }), jsonResponse(200, { token: 'jwt-after-cooldown' })];
    const { client, clock, calls } = setup(() => answers.shift()!);

    expect(await thrown(client.getToken(BSUID))).toBeInstanceOf(AuthRateLimitedError);
    clock.now += 30_000;
    const still = (await thrown(client.getToken(BSUID))) as AuthRateLimitedError;
    expect(calls).toHaveLength(1); // a cooling-down user must not reach apps/auth again
    expect(still.retryAfter).toBeGreaterThan(0);
    expect(still.retryAfter).toBeLessThanOrEqual(91);

    clock.now += 91_000;
    expect(await client.getToken(BSUID)).toBe('jwt-after-cooldown');
    expect(calls).toHaveLength(2);
  });

  it('does not let one user\'s cool-down affect another', async () => {
    const { client } = setup((request) =>
      (request.json as { bsuid: string }).bsuid === BSUID
        ? jsonResponse(429, {}, { 'X-Retry-After': '600' })
        : jsonResponse(200, { token: 'jwt-other' }),
    );
    expect(await thrown(client.getToken(BSUID))).toBeInstanceOf(AuthRateLimitedError);
    expect(await client.getToken(OTHER)).toBe('jwt-other');
  });

  it('bounds how many cool-downs it remembers', async () => {
    const { client, calls } = setup(() => jsonResponse(429, {}, { 'X-Retry-After': '600' }), { maxEntries: 2 });
    for (const id of ['US.1', 'US.2', 'US.3']) await thrown(client.getToken(id));
    const before = calls.length;
    await thrown(client.getToken('US.1'));
    await thrown(client.getToken('US.3'));
    // US.1 is cooling down (no call); US.3 was not remembered (one call)
    expect(calls.length - before).toBe(1);
  });
});

describe('a banned user', () => {
  it('is not cached or cooled down, so being unbanned takes effect at once', async () => {
    const answers = [jsonResponse(403, {}), jsonResponse(200, { token: 'jwt-unbanned' })];
    const { client } = setup(() => answers.shift()!);
    expect(await thrown(client.getToken(BSUID))).toBeInstanceOf(AuthUserBannedError);
    expect(await client.getToken(BSUID)).toBe('jwt-unbanned');
  });
});

describe('answers that are not a token', () => {
  it('raises on a network fault, without leaking the URL', async () => {
    const { client, log } = setup(() => {
      throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('connect ECONNREFUSED http://auth.test'), { code: 'ECONNREFUSED' }) });
    });
    const error = await thrown(client.getToken(BSUID));
    expect(error).toBeInstanceOf(AuthTokenError);
    expect(log.text()).toContain('TypeError/ECONNREFUSED');
    expect(log.text()).not.toContain('auth.test');
  });

  it('raises when the request times out', async () => {
    const { client } = setup(() => {
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    });
    expect(await thrown(client.getToken(BSUID))).toBeInstanceOf(AuthTokenError);
  });

  it.each([
    ['an empty object', () => jsonResponse(200, {})],
    ['a null token', () => jsonResponse(200, { token: null })],
    ['an empty token', () => jsonResponse(200, { token: '' })],
    ['a numeric token', () => jsonResponse(200, { token: 42 })],
    ['JSON null', () => jsonResponse(200, null)],
    ['a JSON list', () => jsonResponse(200, ['jwt'])],
    ['text that is not JSON', () => new Response('not json', { status: 200 })],
  ] as const)('raises on %s', async (_name, answer) => {
    const { client } = setup(answer);
    expect(await thrown(client.getToken(BSUID))).toBeInstanceOf(AuthTokenError);
  });
});

describe('AuthClientMock', () => {
  const log = capturingLogger();
  void log;

  it('gives the same BSUID the same token and a new BSUID a new one', async () => {
    const mock = new AuthClientMock();
    const first = await mock.getToken(BSUID);
    expect(await mock.getToken(BSUID)).toBe(first);
    expect(await mock.getToken(OTHER)).not.toBe(first);
  });

  it('returns the one configured JWT for every BSUID when MOCK_AUTH_TOKEN is set', async () => {
    const mock = new AuthClientMock({ fixedToken: new Secret('a.real.jwt') });
    expect(await mock.getToken(BSUID)).toBe('a.real.jwt');
    expect(await mock.getToken(OTHER)).toBe('a.real.jwt');
  });

  it('refuses a missing BSUID', async () => {
    expect(await thrown(new AuthClientMock().getToken(''))).toBeInstanceOf(AuthTokenError);
  });

  it('keeps forget() harmless', () => {
    expect(() => new AuthClientMock().forget()).not.toThrow();
  });
});
