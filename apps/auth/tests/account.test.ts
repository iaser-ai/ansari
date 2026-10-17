// The account endpoints (spec 300 rules 2, 5, 6 and 8; owner amendment
// 2026-10-17), driven over the one public listener with real JWTs minted by
// the same createAuth() instance. The user is always the token's sub, and the
// token's session must still be live (DELETE: unless the user is already gone).
import { randomUUID } from 'node:crypto';

import { limits, users } from '@ansari/auth';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  accountLimitKey,
  KEY_SET_MAX_AGE_MS,
  KEY_SET_MIN_REFRESH_MS,
  resetAccountKeySets,
} from '../src/routes/account';
import { TEST_JWT_AUDIENCE, TEST_JWT_ISSUER } from '../../../packages/auth/tests/helpers/auth-db';
import { runBanUser } from '../scripts/ban-user';
import {
  mintJwt,
  send,
  signIn,
  signUp,
  signUpTokens,
  startService,
  STRONG_PASSWORD,
  tokenStatus,
  type Service,
} from './helpers/service';

let service: Service;
let seq = 0;
const nextEmail = (label: string) => `${label}-${++seq}@example.com`;

beforeAll(async () => {
  service = await startService();
});
afterAll(async () => {
  await service.close();
});

const account = (svc: Service, path: string, method: string, bearer?: string) =>
  send(svc.publicUrl, `/api/account${path}`, { method, bearer });

const me = (bearer?: string) => account(service, '/me', 'GET', bearer);
const revoke = (bearer?: string) => account(service, '/revoke-sessions', 'POST', bearer);
const del = (bearer?: string) => account(service, '', 'DELETE', bearer);

async function userRow(id: string) {
  const { rows } = await service.client.query('select id from auth.users where id = $1', [id]);
  return rows[0];
}
async function count(table: 'session' | 'account', id: string) {
  const { rows } = await service.client.query<{ n: number }>(
    `select count(*)::int as n from auth.${table} where user_id = $1`,
    [id]
  );
  return rows[0]?.n ?? 0;
}
async function sessionIdOf(svc: Service, sessionToken: string): Promise<string> {
  const { rows } = await svc.client.query<{ id: string }>(
    'select id from auth.session where token = $1',
    [sessionToken]
  );
  const id = rows[0]?.id;
  if (!id) throw new Error('no such session');
  return id;
}

/** A token signed by this service's own key, with chosen claims. */
async function signed(payload: Record<string, unknown>) {
  const { token } = await service.auth.api.signJWT({ body: { payload } });
  return token;
}

const nowSeconds = () => Math.floor(Date.now() / 1000);
const claims = (jwt: string) =>
  JSON.parse(Buffer.from(jwt.split('.')[1] ?? '', 'base64url').toString()) as {
    sub: string;
    sid: string;
  };

/** Every token apps/api or an attacker might present that must NOT pass for `target`. */
async function forgedTokens(target: { id: string; jwt: string; sessionToken: string }, other: { jwt: string }) {
  const { sid } = claims(target.jwt);
  const foreignKey = (await generateKeyPair('EdDSA')).privateKey;
  const [header] = target.jwt.split('.');
  return {
    none: undefined,
    // Signed by a key this service never issued, with the real kid.
    foreignKey: await new SignJWT({ sub: target.id, sid })
      .setProtectedHeader({
        alg: 'EdDSA',
        kid: JSON.parse(Buffer.from(header ?? '', 'base64url').toString()).kid,
      })
      .setIssuer(TEST_JWT_ISSUER)
      .setAudience(TEST_JWT_AUDIENCE)
      .setExpirationTime('5m')
      .sign(foreignKey),
    // The other user's token with its payload swapped for the target's.
    swappedPayload: [
      other.jwt.split('.')[0],
      Buffer.from(JSON.stringify({ ...claims(other.jwt), sub: target.id, sid })).toString('base64url'),
      other.jwt.split('.')[2],
    ].join('.'),
    unsigned: `${Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url')}.${Buffer.from(
      JSON.stringify({
        sub: target.id,
        sid,
        iss: TEST_JWT_ISSUER,
        aud: TEST_JWT_AUDIENCE,
        exp: nowSeconds() + 300,
      })
    ).toString('base64url')}.`,
    // The HS256 confusion attack, keyed by a guessable value.
    hmac: await new SignJWT({ sub: target.id, sid })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer(TEST_JWT_ISSUER)
      .setAudience(TEST_JWT_AUDIENCE)
      .setExpirationTime('5m')
      .sign(new TextEncoder().encode('a-guessable-hmac-key-of-32-characters')),
    wrongIssuer: await signed({ sub: target.id, sid, iss: 'https://evil.example' }),
    wrongAudience: await signed({ sub: target.id, sid, aud: 'someone-else' }),
    expired: await signed({ sub: target.id, sid, exp: nowSeconds() - 60 }),
    noSid: await signed({ sub: target.id }),
    nonUuidSub: await signed({ sub: "1' or '1'='1", sid }),
    // The session token is not a JWT.
    sessionToken: target.sessionToken,
  };
}

describe('every account endpoint refuses a token this service did not issue for that user', () => {
  it.each([
    ['GET /me', (t?: string) => me(t)],
    ['POST /revoke-sessions', (t?: string) => revoke(t)],
    ['DELETE /', (t?: string) => del(t)],
  ])('%s: 401 for each forged or foreign token; the account is untouched', async (_name, call) => {
    const target = await signUpTokens(service, nextEmail('forged'));
    const other = await signUpTokens(service, nextEmail('forged-other'));
    for (const [name, token] of Object.entries(await forgedTokens(target, other))) {
      const res = await call(token);
      expect({ name, status: res.status }).toEqual({ name, status: 401 });
      expect(await res.text()).not.toContain('example.com');
    }
    expect(await userRow(target.id)).toBeDefined();
    expect(await count('session', target.id)).toBe(1);
    expect(await tokenStatus(service, target.sessionToken)).toBe(200);
  });

  it('a non-Bearer Authorization header is refused', async () => {
    const target = await signUpTokens(service, nextEmail('scheme'));
    const res = await send(service.publicUrl, '/api/account', {
      method: 'DELETE',
      headers: { authorization: `Basic ${target.jwt}` },
    });
    expect(res.status).toBe(401);
    expect(await userRow(target.id)).toBeDefined();
  });

  it('there is no id in any path: the old per-id internal routes are gone', async () => {
    const { id, jwt } = await signUpTokens(service, nextEmail('no-id'));
    for (const path of [`/internal/users/${id}/profile`, `/api/account/${id}`, `/api/account/${id}/role`]) {
      expect((await send(service.publicUrl, path, { bearer: jwt })).status).toBe(404);
    }
  });
});

describe('GET /api/account/me', () => {
  it("returns exactly the caller's profile, role and ban state", async () => {
    const email = nextEmail('me');
    const { id, jwt } = await signUpTokens(service, email);
    const res = await me(jwt);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual([
      'banned',
      'email',
      'first_name',
      'id',
      'last_name',
      'registered_via',
      'role',
    ]);
    expect(body).toEqual({
      id,
      email,
      first_name: null,
      last_name: null,
      registered_via: null,
      role: 'user',
      banned: false,
    });
  });

  it('carries first_name, last_name and registered_via as stored', async () => {
    const email = nextEmail('named');
    const res = await send(service.publicUrl, '/api/auth/sign-up/email', {
      body: { email, password: STRONG_PASSWORD, first_name: 'Amina', last_name: 'Khan' },
      headers: { 'x-ansari-client': 'ios' },
    });
    const { user, token } = (await res.json()) as { user: { id: string }; token: string };
    const body = await (await me(await mintJwt(service, token))).json();
    expect(body).toMatchObject({ id: user.id, first_name: 'Amina', last_name: 'Khan' });
    const { rows } = await service.client.query<{ registered_via: string | null }>(
      'select registered_via from auth.users where id = $1',
      [user.id]
    );
    expect(body.registered_via).toBe(rows[0]?.registered_via);
  });

  it('a role change shows on the next call, while the JWT is unchanged', async () => {
    const email = nextEmail('role');
    const { jwt } = await signUpTokens(service, email);
    expect((await (await me(jwt)).json()).role).toBe('user');
    await users.setRoleByEmail(service.db, email, users.ADMIN_ROLE);
    expect((await (await me(jwt)).json()).role).toBe('admin');
  });

  it('reports a ban in force, and not an expired one', async () => {
    const { id, jwt } = await signUpTokens(service, nextEmail('ban-flag'));
    await service.client.query('update auth.users set banned = true where id = $1', [id]);
    expect((await (await me(jwt)).json()).banned).toBe(true);
    await service.client.query(
      "update auth.users set ban_expires = now() - interval '1 second' where id = $1",
      [id]
    );
    expect((await (await me(jwt)).json()).banned).toBe(false);
  });

  it('a valid token whose session has ended is 401 (sign-out, revocation)', async () => {
    const { jwt, sessionToken } = await signUpTokens(service, nextEmail('dead-sid'));
    expect((await me(jwt)).status).toBe(200);
    await service.client.query('delete from auth.session where token = $1', [sessionToken]);
    expect((await me(jwt)).status).toBe(401);
  });

  it('an expired session row is not live', async () => {
    const { jwt, sessionToken } = await signUpTokens(service, nextEmail('expired-sid'));
    await service.client.query(
      "update auth.session set expires_at = now() - interval '1 second' where token = $1",
      [sessionToken]
    );
    expect((await me(jwt)).status).toBe(401);
  });

  it("another user's live sid does not make a token live", async () => {
    const target = await signUpTokens(service, nextEmail('sid-target'));
    const other = await signUpTokens(service, nextEmail('sid-other'));
    const mixed = await signed({ sub: target.id, sid: claims(other.jwt).sid });
    expect((await me(mixed)).status).toBe(401);
  });

  it('never returns a system account, because none can exist in the auth database', async () => {
    expect((await signUp(service, 'ai-skill@system.ansari.chat')).status).toBe(409);
    const { rows } = await service.client.query(
      "select id from auth.users where email like '%@system.ansari.chat'"
    );
    expect(rows).toHaveLength(0);
  });
});

describe('DELETE /api/account (scenario 9g)', () => {
  it('a live session: deletes the sessions, accounts and user; a second call is 204', async () => {
    const email = nextEmail('delete');
    const target = await signUpTokens(service, email);
    const bystander = await signUpTokens(service, nextEmail('bystander'));

    expect((await del(target.jwt)).status).toBe(204);
    expect(await userRow(target.id)).toBeUndefined();
    expect(await count('session', target.id)).toBe(0);
    expect(await count('account', target.id)).toBe(0);
    expect(await tokenStatus(service, target.sessionToken)).toBe(401);
    expect((await signIn(service, email, STRONG_PASSWORD)).status).toBe(401);
    expect((await me(target.jwt)).status).toBe(401);

    // A retry after a lost 204 (apps/api's tombstone path) carries a dead sid,
    // and is still 204.
    expect((await del(target.jwt)).status).toBe(204);
    expect(await userRow(bystander.id)).toBeDefined();
    expect(await tokenStatus(service, bystander.sessionToken)).toBe(200);
  });

  it('a dead sid with a live user is 401, and nothing changes', async () => {
    const email = nextEmail('delete-dead-sid');
    const target = await signUpTokens(service, email);
    // A second, live session, which a refused delete must not touch.
    const second = await signIn(service, email, STRONG_PASSWORD);
    const secondToken = ((await second.json()) as { token: string }).token;
    await service.client.query('delete from auth.session where token = $1', [target.sessionToken]);

    expect((await del(target.jwt)).status).toBe(401);
    expect(await userRow(target.id)).toBeDefined();
    expect(await count('account', target.id)).toBe(1);
    expect(await tokenStatus(service, secondToken)).toBe(200);
  });

  it('a user already gone is 204, and nothing else changes', async () => {
    const target = await signUpTokens(service, nextEmail('delete-gone'));
    const bystander = await signUpTokens(service, nextEmail('delete-gone-bystander'));
    await service.client.query('delete from auth.users where id = $1', [target.id]);
    const before = await service.client.query('select count(*)::int as n from auth.users');

    expect((await del(target.jwt)).status).toBe(204);
    const after = await service.client.query('select count(*)::int as n from auth.users');
    expect(after.rows).toEqual(before.rows);
    expect(await tokenStatus(service, bystander.sessionToken)).toBe(200);
  });

  it("the gone-204 answers only for the token's own subject", async () => {
    // A token for an id that never existed is still a fully verified token
    // of this service; it can delete nobody else.
    const victim = await signUpTokens(service, nextEmail('delete-victim'));
    const ghost = await signed({ sub: randomUUID(), sid: randomUUID() });
    expect((await del(ghost)).status).toBe(204);
    expect(await userRow(victim.id)).toBeDefined();
    expect(await count('session', victim.id)).toBe(1);
  });
});

describe('POST /api/account/revoke-sessions (G-3)', () => {
  it('ends every session of the caller, so none can mint a JWT; the user remains', async () => {
    const email = nextEmail('revoke');
    const first = await signUpTokens(service, email);
    const second = await signIn(service, email, STRONG_PASSWORD);
    const secondToken = ((await second.json()) as { token: string }).token;
    const bystander = await signUpTokens(service, nextEmail('revoke-bystander'));
    expect(await count('session', first.id)).toBe(2);

    expect((await revoke(first.jwt)).status).toBe(204);
    expect(await count('session', first.id)).toBe(0);
    expect(await tokenStatus(service, first.sessionToken)).toBe(401);
    expect(await tokenStatus(service, secondToken)).toBe(401);
    expect(await userRow(first.id)).toBeDefined();
    expect(await tokenStatus(service, bystander.sessionToken)).toBe(200);
    // The user can sign in again, and the old token now finds no live session.
    expect((await signIn(service, email, STRONG_PASSWORD)).status).toBe(200);
    expect((await revoke(first.jwt)).status).toBe(401);
  });

  it('a dead sid is 401, and the other sessions stay', async () => {
    const email = nextEmail('revoke-dead-sid');
    const first = await signUpTokens(service, email);
    const second = await signIn(service, email, STRONG_PASSWORD);
    const secondToken = ((await second.json()) as { token: string }).token;
    await service.client.query('delete from auth.session where token = $1', [first.sessionToken]);
    expect((await revoke(first.jwt)).status).toBe(401);
    expect(await tokenStatus(service, secondToken)).toBe(200);
  });
});

describe("keys planted in the service's own JWKS", () => {
  // The service only ever signs EdDSA tokens with an exp, so these pins are
  // reached by adding keys to its own jwks table: older than its signing key,
  // which stays the one /token signs with, and in a separate service.
  let planted: Service;
  beforeAll(async () => {
    planted = await startService();
  });
  afterAll(async () => {
    await planted.close();
  });

  async function plant(alg: 'EdDSA' | 'RS256') {
    const { publicKey, privateKey } = await generateKeyPair(alg, { extractable: true });
    const kid = randomUUID();
    const jwk = await exportJWK(publicKey);
    await planted.client.query(
      `insert into auth.jwks (id, public_key, private_key, created_at, alg, crv)
       values ($1, $2, $3, now() - interval '1 day', $4, $5)`,
      [kid, JSON.stringify(jwk), 'unused', alg, jwk.crv ?? null]
    );
    return (opts: { exp?: boolean }) => (subject: string, sid: string) => {
      const jwt = new SignJWT({ sid })
        .setProtectedHeader({ alg, kid })
        .setIssuer(TEST_JWT_ISSUER)
        .setAudience(TEST_JWT_AUDIENCE)
        .setSubject(subject);
      if (opts.exp !== false) jwt.setExpirationTime('5m');
      return jwt.sign(privateKey);
    };
  }

  const revokeAt = (bearer: string) => account(planted, '/revoke-sessions', 'POST', bearer);

  // Each planted key must be read: start from a cold key-set cache.
  beforeEach(() => {
    resetAccountKeySets();
  });

  it('a token with no exp is refused, though its key is trusted', async () => {
    const target = await signUpTokens(planted, nextEmail('no-exp'));
    const sid = await sessionIdOf(planted, target.sessionToken);
    const sign = await plant('EdDSA');
    expect((await revokeAt(await sign({ exp: false })(target.id, sid))).status).toBe(401);
    expect(await tokenStatus(planted, target.sessionToken)).toBe(200);
    // The control: the same key with an exp is accepted.
    expect((await revokeAt(await sign({})(target.id, sid))).status).toBe(204);
  });

  it('a key of another algorithm in the JWKS is never accepted', async () => {
    const target = await signUpTokens(planted, nextEmail('rs256'));
    const sid = await sessionIdOf(planted, target.sessionToken);
    const sign = await plant('RS256');
    expect((await revokeAt(await sign({})(target.id, sid))).status).toBe(401);
    expect(await tokenStatus(planted, target.sessionToken)).toBe(200);
  });
});

describe('a ban (scripts/ban-user.ts)', () => {
  it('kills every session, refuses sign-in, and the account endpoint stops answering', async () => {
    const email = nextEmail('banned');
    const target = await signUpTokens(service, email);

    const lines = await runBanUser(service.db, { kind: 'ban', email, reason: 'abuse', days: null });
    expect(lines.join('\n')).toContain('deleted 1 session(s)');
    expect(await count('session', target.id)).toBe(0);
    expect(await tokenStatus(service, target.sessionToken)).toBe(401);
    const signInRes = await signIn(service, email, STRONG_PASSWORD);
    expect(signInRes.status).toBe(403);
    expect(((await signInRes.json()) as { code: string }).code).toBe('BANNED_USER');
    // The JWT is still unexpired, but its session is gone.
    expect((await me(target.jwt)).status).toBe(401);

    await runBanUser(service.db, { kind: 'unban', email });
    expect((await signIn(service, email, STRONG_PASSWORD)).status).toBe(200);
  });
});

describe('the key-set cache (security review, batch 4, C)', () => {
  // Garbage tokens cost CPU only: the jwks table is read at most once per
  // KEY_SET_MIN_REFRESH_MS, and re-read after KEY_SET_MAX_AGE_MS.
  let svc: Service;
  beforeAll(async () => {
    svc = await startService();
  });
  afterAll(async () => {
    await svc.close();
  });
  beforeEach(() => {
    resetAccountKeySets();
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const meAt = (bearer: string) => account(svc, '/me', 'GET', bearer);

  it('a flood of garbage and unknown-kid tokens reads the key set once', async () => {
    const user = await signUpTokens(svc, nextEmail('cache'));
    const reads = vi.spyOn(svc.auth.api, 'getJwks');
    expect((await meAt(user.jwt)).status).toBe(200);
    const foreign = await new SignJWT({ sub: user.id, sid: claims(user.jwt).sid })
      .setProtectedHeader({ alg: 'EdDSA', kid: randomUUID() })
      .setIssuer(TEST_JWT_ISSUER)
      .setAudience(TEST_JWT_AUDIENCE)
      .setExpirationTime('5m')
      .sign((await generateKeyPair('EdDSA')).privateKey);
    for (let i = 0; i < 20; i++) {
      expect((await meAt(i % 2 ? 'not.a.jwt' : foreign)).status).toBe(401);
    }
    expect(reads).toHaveBeenCalledTimes(1);
    reads.mockRestore();
  });

  it(`an unknown kid re-reads at most once per ${KEY_SET_MIN_REFRESH_MS / 1000} s, so a new key verifies after that`, async () => {
    const user = await signUpTokens(svc, nextEmail('rotate'));
    expect((await meAt(user.jwt)).status).toBe(200);
    // A new signing key the cache has not seen: plant it, sign with it.
    const { publicKey, privateKey } = await generateKeyPair('EdDSA', { extractable: true });
    const kid = randomUUID();
    const jwk = await exportJWK(publicKey);
    await svc.client.query(
      `insert into auth.jwks (id, public_key, private_key, created_at, alg, crv) values ($1, $2, 'unused', now() - interval '1 day', 'EdDSA', $3)`,
      [kid, JSON.stringify(jwk), jwk.crv ?? null]
    );
    const rotated = await new SignJWT({ sid: claims(user.jwt).sid })
      .setProtectedHeader({ alg: 'EdDSA', kid })
      .setSubject(user.id)
      .setIssuer(TEST_JWT_ISSUER)
      .setAudience(TEST_JWT_AUDIENCE)
      .setExpirationTime('10m')
      .sign(privateKey);
    const reads = vi.spyOn(svc.auth.api, 'getJwks');
    expect((await meAt(rotated)).status).toBe(401);
    expect(reads).not.toHaveBeenCalled();
    vi.setSystemTime(Date.now() + KEY_SET_MIN_REFRESH_MS);
    expect((await meAt(rotated)).status).toBe(200);
    expect(reads).toHaveBeenCalledTimes(1);
    reads.mockRestore();
  });

  it(`the cached set is re-read after ${KEY_SET_MAX_AGE_MS / 60_000} min even with no unknown kid`, async () => {
    const user = await signUpTokens(svc, nextEmail('max-age'));
    expect((await meAt(user.jwt)).status).toBe(200);
    const reads = vi.spyOn(svc.auth.api, 'getJwks');
    vi.setSystemTime(Date.now() + KEY_SET_MAX_AGE_MS - 1);
    expect((await meAt(user.jwt)).status).toBe(200);
    expect(reads).not.toHaveBeenCalled();
    vi.setSystemTime(Date.now() + 1);
    expect((await meAt(user.jwt)).status).toBe(200);
    expect(reads).toHaveBeenCalledTimes(1);
    reads.mockRestore();
  });
});

describe('an auth-database outage is a 500, never a 401', () => {
  // apps/api reads 401 as "refused" and 500 as "unavailable" (fail closed,
  // 503): an outage must never pass for a bad token.
  it.each([
    ['me', '/me', 'GET'],
    ['revoke-sessions', '/revoke-sessions', 'POST'],
    ['delete', '', 'DELETE'],
  ])('%s with a valid token and a dead database → 500', async (_name, path, method) => {
    const dead = await startService();
    try {
      const user = await signUpTokens(dead, nextEmail('outage'));
      await dead.client.close();
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
      expect((await account(dead, path, method, user.jwt)).status).toBe(500);
      errors.mockRestore();
    } finally {
      await dead.close().catch(() => undefined);
    }
  });
});

describe('the per-user budget (ACCOUNT_ENDPOINT)', () => {
  async function fill(key: string, n: number) {
    await service.client.query(
      `insert into auth.rate_limit (key, count, last_request) values ($1, $2, $3)
       on conflict (key) do update set count = excluded.count, last_request = excluded.last_request`,
      [key, n, Date.now()]
    );
  }

  it.each([
    ['me', (t: string) => me(t)],
    ['revoke-sessions', (t: string) => revoke(t)],
    ['delete', (t: string) => del(t)],
  ])('%s: the last request in the window passes, the next is 429', async (name, call) => {
    const user = await signUpTokens(service, nextEmail(`budget-${name}`));
    const key = accountLimitKey(user.id, name);
    await fill(key, limits.ACCOUNT_ENDPOINT.max);
    const refused = await call(user.jwt);
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get('x-retry-after'))).toBeGreaterThan(0);
    // Nothing happened.
    expect(await userRow(user.id)).toBeDefined();
    expect(await count('session', user.id)).toBe(1);
    await service.client.query('delete from auth.rate_limit where key = $1', [key]);
  });

  it('the budget is per user and per endpoint, never per IP', async () => {
    const a = await signUpTokens(service, nextEmail('budget-a'));
    const b = await signUpTokens(service, nextEmail('budget-b'));
    await fill(accountLimitKey(a.id, 'me'), limits.ACCOUNT_ENDPOINT.max);
    // One IP for every call, as from apps/api.
    const fromApi = (bearer: string) =>
      send(service.publicUrl, '/api/account/me', { bearer, ip: '192.0.2.10' });
    expect((await fromApi(a.jwt)).status).toBe(429);
    expect((await fromApi(b.jwt)).status).toBe(200);
    // a's other endpoint has its own budget.
    expect((await revoke(a.jwt)).status).toBe(204);
    expect(await rateLimitRowsFor('192.0.2.10')).toEqual([]);
  });

  async function rateLimitRowsFor(ip: string) {
    const { rows } = await service.client.query<{ key: string }>(
      'select key from auth.rate_limit where key like $1',
      [`%${ip}%`]
    );
    return rows;
  }

  it('an invalid token writes no budget row', async () => {
    const before = await service.client.query('select count(*)::int as n from auth.rate_limit');
    for (let i = 0; i < 5; i++) expect((await me('not.a.jwt')).status).toBe(401);
    const after = await service.client.query('select count(*)::int as n from auth.rate_limit');
    expect(after.rows).toEqual(before.rows);
  });
});
