import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuthError, createAuthApi } from '@/lib/auth/api';
import {
  customFetch,
  setAuthTokenGetter,
  setBaseUrl,
} from '@/vendor/api-client-react/custom-fetch';

/**
 * The apps/auth client against a fetch double. What it must hold on every
 * platform: one bearer transport (no cookies: `credentials: 'omit'` on every
 * request), the session token only where a session is needed, the apps/api JWT
 * never sent to apps/auth, and `X-Ansari-Client` on every call. The response
 * shapes themselves are pinned against a REAL apps/auth in
 * apps/auth/tests/frontend-client.test.ts.
 */

const AUTH = 'https://auth.test';
const API = 'https://api.test';

type Call = { url: string; init: RequestInit & { headers: Headers } };
let calls: Call[];
let reply: () => Response | Promise<Response>;

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

const SESSION_BODY = {
  token: 'session-abc',
  user: { id: 'u1', email: 'a@example.com', first_name: 'Amina', last_name: null },
};

beforeEach(() => {
  calls = [];
  reply = () => json(200, SESSION_BODY);
  vi.stubGlobal('fetch', async (url: string, init: RequestInit & { headers: Headers }) => {
    calls.push({ url: String(url), init });
    return reply();
  });
  setBaseUrl(API);
  // The provider's getter: the apps/api JWT. It must never reach apps/auth.
  setAuthTokenGetter(() => 'APP-JWT');
});

afterEach(() => {
  vi.unstubAllGlobals();
  setBaseUrl(null);
  setAuthTokenGetter(null);
});

const api = createAuthApi({ baseUrl: AUTH, clientId: 'askansari-ios' });

describe('one bearer transport', () => {
  const paths: [string, () => Promise<unknown>, () => Response][] = [
    ['sign-in', () => api.signIn('a@example.com', 'pw'), () => json(200, SESSION_BODY)],
    [
      'sign-up',
      () => api.signUp({ email: 'a@example.com', password: 'pw' }),
      () => json(200, SESSION_BODY),
    ],
    ['token', () => api.mintJwt('session-abc'), () => json(200, { token: 'jwt' })],
    ['sign-out', () => api.signOut('session-abc'), () => json(200, { success: true })],
    [
      'request-password-reset',
      () => api.requestPasswordReset('a@example.com'),
      () => json(200, { status: true }),
    ],
    [
      'reset-password',
      () => api.resetPassword('reset-tok', 'New-pass-123!'),
      () => json(200, { status: true }),
    ],
    ['apps/api (customFetch)', () => customFetch('/api/v2/threads'), () => json(200, [])],
  ];

  it.each(paths)('%s sends credentials: omit', async (_label, call, response) => {
    reply = response;
    await call();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.init.credentials).toBe('omit');
  });

  it('a caller cannot turn cookies back on', async () => {
    reply = () => json(200, []);
    await customFetch('/api/v2/threads', { credentials: 'include' });
    expect(calls[0]!.init.credentials).toBe('omit');
  });
});

describe('what each call sends', () => {
  it('sign-in: POST, credentials in the body, client id, no bearer at all', async () => {
    const session = await api.signIn('a@example.com', 'pw');
    const { url, init } = calls[0]!;
    expect(url).toBe(`${AUTH}/api/auth/sign-in/email`);
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ email: 'a@example.com', password: 'pw' });
    expect(init.headers.get('x-ansari-client')).toBe('askansari-ios');
    expect(init.headers.get('authorization')).toBeNull();
    expect(session).toEqual({ sessionToken: 'session-abc', firstName: 'Amina', lastName: '' });
  });

  it('sign-up: the names and the mail-list opt-in go in the body', async () => {
    await api.signUp({
      email: 'a@example.com',
      password: 'pw',
      firstName: 'Amina',
      lastName: 'Yusuf',
      registerToMailList: true,
    });
    const { url, init } = calls[0]!;
    expect(url).toBe(`${AUTH}/api/auth/sign-up/email`);
    expect(JSON.parse(String(init.body))).toEqual({
      email: 'a@example.com',
      password: 'pw',
      first_name: 'Amina',
      last_name: 'Yusuf',
      register_to_mail_list: true,
    });
    expect(init.headers.get('x-ansari-client')).toBe('askansari-ios');
    expect(init.headers.get('authorization')).toBeNull();
  });

  it('sign-up defaults the opt-in to false', async () => {
    await api.signUp({ email: 'a@example.com', password: 'pw' });
    expect(JSON.parse(String(calls[0]!.init.body)).register_to_mail_list).toBe(false);
  });

  it('/token: GET with the SESSION token as the bearer, never the apps/api JWT', async () => {
    reply = () => json(200, { token: 'fresh-jwt' });
    expect(await api.mintJwt('session-abc')).toBe('fresh-jwt');
    const { url, init } = calls[0]!;
    expect(url).toBe(`${AUTH}/api/auth/token`);
    expect(init.method).toBe('GET');
    expect(init.headers.get('authorization')).toBe('Bearer session-abc');
    expect(init.headers.get('x-ansari-client')).toBe('askansari-ios');
  });

  it('sign-out: POST with the session token as the bearer', async () => {
    reply = () => json(200, { success: true });
    await api.signOut('session-abc');
    const { url, init } = calls[0]!;
    expect(url).toBe(`${AUTH}/api/auth/sign-out`);
    expect(init.method).toBe('POST');
    expect(init.headers.get('authorization')).toBe('Bearer session-abc');
  });

  it('request-password-reset: POST the email, no bearer', async () => {
    reply = () => json(200, { status: true, message: 'If this email exists…' });
    await api.requestPasswordReset('a@example.com');
    const { url, init } = calls[0]!;
    expect(url).toBe(`${AUTH}/api/auth/request-password-reset`);
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ email: 'a@example.com' });
    expect(init.headers.get('authorization')).toBeNull();
    expect(init.headers.get('x-ansari-client')).toBe('askansari-ios');
  });

  it('reset-password: the token goes in the BODY, never the URL; no bearer', async () => {
    reply = () => json(200, { status: true });
    await api.resetPassword('reset-tok', 'New-pass-123!');
    const { url, init } = calls[0]!;
    expect(url).toBe(`${AUTH}/api/auth/reset-password`);
    expect(url).not.toContain('reset-tok');
    expect(JSON.parse(String(init.body))).toEqual({ token: 'reset-tok', newPassword: 'New-pass-123!' });
    expect(init.headers.get('authorization')).toBeNull();
  });

  it('the apps/api JWT goes to base-URL requests only', async () => {
    reply = () => json(200, []);
    await customFetch('/api/v2/threads');
    await customFetch(`${AUTH}/anything`);
    expect(calls[0]!.url).toBe(`${API}/api/v2/threads`);
    expect(calls[0]!.init.headers.get('authorization')).toBe('Bearer APP-JWT');
    expect(calls[1]!.init.headers.get('authorization')).toBeNull();
  });
});

describe('failures become AuthErrors the provider can classify', () => {
  async function failure(call: () => Promise<unknown>): Promise<AuthError> {
    try {
      await call();
    } catch (error) {
      expect(error).toBeInstanceOf(AuthError);
      return error as AuthError;
    }
    throw new Error('expected a failure');
  }

  it('401 from sign-in keeps the status and the server message', async () => {
    reply = () => json(401, { code: 'INVALID_EMAIL_OR_PASSWORD', message: 'Invalid email or password' });
    const error = await failure(() => api.signIn('a@example.com', 'wrong'));
    expect([error.status, error.endpoint, error.message]).toEqual([
      401,
      'sign-in',
      'Invalid email or password',
    ]);
  });

  it('409 from sign-up keeps the server message', async () => {
    reply = () => json(409, { message: 'An account with this email already exists' });
    const error = await failure(() => api.signUp({ email: 'a@example.com', password: 'pw' }));
    expect([error.status, error.endpoint, error.message]).toEqual([
      409,
      'sign-up',
      'An account with this email already exists',
    ]);
  });

  it('429 is a rate limit, whatever the body', async () => {
    reply = () => json(429, { message: 'Too many requests' }, { 'x-retry-after': '60' });
    const error = await failure(() => api.signIn('a@example.com', 'pw'));
    expect([error.status, error.endpoint]).toEqual([429, 'sign-in']);
    expect(error.message).toMatch(/too many attempts/i);
  });

  it('5xx is unavailable, never a credentials error', async () => {
    reply = () => json(503, { message: 'down' });
    const error = await failure(() => api.signIn('a@example.com', 'pw'));
    expect(error.status).toBe(503);
    expect(error.message).toMatch(/unavailable/i);
  });

  it('a network error is status 0', async () => {
    reply = () => {
      throw new TypeError('Network request failed');
    };
    const error = await failure(() => api.signIn('a@example.com', 'pw'));
    expect([error.status, error.endpoint]).toEqual([0, 'sign-in']);
  });

  it('a 200 of the wrong shape is status 0, not a session', async () => {
    reply = () => json(200, { user: { id: 'u1' } });
    const error = await failure(() => api.signIn('a@example.com', 'pw'));
    expect(error.status).toBe(0);
  });

  it('400 from reset-password keeps the server message (the screen keys on it)', async () => {
    reply = () => json(400, { code: 'INVALID_TOKEN', message: 'Invalid or expired reset token' });
    const error = await failure(() => api.resetPassword('dead', 'New-pass-123!'));
    expect([error.status, error.endpoint, error.message]).toEqual([
      400,
      'reset-password',
      'Invalid or expired reset token',
    ]);
  });

  it('401 from /token is tagged as the token endpoint', async () => {
    reply = () => json(401, { message: 'Unauthorized' });
    const error = await failure(() => api.mintJwt('dead-session'));
    expect([error.status, error.endpoint]).toEqual([401, 'token']);
  });
});
