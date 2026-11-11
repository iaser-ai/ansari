import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AUTH_SERVICE_TIMEOUT_MS,
  AuthServiceUnavailableError,
  SERVICE_VERIFY_PATH,
  verifyServiceKey,
} from '@/lib/auth-service/client';
import { setApiEnv, TEST_LAYER_ORIGIN } from './helpers';

/**
 * apps/api's client for apps/auth's service-key verify route (#314), against a
 * stubbed fetch. Only an exact `{ valid: false }` is a refusal; every other
 * answer apps/auth could give (or fail to give) throws
 * AuthServiceUnavailableError so the route fails closed (503), never open.
 */

const AUTH_URL = 'https://auth.verify-test.example';
const KEY = 'ansari_mcp_test_key_value_0123456789';

let fetchMock: ReturnType<typeof vi.fn>;

function answer(status: number, body: unknown, raw = false) {
  fetchMock.mockResolvedValue(
    new Response(raw ? (body as string) : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })
  );
}

async function unavailable(promise: Promise<unknown>) {
  const err = await promise.then(
    () => null,
    (e: unknown) => e
  );
  expect(err).toBeInstanceOf(AuthServiceUnavailableError);
  return (err as AuthServiceUnavailableError).status;
}

beforeEach(() => {
  setApiEnv(AUTH_URL);
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('verifyServiceKey: the request', () => {
  it('POSTs exactly { key, permissions: { mcp: [complete] } } to the verify path, with no Authorization', async () => {
    answer(200, { valid: false });
    await verifyServiceKey(KEY);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(String(url)).toBe(`${AUTH_URL}${SERVICE_VERIFY_PATH}`);
    expect(SERVICE_VERIFY_PATH).toBe('/api/service/verify-key');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toStrictEqual({
      key: KEY,
      permissions: { mcp: ['complete'] },
    });
    const headers = init.headers as Record<string, string>;
    expect(Object.keys(headers).map((h) => h.toLowerCase())).not.toContain('authorization');
    expect(headers['content-type']).toBe('application/json');
    expect(headers.origin).toBe(TEST_LAYER_ORIGIN);
  });
});

describe('verifyServiceKey: the verdicts', () => {
  it('a 200 valid answer maps to { valid, clientId, keyId }', async () => {
    answer(200, { valid: true, client_id: 'ansari-mcp', key_id: 'key-1' });
    await expect(verifyServiceKey(KEY)).resolves.toStrictEqual({
      valid: true,
      clientId: 'ansari-mcp',
      keyId: 'key-1',
    });
  });

  it('a suffixed ansari-mcp client id is accepted', async () => {
    answer(200, { valid: true, client_id: 'ansari-mcp-partner.v2', key_id: 'key-2' });
    await expect(verifyServiceKey(KEY)).resolves.toMatchObject({ clientId: 'ansari-mcp-partner.v2' });
  });

  it('a 200 { valid: false } maps to { valid: false }', async () => {
    answer(200, { valid: false });
    await expect(verifyServiceKey(KEY)).resolves.toStrictEqual({ valid: false });
  });
});

describe('verifyServiceKey: everything else fails closed', () => {
  it('a network error', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    expect(await unavailable(verifyServiceKey(KEY))).toBeNull();
  });

  it(`an answer slower than ${AUTH_SERVICE_TIMEOUT_MS} ms aborts`, async () => {
    vi.useFakeTimers();
    // Node's AbortSignal.timeout runs on an internal timer fake timers cannot
    // drive, so stand in one built on setTimeout and check the delay it is given.
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException('timed out', 'TimeoutError')), ms);
      return controller.signal;
    });
    fetchMock.mockImplementation(
      (_url: URL, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
        })
    );

    let settled = false;
    const result = unavailable(verifyServiceKey(KEY)).finally(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(AUTH_SERVICE_TIMEOUT_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toBeNull();
    expect(timeout).toHaveBeenCalledWith(3_000);
  });

  it.each([500, 429, 404, 401, 400, 204, 302])('a %i', async (status) => {
    fetchMock.mockResolvedValue(
      new Response(status === 204 ? null : JSON.stringify({ valid: false }), { status })
    );
    expect(await unavailable(verifyServiceKey(KEY))).toBe(status);
  });

  it('a 200 that is not JSON', async () => {
    answer(200, '<html>not json</html>', true);
    expect(await unavailable(verifyServiceKey(KEY))).toBe(200);
  });

  it.each([
    ['valid: true without key_id', { valid: true, client_id: 'ansari-mcp' }],
    ['valid: true without client_id', { valid: true, key_id: 'key-1' }],
    ['valid: true with an empty key_id', { valid: true, client_id: 'ansari-mcp', key_id: '' }],
    ['a client_id of claude-skill', { valid: true, client_id: 'claude-skill', key_id: 'key-1' }],
    ['a client_id of askansari-whatsapp', { valid: true, client_id: 'askansari-whatsapp', key_id: 'key-1' }],
    ['an upper-case client_id', { valid: true, client_id: 'ANSARI-MCP', key_id: 'key-1' }],
    ['a client_id over 64 characters', { valid: true, client_id: `ansari-mcp-${'a'.repeat(54)}`, key_id: 'k' }],
    ['valid: "true"', { valid: 'true', client_id: 'ansari-mcp', key_id: 'key-1' }],
    ['valid: "false"', { valid: 'false' }],
    ['valid: false with extra detail', { valid: false, reason: 'expired' }],
    ['no valid field', { client_id: 'ansari-mcp', key_id: 'key-1' }],
    ['null', null],
    ['an array', [{ valid: false }]],
  ])('a 200 with %s', async (_label, body) => {
    answer(200, body);
    expect(await unavailable(verifyServiceKey(KEY))).toBe(200);
  });
});
