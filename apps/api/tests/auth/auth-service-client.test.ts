import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { SignJWT } from 'jose';
import {
  AuthServiceUnavailableError,
  authServiceFetch,
  deleteAuthUser,
  getAuthAccount,
  NotTheSubjectError,
} from '@/lib/auth-service/client';
import { revokeSessions } from '@/lib/auth-service/legacy';
import { setApiEnv, TEST_LAYER_ORIGIN } from './helpers';

/**
 * The auth-service client against a stub that answers whatever a test sets,
 * for the responses the real apps/auth never sends: a 5xx carrying a
 * valid-looking body, an account for another id, a bad shape. It also shows
 * what apps/api sends: no credential, no forwarded IP (owner amendment
 * 2026-10-17).
 */

let server: Server;
let reply: { status: number; body?: string };
let seen: { method?: string; url?: string; headers: IncomingHttpHeaders }[];

beforeAll(async () => {
  server = createServer((req, res) => {
    seen.push({ method: req.method, url: req.url, headers: req.headers });
    res.writeHead(reply.status, { 'content-type': 'application/json' });
    res.end(reply.body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  seen = [];
  reply = { status: 200, body: '{}' };
  setApiEnv(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
});

const account = (id: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    id,
    email: 'a@b.test',
    first_name: null,
    last_name: null,
    registered_via: null,
    role: 'user',
    banned: false,
    ...extra,
  });

async function unavailableStatus(promise: Promise<unknown>) {
  const err = await promise.then(
    () => null,
    (e: unknown) => e
  );
  expect(err).toBeInstanceOf(AuthServiceUnavailableError);
  return (err as AuthServiceUnavailableError).status;
}

describe('authServiceFetch', () => {
  it('sends the Origin and the bearer, and nothing of the removed internal hop', async () => {
    await authServiceFetch('/api/x', { bearer: 'jwt-value' });
    expect(seen[0].headers.authorization).toBe('Bearer jwt-value');
    expect(seen[0].headers.origin).toBe(TEST_LAYER_ORIGIN);
    for (const name of Object.keys(seen[0].headers)) {
      expect(name.startsWith('x-ansari-internal')).toBe(false);
      expect(name.startsWith('x-ansari-forwarded')).toBe(false);
    }
  });

  it('an anonymous call sends no Authorization header', async () => {
    await authServiceFetch('/api/auth/sign-in/email', { body: {} });
    expect(seen[0].headers.authorization).toBeUndefined();
  });
});

describe('getAuthAccount', () => {
  it('asks /api/account/me with the bearer, and returns the account for the sub it expects', async () => {
    const id = randomUUID();
    reply = { status: 200, body: account(id, { role: 'admin' }) };
    const got = await getAuthAccount(id, 'subject-jwt');
    expect(got).toMatchObject({ id, role: 'admin', banned: false });
    expect(seen[0]).toMatchObject({ method: 'GET', url: '/api/account/me' });
    expect(seen[0].headers.authorization).toBe('Bearer subject-jwt');
  });

  it('401 (the session ended) and 404 (no such user) are null', async () => {
    for (const status of [401, 404]) {
      reply = { status };
      expect(await getAuthAccount(randomUUID(), 'x')).toBeNull();
    }
  });

  it('a 5xx and a 429 are unavailable even with a valid-looking body', async () => {
    const id = randomUUID();
    for (const status of [500, 503, 429]) {
      reply = { status, body: account(id) };
      expect(await unavailableStatus(getAuthAccount(id, 'x'))).toBe(status);
    }
  });

  it('an account for another id is unavailable, never used', async () => {
    reply = { status: 200, body: account(randomUUID()) };
    expect(await unavailableStatus(getAuthAccount(randomUUID(), 'x'))).toBe(200);
  });

  it('a bad shape or bad JSON is unavailable', async () => {
    reply = { status: 200, body: '{"id":1}' };
    expect(await unavailableStatus(getAuthAccount(randomUUID(), 'x'))).toBe(200);
    reply = { status: 200, body: 'not json' };
    expect(await unavailableStatus(getAuthAccount(randomUUID(), 'x'))).toBe(200);
  });

  it('no listener is unavailable with no status', async () => {
    await new Promise((resolve) => server.close(resolve));
    try {
      expect(await unavailableStatus(getAuthAccount(randomUUID(), 'x'))).toBeNull();
    } finally {
      await new Promise<void>((resolve) =>
        server.listen(Number(new URL(process.env.AUTH_URL!).port), '127.0.0.1', resolve)
      );
    }
  });
});

/** A token-shaped value whose payload names `sub` (the signature is never checked here). */
const tokenFor = (sub: string) =>
  new SignJWT({ sub }).setProtectedHeader({ alg: 'HS256' }).sign(new TextEncoder().encode('k'.repeat(32)));

describe('deleteAuthUser', () => {
  it("sends DELETE /api/account with the subject's own JWT; only 204 is done", async () => {
    const id = randomUUID();
    const jwt = await tokenFor(id);
    reply = { status: 204 };
    await deleteAuthUser(id, jwt);
    expect(seen[0]).toMatchObject({ method: 'DELETE', url: '/api/account' });
    expect(seen[0].headers.authorization).toBe(`Bearer ${jwt}`);
    for (const status of [401, 403, 429, 500]) {
      reply = { status };
      expect(await unavailableStatus(deleteAuthUser(id, jwt))).toBe(status);
    }
  });

  it("refuses, with no call at all, a token that is not the subject's own", async () => {
    reply = { status: 204 };
    for (const jwt of [await tokenFor(randomUUID()), 'not.a.jwt', '']) {
      await expect(deleteAuthUser(randomUUID(), jwt)).rejects.toBeInstanceOf(NotTheSubjectError);
    }
    expect(seen).toEqual([]);
  });
});

describe('revokeSessions', () => {
  it('POSTs /api/account/revoke-sessions with the JWT; 204 true, 401 false, else unavailable', async () => {
    reply = { status: 204 };
    expect(await revokeSessions('subject-jwt')).toBe(true);
    expect(seen[0]).toMatchObject({ method: 'POST', url: '/api/account/revoke-sessions' });
    expect(seen[0].headers.authorization).toBe('Bearer subject-jwt');
    reply = { status: 401 };
    expect(await revokeSessions('x')).toBe(false);
    reply = { status: 500 };
    expect(await unavailableStatus(revokeSessions('x'))).toBe(500);
  });
});
