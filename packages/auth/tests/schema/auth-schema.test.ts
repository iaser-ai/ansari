// The auth database's shape and the behaviour the cutover relies on, all
// against a pglite database built only from the auth journal (the reviewed
// `drizzle-kit generate` output):
//  - the spec's success-criterion column names, types and constraints;
//  - UUIDs written by better-auth, and copied in by SQL, read back unchanged;
//  - timestamptz values with microseconds and at a DST boundary survive an
//    insert, a read and an INSERT … SELECT copy (scenario 12);
//  - deleting an auth.users row by plain SQL, as the tombstone script does,
//    cascades to its sessions and accounts (amendment C).
import type { PGlite } from '@electric-sql/pglite';
import { hashPassword } from 'better-auth/crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createAuth, type Auth } from '../../src/index';
import { drizzleFor, migrate, setAuthEnv } from '../helpers/auth-db';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

let client: PGlite;
let auth: Auth;

beforeAll(async () => {
  client = await migrate();
  setAuthEnv('http://localhost:3100');
  auth = createAuth(drizzleFor(client));
});

afterAll(async () => {
  await client?.close();
});

type ColumnRow = { table_name: string; column_name: string; data_type: string; is_nullable: string };

async function authColumns(): Promise<ColumnRow[]> {
  const { rows } = await client.query<ColumnRow>(
    `SELECT table_name, column_name, data_type, is_nullable
       FROM information_schema.columns WHERE table_schema = 'auth'`
  );
  return rows;
}

async function insertUser(id: string, email: string): Promise<void> {
  await client.query(
    `INSERT INTO auth.users (id, name, email, email_verified) VALUES ($1, 'User', $2, true)`,
    [id, email]
  );
}

describe('auth schema shape (spec success criteria)', () => {
  it('has exactly the six Better Auth tables, all in the auth schema', async () => {
    const { rows } = await client.query<{ table_schema: string; table_name: string }>(
      `SELECT table_schema, table_name FROM information_schema.tables
        WHERE table_schema NOT IN ('pg_catalog', 'information_schema')`
    );
    expect(rows.map((r) => `${r.table_schema}.${r.table_name}`).sort()).toEqual([
      'auth.account',
      'auth.jwks',
      'auth.rate_limit',
      'auth.session',
      'auth.users',
      'auth.verification',
    ]);
  });

  it('auth.users carries the additional fields and admin columns, and no system_key or source', async () => {
    const users = (await authColumns()).filter((c) => c.table_name === 'users').map((c) => c.column_name);
    for (const col of [
      'first_name',
      'last_name',
      'registered_via',
      'role',
      'banned',
      'ban_reason',
      'ban_expires',
      'email_verified',
    ]) {
      expect(users).toContain(col);
    }
    expect(users).not.toContain('system_key');
    expect(users).not.toContain('source');
    const all = (await authColumns()).map((c) => c.column_name);
    expect(all).not.toContain('system_key');
    expect(all).not.toContain('source');
  });

  it('auth.session carries impersonated_by', async () => {
    const session = (await authColumns()).filter((c) => c.table_name === 'session');
    expect(session.map((c) => c.column_name)).toContain('impersonated_by');
  });

  it('every id is a uuid, and every user reference is a uuid', async () => {
    const cols = await authColumns();
    const ids = cols.filter((c) => c.column_name === 'id' || c.column_name === 'user_id');
    expect(ids.length).toBe(8);
    for (const c of ids) expect(`${c.table_name}.${c.column_name}:${c.data_type}`).toMatch(/:uuid$/);
  });

  it('every timestamp is timestamptz', async () => {
    const temporal = (await authColumns()).filter((c) => c.data_type.startsWith('timestamp'));
    expect(temporal.length).toBeGreaterThan(0);
    for (const c of temporal) {
      expect(`${c.table_name}.${c.column_name}:${c.data_type}`).toMatch(/:timestamp with time zone$/);
    }
  });

  it('auth.account has a unique (user_id, provider_id)', async () => {
    const id = '11111111-1111-4111-8111-111111111111';
    await insertUser(id, 'unique-account@example.com');
    const insert = `INSERT INTO auth.account (account_id, provider_id, user_id, updated_at)
                    VALUES ($1, 'credential', $2, now())`;
    await client.query(insert, [id, id]);
    await expect(client.query(insert, [id, id])).rejects.toThrow(/account_user_id_provider_id_unique/);
  });

  it('session and account cascade from auth.users; verification has no user reference', async () => {
    const { rows } = await client.query<{ table_name: string; delete_rule: string }>(
      `SELECT tc.table_name, rc.delete_rule
         FROM information_schema.referential_constraints rc
         JOIN information_schema.table_constraints tc
           ON tc.constraint_name = rc.constraint_name AND tc.constraint_schema = rc.constraint_schema
        WHERE tc.constraint_schema = 'auth'`
    );
    expect(rows.map((r) => `${r.table_name}:${r.delete_rule}`).sort()).toEqual([
      'account:CASCADE',
      'session:CASCADE',
    ]);
  });
});

describe('UUID round-trip', () => {
  it('a user better-auth creates gets a UUID that reads back unchanged from the uuid column', async () => {
    const res = await auth.api.signUpEmail({
      body: { name: 'Round Trip', email: 'roundtrip@example.com', password: 'correct-horse-battery' },
    });
    expect(res.user.id).toMatch(UUID);
    const { rows } = await client.query<{ id: string }>(
      `SELECT id::text AS id FROM auth.users WHERE email = 'roundtrip@example.com'`
    );
    expect(rows).toEqual([{ id: res.user.id }]);

    const ctx = await auth.$context;
    const found = await ctx.internalAdapter.findUserById(res.user.id);
    expect(found?.id).toBe(res.user.id);
  });

  // The copy inserts legacy users by SQL under their existing UUIDs; better-auth
  // must then sign them in under that same id. A v7-shaped id is included so a
  // version-filtering transform in the adapter would show here.
  it.each([
    ['v4', '3f2504e0-4f89-41d3-9a0c-0305e82c3301'],
    ['v7-shaped', '01890a5d-ac96-774b-bcce-b302099a8057'],
  ])('a %s UUID inserted by SQL signs in under the same id', async (_label, id) => {
    const email = `copied-${id.slice(0, 8)}@example.com`;
    const password = 'copied-user-password';
    await insertUser(id, email);
    await client.query(
      `INSERT INTO auth.account (account_id, provider_id, user_id, password, updated_at)
       VALUES ($1, 'credential', $2, $3, now())`,
      [id, id, await hashPassword(password)]
    );

    const res = await auth.api.signInEmail({ body: { email, password } });
    expect(res.user.id).toBe(id);
    const { rows } = await client.query<{ user_id: string }>(
      `SELECT user_id::text AS user_id FROM auth.session WHERE token = $1`,
      [res.token]
    );
    expect(rows).toEqual([{ user_id: id }]);

    const ctx = await auth.$context;
    expect((await ctx.internalAdapter.findUserById(id))?.id).toBe(id);
  });
});

describe('timestamp round-trip (scenario 12)', () => {
  // Microseconds, and both sides of the US spring-forward (2026-03-08) and
  // fall-back (2026-11-01, an ambiguous local hour) transitions.
  const values = [
    '2026-03-08 06:59:59.999999+00',
    '2026-03-08 07:00:00.000001+00',
    '2026-11-01 05:30:00.123456+00',
    '2026-11-01 06:30:00.654321+00',
  ];

  it('survives an insert and a read exactly, in any session time zone', async () => {
    for (const [i, value] of values.entries()) {
      const id = `22222222-2222-4222-8222-${String(i).padStart(12, '0')}`;
      await client.query(
        `INSERT INTO auth.users (id, name, email, created_at, updated_at) VALUES ($1, 'T', $2, $3, $3)`,
        [id, `ts-${i}@example.com`, value]
      );
    }
    // The same instants, rendered across both transitions: the ambiguous
    // 01:30 local hour appears twice, once per offset.
    await client.exec(`SET TIME ZONE 'America/New_York'`);
    const { rows: local } = await client.query<{ created_at: string }>(
      `SELECT created_at::text AS created_at FROM auth.users WHERE email LIKE 'ts-%' ORDER BY email`
    );
    expect(local.map((r) => r.created_at)).toEqual([
      '2026-03-08 01:59:59.999999-05',
      '2026-03-08 03:00:00.000001-04',
      '2026-11-01 01:30:00.123456-04',
      '2026-11-01 01:30:00.654321-05',
    ]);
    await client.exec(`SET TIME ZONE 'UTC'`);
    const { rows } = await client.query<{ created_at: string; updated_at: string }>(
      `SELECT created_at::text AS created_at, updated_at::text AS updated_at
         FROM auth.users WHERE email LIKE 'ts-%' ORDER BY email`
    );
    expect(rows.map((r) => r.created_at)).toEqual(values);
    expect(rows.map((r) => r.updated_at)).toEqual(values);
  });

  it('survives an INSERT … SELECT copy from a legacy timestamptz table exactly', async () => {
    await client.exec(
      `CREATE TEMP TABLE legacy_users (id uuid, email text, created_at timestamptz, updated_at timestamptz)`
    );
    for (const [i, value] of values.entries()) {
      await client.query(`INSERT INTO legacy_users VALUES ($1, $2, $3, $3)`, [
        `33333333-3333-4333-8333-${String(i).padStart(12, '0')}`,
        `copy-${i}@example.com`,
        value,
      ]);
    }
    await client.exec(
      `INSERT INTO auth.users (id, name, email, email_verified, created_at, updated_at)
       SELECT id, 'User', email, true, created_at, updated_at FROM legacy_users`
    );
    const { rows } = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM legacy_users l JOIN auth.users u USING (id)
        WHERE u.created_at = l.created_at AND u.updated_at = l.updated_at`
    );
    expect(rows).toEqual([{ n: values.length }]);
  });

  it('reads back through better-auth as the same instant (to the millisecond JS carries)', async () => {
    const ctx = await auth.$context;
    const user = await ctx.internalAdapter.findUserById('22222222-2222-4222-8222-000000000002');
    expect(user?.createdAt).toBeInstanceOf(Date);
    expect(user?.createdAt.toISOString()).toBe('2026-11-01T05:30:00.123Z');
  });
});

describe('cascade on a plain-SQL delete (amendment C)', () => {
  it('deleting an auth.users row leaves no session and no account for that user', async () => {
    const res = await auth.api.signUpEmail({
      body: { name: 'Cascade', email: 'cascade@example.com', password: 'correct-horse-battery' },
    });
    const id = res.user.id;
    const count = async (table: string) =>
      (
        await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM auth.${table} WHERE user_id = $1`, [
          id,
        ])
      ).rows[0].n;
    expect(await count('session')).toBeGreaterThan(0);
    expect(await count('account')).toBe(1);

    await client.query(`DELETE FROM auth.users WHERE id = $1`, [id]);

    expect(await count('session')).toBe(0);
    expect(await count('account')).toBe(0);
  });
});
