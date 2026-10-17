// Tokens and sessions (spec 300, phase 3): the bearer plugin accepts the raw
// session token the compatibility layer holds, the JWT carries exactly
// {sub, sid, iss, aud, exp, iat} for 15 minutes, and a session lasts 30 days
// and slides forward on a /token exchange once a day has passed.
import { randomUUID } from 'node:crypto';

import type { PGlite } from '@electric-sql/pglite';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { createAuth, type Auth, type Db } from '../../src/index';
import {
  drizzleFor,
  migrate,
  setAuthEnv,
  TEST_JWT_AUDIENCE,
  TEST_JWT_ISSUER,
} from '../helpers/auth-db';
import {
  BASE,
  call,
  decodeJwt,
  insertLegacyUser,
  json,
  legacyBcryptHash,
  mintJwt,
  sessionByToken,
  signIn,
} from '../helpers/http';

let client: PGlite;
let db: Db;
let auth: Auth;

const PASSWORD = 'Token-Passw0rd!';
const DAY_MS = 24 * 60 * 60 * 1000;

beforeAll(async () => {
  setAuthEnv(BASE);
  client = await migrate();
  db = drizzleFor(client);
  auth = createAuth(db);
});

afterAll(async () => {
  await client?.close();
});

afterEach(() => {
  vi.useRealTimers();
});

async function newUser(): Promise<{ id: string; email: string }> {
  const id = randomUUID();
  const email = `tok-${id.slice(0, 8)}@example.com`;
  await insertLegacyUser(db, { id, email, passwordHash: await legacyBcryptHash(PASSWORD) });
  return { id, email };
}

async function signedInUser() {
  const user = await newUser();
  const { res, token } = await signIn(auth, user.email, PASSWORD);
  expect(res.status).toBe(200);
  return { ...user, token: token!, signedToken: res.headers.get('set-auth-token')! };
}

describe('bearer: requireSignature stays unset', () => {
  it('the raw session token from sign-in (what the layer returns as refresh_token) mints a JWT', async () => {
    const { token } = await signedInUser();
    expect(token).not.toContain('.');

    const res = await mintJwt(auth, token);
    expect(res.status).toBe(200);
    expect(typeof (await json<{ token: string }>(res)).token).toBe('string');
  });

  it('the signed token from set-auth-token also mints a JWT', async () => {
    const { token, signedToken } = await signedInUser();
    expect(signedToken.startsWith(`${token}.`)).toBe(true);
    expect((await mintJwt(auth, signedToken)).status).toBe(200);
  });

  it('a tampered signed token is refused', async () => {
    const { signedToken } = await signedInUser();
    const [value, signature] = signedToken.split('.');
    const flipped = `${signature![0] === 'A' ? 'B' : 'A'}${signature!.slice(1)}`;
    expect((await mintJwt(auth, `${value}.${flipped}`)).status).toBe(401);
  });

  it('an unknown raw token is refused', async () => {
    expect((await mintJwt(auth, 'not-a-session-token')).status).toBe(401);
  });
});

describe('JWT issued at /token', () => {
  it('carries exactly {sub, sid, iss, aud, exp, iat}: the user id, the session id, the configured iss/aud', async () => {
    const { id, token } = await signedInUser();
    const res = await mintJwt(auth, token);
    const { header, payload } = decodeJwt((await json<{ token: string }>(res)).token);

    expect(Object.keys(payload).sort()).toEqual(['aud', 'exp', 'iat', 'iss', 'sid', 'sub']);
    expect(payload.sub).toBe(id);
    expect(payload.sid).toBe((await sessionByToken(db, token))!.id);
    expect(payload.iss).toBe(TEST_JWT_ISSUER);
    expect(payload.aud).toBe(TEST_JWT_AUDIENCE);
    expect(header.alg).toBe('EdDSA');
    expect(typeof header.kid).toBe('string');
  });

  it('lives 15 minutes: exp − iat is 900 seconds', async () => {
    const { token } = await signedInUser();
    const { payload } = decodeJwt((await json<{ token: string }>(await mintJwt(auth, token))).token);
    expect((payload.exp as number) - (payload.iat as number)).toBe(900);
  });

  it('verifies against the published JWKS (Ed25519)', async () => {
    const { token } = await signedInUser();
    const jwt = (await json<{ token: string }>(await mintJwt(auth, token))).token;
    const { header } = decodeJwt(jwt);

    const jwks = await json<{ keys: Array<JsonWebKey & { kid: string; alg: string }> }>(
      await call(auth, '/jwks')
    );
    const jwk = jwks.keys.find((k) => k.kid === header.kid);
    expect(jwk?.alg).toBe('EdDSA');
    expect(jwk?.crv).toBe('Ed25519');

    const key = await crypto.subtle.importKey('jwk', jwk!, { name: 'Ed25519' }, false, ['verify']);
    const [h, p, s] = jwt.split('.');
    const valid = await crypto.subtle.verify(
      { name: 'Ed25519' },
      key,
      Buffer.from(s!, 'base64url'),
      new TextEncoder().encode(`${h}.${p}`)
    );
    expect(valid).toBe(true);
  });

  it('get-session also hands out a JWT with the same restricted payload, in set-auth-jwt', async () => {
    const { token } = await signedInUser();
    const res = await call(auth, '/get-session', { bearer: token });
    expect(res.status).toBe(200);
    const jwt = res.headers.get('set-auth-jwt');
    expect(jwt).toBeTruthy();
    expect(Object.keys(decodeJwt(jwt!).payload).sort()).toEqual([
      'aud',
      'exp',
      'iat',
      'iss',
      'sid',
      'sub',
    ]);
  });
});

describe('session lifetime: 30 days, slid once a day by /token', () => {
  it('a new session expires 30 days after it was created', async () => {
    const before = Date.now();
    const { token } = await signedInUser();
    const session = await sessionByToken(db, token);
    const lifetime = session!.expiresAt.getTime() - before;
    expect(lifetime).toBeGreaterThanOrEqual(30 * DAY_MS - 5_000);
    expect(lifetime).toBeLessThanOrEqual(30 * DAY_MS + 5_000);
  });

  it('a /token exchange before a day has passed leaves the expiry alone', async () => {
    const day0 = new Date('2026-11-01T00:00:00Z');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(day0);
    const { token } = await signedInUser();
    const created = (await sessionByToken(db, token))!.expiresAt.getTime();

    vi.setSystemTime(new Date(day0.getTime() + 12 * 60 * 60 * 1000));
    expect((await mintJwt(auth, token)).status).toBe(200);
    expect((await sessionByToken(db, token))!.expiresAt.getTime()).toBe(created);
  });

  it('a /token exchange after updateAge slides the expiry to 30 days from then', async () => {
    const day0 = new Date('2026-11-01T00:00:00Z');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(day0);
    const { token } = await signedInUser();
    expect((await sessionByToken(db, token))!.expiresAt.getTime()).toBe(
      day0.getTime() + 30 * DAY_MS
    );

    const day2 = new Date(day0.getTime() + 2 * DAY_MS);
    vi.setSystemTime(day2);
    expect((await mintJwt(auth, token)).status).toBe(200);
    expect((await sessionByToken(db, token))!.expiresAt.getTime()).toBe(
      day2.getTime() + 30 * DAY_MS
    );
  });

  it('a regularly refreshed session outlives the 30-day mark; an idle one does not', async () => {
    const day0 = new Date('2026-11-01T00:00:00Z');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(day0);
    const active = await signedInUser();
    const idle = await signedInUser();

    for (const day of [10, 20, 29]) {
      vi.setSystemTime(new Date(day0.getTime() + day * DAY_MS));
      expect((await mintJwt(auth, active.token)).status).toBe(200);
    }

    vi.setSystemTime(new Date(day0.getTime() + 31 * DAY_MS));
    expect((await mintJwt(auth, active.token)).status).toBe(200);
    expect((await mintJwt(auth, idle.token)).status).toBe(401);
  });
});
