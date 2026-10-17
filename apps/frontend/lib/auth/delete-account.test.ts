import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { setUnauthorizedHandler } from '@/lib/api/auth-bridge';
import { deleteAccountRequest } from '@/lib/auth/delete-account';
import { setAuthTokenGetter, setBaseUrl } from '@/vendor/api-client-react/custom-fetch';

// The agreed contract (#306): DELETE /api/v2/users/me on apps/api with the
// JWT, and nothing else; the client never calls apps/auth to delete.

type Call = { url: string; init: RequestInit & { headers: Headers } };
let calls: Call[];
let reply: () => Response;

beforeEach(() => {
  calls = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit & { headers: Headers }) => {
    calls.push({ url: String(url), init });
    return reply();
  });
  setBaseUrl('https://api.test');
  setAuthTokenGetter(() => 'APP-JWT');
});

afterEach(() => {
  vi.unstubAllGlobals();
  setBaseUrl(null);
  setAuthTokenGetter(null);
});

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('deleteAccountRequest', () => {
  it('sends DELETE /api/v2/users/me to apps/api with the JWT, no cookies', async () => {
    reply = () => json(200, { message: 'Account successfully deleted' });
    await deleteAccountRequest();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://api.test/api/v2/users/me');
    expect(calls[0]!.init.method).toBe('DELETE');
    expect(calls[0]!.init.headers.get('authorization')).toBe('Bearer APP-JWT');
    expect(calls[0]!.init.credentials).toBe('omit');
  });

  it.each([
    ['a 204 with no body', () => new Response(null, { status: 204 })],
    ['a 200 with another body', () => json(200, { ok: true })],
    ['a 200 with no body', () => new Response('', { status: 200 })],
  ])('any 2xx is success: %s', async (_label, response) => {
    reply = response;
    await expect(deleteAccountRequest()).resolves.toBeUndefined();
  });

  it('a 401 rejects with the status and is NOT retried through a refresh (one request)', async () => {
    // A live refresh handler, as the AuthProvider registers it: the refresh
    // wrapper would call it and retry with a fresh JWT. The delete must not.
    const refresh = vi.fn(async () => 'FRESH-JWT');
    setUnauthorizedHandler(refresh);
    try {
      reply = () => json(401, { detail: 'Token not found or expired' });
      await expect(deleteAccountRequest()).rejects.toMatchObject({ status: 401 });
      expect(refresh).not.toHaveBeenCalled();
      expect(calls).toHaveLength(1);
    } finally {
      setUnauthorizedHandler(null);
    }
  });

  it('a 5xx rejects', async () => {
    reply = () => json(503, { detail: 'Authentication service unavailable' });
    await expect(deleteAccountRequest()).rejects.toMatchObject({ status: 503 });
  });
});
