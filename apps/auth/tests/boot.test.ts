// The boot assertion (spec 329): apps/auth refuses to start only on a definite
// answer that migration 0001's schema is missing, and starts as it always has
// when the database cannot answer. A stopped real Postgres is the production-
// shaped run (scripts/probes/exchange-outage-probe.ts, output in the review).
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Db } from '@ansari/auth';

import { drizzleFor, migrate, setAuthEnv } from '../../../packages/auth/tests/helpers/auth-db';
import { createApp, createServiceAuth } from '../src/app';
import { assertSchema, BSUID_CONSTRAINT, SCHEMA_MISSING_MESSAGE, SCHEMA_UNCHECKED_MESSAGE } from '../src/boot';
import { BASE } from './helpers/service';

let client: PGlite;
let errors: unknown[][];

beforeEach(async () => {
  setAuthEnv(BASE);
  client = await migrate();
  errors = [];
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    errors.push(args);
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await client.close().catch(() => {});
});

/** Each logged meta argument is exactly `{name, code}` (or `{name}`): no message, no stack, no query. */
function expectNameCodeOnly() {
  for (const [, meta, ...rest] of errors) {
    expect(rest).toEqual([]);
    expect(Object.keys(meta as object).sort()).toEqual(expect.arrayContaining(['name']));
    for (const key of Object.keys(meta as object)) expect(['name', 'code']).toContain(key);
  }
}

/**
 * The real database, until `down` is set; then every query fails as an
 * unreachable server does (ECONNREFUSED), and recovers when it is cleared.
 */
function switchable(db: Db) {
  const state = { down: false };
  const refused = () => Object.assign(new Error('connect ECONNREFUSED 10.0.0.1:5432'), { code: 'ECONNREFUSED' });
  const proxy = new Proxy(db, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver) as unknown;
      if (typeof value !== 'function' || !['execute', 'select', 'transaction'].includes(String(prop))) return value;
      return (...args: unknown[]) => {
        if (state.down) {
          if (prop === 'select') return { from: () => ({ limit: () => Promise.reject(refused()) }) };
          return Promise.reject(refused());
        }
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
  return { db: proxy, state };
}

describe('assertSchema', () => {
  it('lets apps/auth start on the full journal, logging nothing', async () => {
    expect(await assertSchema(drizzleFor(client))).toBe(true);
    expect(errors).toEqual([]);
  });

  it('refuses when auth.apikey is missing (42P01), logging {name, code} only', async () => {
    await client.exec('drop table auth.apikey');
    expect(await assertSchema(drizzleFor(client))).toBe(false);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.[0]).toBe(SCHEMA_MISSING_MESSAGE);
    expect(errors[0]?.[1]).toMatchObject({ code: '42P01' });
    expectNameCodeOnly();
  });

  it('refuses when unique(provider_id, account_id) is missing, logging {name, code} only', async () => {
    await client.exec(`alter table auth.account drop constraint ${BSUID_CONSTRAINT}`);
    expect(await assertSchema(drizzleFor(client))).toBe(false);
    expect(errors).toEqual([[SCHEMA_MISSING_MESSAGE, { name: 'MissingConstraint', code: BSUID_CONSTRAINT }]]);
  });

  it.each([
    [
      'the name on another auth table',
      `create table auth.decoy (provider_id text, account_id text, constraint ${BSUID_CONSTRAINT} unique (provider_id, account_id))`,
    ],
    [
      'the name on auth.account over other columns',
      `alter table auth.account add constraint ${BSUID_CONSTRAINT} unique (account_id, user_id)`,
    ],
    [
      'the name on auth.account over the columns in the other order',
      `alter table auth.account add constraint ${BSUID_CONSTRAINT} unique (account_id, provider_id)`,
    ],
  ])('refuses when the real constraint is gone and only %s remains', async (_name, spoof) => {
    await client.exec(`alter table auth.account drop constraint ${BSUID_CONSTRAINT}`);
    await client.exec(spoof);
    expect(await assertSchema(drizzleFor(client))).toBe(false);
    expect(errors).toEqual([[SCHEMA_MISSING_MESSAGE, { name: 'MissingConstraint', code: BSUID_CONSTRAINT }]]);
  });

  it('starts when the database cannot answer, logging {name, code} only', async () => {
    const { db, state } = switchable(drizzleFor(client));
    state.down = true;
    expect(await assertSchema(db)).toBe(true);
    expect(errors).toEqual([[SCHEMA_UNCHECKED_MESSAGE, { name: 'Error', code: 'ECONNREFUSED' }]]);
  });

  it('starts when the relation answers but the catalog lookup fails', async () => {
    const real = drizzleFor(client);
    const db = new Proxy(real, {
      get(target, prop, receiver) {
        if (prop === 'execute') return () => Promise.reject(Object.assign(new Error('timeout'), { code: '57014' }));
        return Reflect.get(target, prop, receiver) as unknown;
      },
    });
    expect(await assertSchema(db)).toBe(true);
    expect(errors).toEqual([[SCHEMA_UNCHECKED_MESSAGE, { name: 'Error', code: '57014' }]]);
  });
});

describe('the database unreachable at boot', () => {
  it('apps/auth starts and listens, /health reports down, then recovers without a restart', async () => {
    const { db, state } = switchable(drizzleFor(client));
    state.down = true;
    expect(await assertSchema(db)).toBe(true);

    const app = createApp({ auth: createServiceAuth(db), db });
    const server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/health`;
    try {
      expect((await fetch(url)).status).toBe(503);
      // {name, code} only, as boot and the exchange log it: no message (it names the host).
      expect(errors.at(-1)).toEqual(['health: auth database unreachable', { name: 'Error', code: 'ECONNREFUSED' }]);
      state.down = false;
      const res = await fetch(url);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: 'ok' });
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});
