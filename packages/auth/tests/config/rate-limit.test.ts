// Rate limiting as configured in createAuth() (spec 300, phase 3; owner
// amendment 2026-10-17): enabled, database storage, NO per-IP router rule on
// any path apps/api's layer calls (they all arrive with apps/api's IP), the
// per-IP default on every other path, and the client IP read from X-Real-IP
// alone. apps/auth's own per-email, per-session and global limiters are tested
// there (apps/auth tests/limits.test.ts).
import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createAuth, schema, type Auth, type Db } from '../../src/index';
import { DEFAULT_RULE, ROUTER_RULES } from '../../src/limits';
import { drizzleFor, migrate, setAuthEnv } from '../helpers/auth-db';
import { BASE, call, type CallOptions } from '../helpers/http';

let client: PGlite;
let db: Db;
let auth: Auth;

beforeAll(async () => {
  setAuthEnv(BASE);
  client = await migrate();
  db = drizzleFor(client);
  auth = createAuth(db);
});

afterAll(async () => {
  await client?.close();
});

/** A cheap request to each path the layer calls: refused or empty, never a real sign-in. */
const LAYER_CALLS: Record<string, CallOptions> = {
  '/sign-in/email': { body: { email: 'nobody@example.com', password: 'Wrong-Passw0rd!' } },
  '/sign-up/email': { body: {} },
  '/request-password-reset': { body: {} },
  '/reset-password': { body: {} },
  '/token': { bearer: 'no-such-session' },
};

/** A path under the router's default rule. */
const ok = (ip: string, headers?: Record<string, string>) => call(auth, '/ok', { ip, headers });

async function rateLimitKeys(): Promise<string[]> {
  return (await db.select({ key: schema.rateLimit.key }).from(schema.rateLimit)).map((r) => r.key);
}

describe('rate-limit configuration', () => {
  it('is enabled, stored in the database, with limits.ts as its rules', () => {
    expect(auth.options.rateLimit).toMatchObject({
      enabled: true,
      storage: 'database',
      window: DEFAULT_RULE.window,
      max: DEFAULT_RULE.max,
      customRules: ROUTER_RULES,
    });
  });

  it('switches the router limiter off on exactly the paths the layer calls', () => {
    expect(Object.keys(ROUTER_RULES).sort()).toEqual(Object.keys(LAYER_CALLS).sort());
    for (const rule of Object.values(ROUTER_RULES)) expect(rule).toBe(false);
  });

  it('reads the client IP from x-real-ip only, with no trusted proxies', () => {
    expect(auth.options.advanced?.ipAddress).toEqual({ ipAddressHeaders: ['x-real-ip'] });
  });
});

describe('no per-IP limit on a path the layer calls, the default included', () => {
  it.each(Object.entries(LAYER_CALLS))(
    `%s: ${DEFAULT_RULE.max + 1} requests from one X-Real-IP, none refused by the router`,
    async (path, opts) => {
      const ip = '203.0.113.10';
      for (let i = 0; i <= DEFAULT_RULE.max; i++) {
        expect((await call(auth, path, { ...opts, ip })).status).not.toBe(429);
      }
      expect((await rateLimitKeys()).filter((k) => k.endsWith(`|${path}`))).toEqual([]);
    }
  );

  it(`any other path keeps the per-IP default: request ${DEFAULT_RULE.max + 1} is 429`, async () => {
    const ip = '203.0.113.20';
    for (let i = 0; i < DEFAULT_RULE.max; i++) expect((await ok(ip)).status).toBe(200);
    expect((await ok(ip)).status).toBe(429);
    // Another client is unaffected.
    expect((await ok('203.0.113.21')).status).toBe(200);
  });

  it('/get-session, which the layer never calls, is under the default too', async () => {
    expect(ROUTER_RULES['/get-session']).toBeUndefined();
    const ip = '203.0.113.22';
    for (let i = 0; i < DEFAULT_RULE.max; i++) {
      expect((await call(auth, '/get-session', { ip })).status).toBe(200);
    }
    expect((await call(auth, '/get-session', { ip })).status).toBe(429);
  });
});

describe('the bucket is X-Real-IP, never X-Forwarded-For', () => {
  it('a request with a two-entry X-Forwarded-For is keyed by its X-Real-IP', async () => {
    await ok('203.0.113.40', { 'x-forwarded-for': '10.9.9.9, 10.8.8.8' });
    const keys = await rateLimitKeys();
    expect(keys).toContain('203.0.113.40|/ok');
    expect(keys.some((k) => k.startsWith('10.'))).toBe(false);
    expect(keys.some((k) => k.startsWith('no-trusted-ip'))).toBe(false);
  });

  it('forging X-Forwarded-For does not move a client out of its exhausted bucket', async () => {
    const ip = '203.0.113.50';
    for (let i = 0; i < DEFAULT_RULE.max; i++) await ok(ip);
    for (const forged of ['198.51.100.1', '198.51.100.2, 198.51.100.3']) {
      expect((await ok(ip, { 'x-forwarded-for': forged })).status).toBe(429);
    }
  });
});
