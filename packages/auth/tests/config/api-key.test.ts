// Service API keys (spec 329, plan phase 1): the @better-auth/api-key 1.7.7
// behaviours the later phases build on, pinned against a real (pglite)
// database built from the auth journal. Each block names the plan probe it
// pins; a plugin bump that changes one fails here before anything depends on it.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import type { PGlite } from '@electric-sql/pglite';
import { defaultKeyHasher } from '@better-auth/api-key';
import { generateRandomString } from 'better-auth/crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createAuth, type Auth, type Db } from '../../src/index';
import { drizzleFor, migrate, setAuthEnv } from '../helpers/auth-db';
import { BASE, call, decodeJwt, json, mintJwt, signIn } from '../helpers/http';

let client: PGlite;
let db: Db;
let auth: Auth;

const WHATSAPP = { whatsapp: ['mint'] };
const MCP = { mcp: ['complete'] };

beforeAll(async () => {
  setAuthEnv(BASE);
  client = await migrate();
  db = drizzleFor(client);
  auth = createAuth(db);
});

afterAll(async () => {
  await client?.close();
});

/** A bare service-like user: no credential, as the phase-4 script will create. */
async function serviceUser(): Promise<string> {
  const id = randomUUID();
  await client.query(
    `INSERT INTO auth.users (id, name, email) VALUES ($1, 'svc', $2)`,
    [id, `service-${id.slice(0, 8)}@noreply.askansari.ai`]
  );
  return id;
}

type KeyBody = Record<string, unknown>;

async function createKey(userId: string, body: KeyBody = {}) {
  return auth.api.createApiKey({
    body: {
      userId,
      prefix: 'ansari_wa_',
      name: 'test',
      permissions: WHATSAPP,
      rateLimitEnabled: false,
      ...body,
    },
  });
}

async function verify(key: string, permissions: Record<string, string[]> = WHATSAPP) {
  return auth.api.verifyApiKey({ body: { key, permissions } });
}

async function keyRow(id: string) {
  const { rows } = await client.query<Record<string, unknown>>(
    `SELECT * FROM auth.apikey WHERE id = $1`,
    [id]
  );
  return rows[0];
}

const count = async (id: string) =>
  (await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM auth.apikey WHERE id = $1`, [id]))
    .rows[0]!.n;

describe('version pin', () => {
  it('pins @better-auth/api-key to exactly the better-auth version', () => {
    const pkg = JSON.parse(
      readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8')
    ) as { dependencies: Record<string, string> };
    expect(pkg.dependencies['@better-auth/api-key']).toBe('1.7.7');
    expect(pkg.dependencies['better-auth']).toBe('1.7.7');
  });
});

describe('probe 1: a key created in process', () => {
  it('verifies, and its row holds only the hash: no raw key in any column, start null', async () => {
    const userId = await serviceUser();
    const created = await createKey(userId, {
      metadata: { clientId: 'whatsapp' },
      rateLimitEnabled: true,
      rateLimitTimeWindow: 60_000,
      rateLimitMax: 60,
      remaining: 3000,
      refillAmount: 3000,
      refillInterval: 86_400_000,
    });
    expect(created.key.startsWith('ansari_wa_')).toBe(true);
    expect(created.key).toMatch(/^ansari_wa_[A-Za-z]{64}$/);

    const result = await verify(created.key);
    expect(result.valid).toBe(true);
    expect(result.key?.referenceId).toBe(userId);

    const row = await keyRow(created.id);
    expect(row).toBeDefined();
    for (const [column, value] of Object.entries(row!)) {
      if (typeof value === 'string') expect(value, column).not.toContain(created.key);
    }
    expect(row!.start).toBeNull();
    expect(row!.key).toBe(await defaultKeyHasher(created.key));
    expect(JSON.parse(row!.permissions as string)).toEqual(WHATSAPP);
    expect(JSON.parse(row!.metadata as string)).toEqual({ clientId: 'whatsapp' });
    expect(row!.rate_limit_max).toBe(60);
    expect(row!.refill_amount).toBe(3000);
    expect(row!.expires_at).toBeNull();
  });
});

describe('probe 1b: limits changed on a live key', () => {
  it('updateApiKey changes the window cap and the refill, enforced at the next verify', async () => {
    const userId = await serviceUser();
    const created = await createKey(userId, {
      rateLimitEnabled: true,
      rateLimitTimeWindow: 60_000,
      rateLimitMax: 1,
    });
    expect((await verify(created.key)).valid).toBe(true);
    expect((await verify(created.key)).error?.code).toBe('RATE_LIMITED');

    await auth.api.updateApiKey({
      body: {
        keyId: created.id,
        userId,
        rateLimitMax: 5,
        rateLimitTimeWindow: 30_000,
        remaining: 1,
        refillAmount: 2,
        refillInterval: 1000,
      },
    });
    const row = await keyRow(created.id);
    expect(row!.rate_limit_max).toBe(5);
    expect(row!.rate_limit_time_window).toBe(30_000);
    expect(row!.refill_amount).toBe(2);
    expect(row!.refill_interval).toBe(1000);
    expect(row!.remaining).toBe(1);

    // The new window cap is enforced: the key verifies again at once.
    expect((await verify(created.key)).valid).toBe(true);
    // The new budget is enforced: remaining 1 is now spent.
    expect((await verify(created.key)).error?.code).toBe('USAGE_EXCEEDED');
    // The new refill applies: past the 1 s interval, remaining is refilled to 2 (one spent now).
    await client.query(
      `UPDATE auth.apikey SET created_at = now() - interval '1 hour', last_refill_at = NULL WHERE id = $1`,
      [created.id]
    );
    expect((await verify(created.key)).valid).toBe(true);
    expect((await keyRow(created.id))!.remaining).toBe(1);
  });
});

describe('the plugin behaviours the exchange relies on', () => {
  it('an unknown key is valid:false', async () => {
    const result = await verify(`ansari_wa_${'x'.repeat(64)}`);
    expect(result.valid).toBe(false);
  });

  it('a wrong permission is refused and spends no budget', async () => {
    const userId = await serviceUser();
    const created = await createKey(userId, { permissions: MCP, remaining: 5 });
    const result = await verify(created.key, WHATSAPP);
    expect(result.valid).toBe(false);
    expect((await keyRow(created.id))!.remaining).toBe(5);
  });

  it('a budget with NO refill deletes the key once exhausted (why the script refuses it)', async () => {
    const userId = await serviceUser();
    const created = await createKey(userId, { remaining: 1 });
    expect((await verify(created.key)).valid).toBe(true);
    const exhausted = await verify(created.key);
    expect(exhausted.valid).toBe(false);
    expect(exhausted.error?.code).toBe('USAGE_EXCEEDED');
    expect(await count(created.id)).toBe(0);
  });

  it('a refilled budget refuses and keeps the key, then verifies after the interval', async () => {
    const userId = await serviceUser();
    const created = await createKey(userId, { remaining: 1, refillAmount: 1, refillInterval: 1000 });
    expect((await verify(created.key)).valid).toBe(true);
    const exhausted = await verify(created.key);
    expect(exhausted.valid).toBe(false);
    expect(exhausted.error?.code).toBe('USAGE_EXCEEDED');
    expect(await count(created.id)).toBe(1);

    // The first refill starts from a null last_refill_at (created_at is used).
    await client.query(
      `UPDATE auth.apikey SET created_at = now() - interval '1 hour' WHERE id = $1`,
      [created.id]
    );
    expect((await verify(created.key)).valid).toBe(true);
    // A later cycle, from a set last_refill_at.
    await client.query(
      `UPDATE auth.apikey SET remaining = 0, last_refill_at = now() - interval '1 hour' WHERE id = $1`,
      [created.id]
    );
    expect((await verify(created.key)).valid).toBe(true);
  });

  it('the window rate limit refuses and keeps the key', async () => {
    const userId = await serviceUser();
    const created = await createKey(userId, {
      rateLimitEnabled: true,
      rateLimitTimeWindow: 60_000,
      rateLimitMax: 2,
    });
    expect((await verify(created.key)).valid).toBe(true);
    expect((await verify(created.key)).valid).toBe(true);
    const limited = await verify(created.key);
    expect(limited.valid).toBe(false);
    expect(limited.error?.code).toBe('RATE_LIMITED');
    expect(await count(created.id)).toBe(1);
  });

  it('a disabled key is refused and kept (revoke)', async () => {
    const userId = await serviceUser();
    const created = await createKey(userId);
    await client.query(`UPDATE auth.apikey SET enabled = false WHERE id = $1`, [created.id]);
    expect((await verify(created.key)).valid).toBe(false);
    expect(await count(created.id)).toBe(1);
  });

  it('an expired key is refused and deleted', async () => {
    const userId = await serviceUser();
    const created = await createKey(userId);
    await client.query(
      `UPDATE auth.apikey SET expires_at = now() - interval '1 minute' WHERE id = $1`,
      [created.id]
    );
    const result = await verify(created.key);
    expect(result.valid).toBe(false);
    expect(result.error?.code).toBe('KEY_EXPIRED');
    expect(await count(created.id)).toBe(0);
  });
});

describe('a key is never a session (enableSessionForAPIKeys: false)', () => {
  it('a valid key as x-api-key or as a bearer yields no session and no token', async () => {
    const userId = await serviceUser();
    const created = await createKey(userId);
    for (const headers of [{ 'x-api-key': created.key }, { authorization: `Bearer ${created.key}` }]) {
      const session = await call(auth, '/get-session', { headers });
      expect(session.status).toBe(200);
      expect(await session.json()).toBeNull();
      const token = await call(auth, '/token', { headers });
      expect(token.status).toBe(401);
    }
  });

  it('the plugin routes are disabled on the router', async () => {
    const userId = await serviceUser();
    for (const path of ['/api-key/create', '/api-key/update', '/api-key/delete']) {
      const res = await call(auth, path, { body: { userId, keyId: randomUUID() } });
      expect(res.status, path).toBe(404);
    }
    for (const path of ['/api-key/get', '/api-key/list']) {
      expect((await call(auth, path)).status, path).toBe(404);
    }
  });
});

describe('probe 2: signJWT with explicit claims matches /api/auth/token', () => {
  it('the claim sets agree (keys, alg, iss, aud, lifetime) and the passed exp is honoured', async () => {
    const email = `jwt-${randomUUID().slice(0, 8)}@example.com`;
    const password = 'Probe-Passw0rd!';
    await auth.api.signUpEmail({ body: { name: 'Probe', email, password } });
    const { token: sessionToken } = await signIn(auth, email, password);
    const reference = decodeJwt((await json<{ token: string }>(await mintJwt(auth, sessionToken!))).token);

    const { rows } = await client.query<{ id: string; user_id: string }>(
      `SELECT id, user_id FROM auth.session WHERE token = $1`,
      [sessionToken]
    );
    const { id: sid, user_id: sub } = rows[0]!;
    const iat = Math.floor(Date.now() / 1000);
    const exp = iat + 15 * 60;
    const signed = await auth.api.signJWT({ body: { payload: { sub, sid, iat, exp } } });
    const exchange = decodeJwt(signed.token);

    expect(Object.keys(exchange.payload).sort()).toEqual(Object.keys(reference.payload).sort());
    expect(exchange.header.alg).toBe(reference.header.alg);
    expect(exchange.payload.iss).toBe(reference.payload.iss);
    expect(exchange.payload.aud).toBe(reference.payload.aud);
    expect(Number(exchange.payload.exp) - Number(exchange.payload.iat)).toBe(
      Number(reference.payload.exp) - Number(reference.payload.iat)
    );
    expect(exchange.payload.exp).toBe(exp);
    expect(exchange.payload.iat).toBe(iat);
  });

  it('without iat the claim sets differ (why the exchange passes it)', async () => {
    const signed = await auth.api.signJWT({
      body: { payload: { sub: randomUUID(), sid: randomUUID() } },
    });
    expect(Object.keys(decodeJwt(signed.token).payload)).not.toContain('iat');
  });
});

describe('no phone number anywhere (spec 329 §5, owner amendment 2)', () => {
  it('a sign-up carrying phone_number leaves it in no auth row, and sign-in and get-session never carry it', async () => {
    const email = `p4a-${randomUUID().slice(0, 8)}@example.com`;
    const password = 'Phone-Passw0rd!';
    const number = '15557654321';
    const signUp = await call(auth, '/sign-up/email', {
      body: { name: 'Probe', email, password, phone_number: number, phoneNumber: number },
    });
    // better-auth 1.7.7 drops body fields that no schema field declares and signs up as
    // usual (observed 2026-10-30: 200). Pinned, so a later version that stores or refuses
    // them is noticed here.
    expect(signUp.status).toBe(200);

    const { rows: tables } = await client.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'auth'`
    );
    expect(tables.length).toBeGreaterThan(0);
    const dumps: string[] = [];
    for (const { table_name } of tables) {
      const { rows } = await client.query<{ row: unknown }>(`SELECT row_to_json(t) AS row FROM auth."${table_name}" t`);
      dumps.push(JSON.stringify(rows));
    }
    const dump = dumps.join('\n');
    expect(dump).toContain(email); // the scan sees this sign-up's own rows
    expect(dump).not.toContain(number);

    const signedIn = await signIn(auth, email, password);
    const signInBody = await signedIn.res.text();
    expect(signInBody).toContain(email);
    expect(signInBody).not.toContain('phone');
    const session = await call(auth, '/get-session', { bearer: signedIn.token! });
    const text = await session.text();
    expect(text).toContain(email);
    expect(text).not.toContain('phone');
  });
});

describe('session-token probe: the generator phase 5 uses', () => {
  it('matches the length and alphabet of a token better-auth writes', async () => {
    const userId = await serviceUser();
    const { internalAdapter } = await auth.$context;
    const created = await internalAdapter.createSession(userId);
    expect(created.token).toMatch(/^[A-Za-z0-9]{32}$/);

    for (let i = 0; i < 50; i++) {
      expect(generateRandomString(32, 'a-z', 'A-Z', '0-9')).toMatch(/^[A-Za-z0-9]{32}$/);
    }
    // Without the explicit alphabet, better-auth/crypto's generator also
    // emits '-' and '_': the explicit alphabet is what makes the shapes match.
    const unrestricted = Array.from({ length: 200 }, () => generateRandomString(32)).join('');
    expect(unrestricted).toMatch(/[-_]/);
  });
});
