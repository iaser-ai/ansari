import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

// Spec 4: the grant-admin bootstrap script. Exercised against pglite (mocking
// db/index) with real bcrypt hashing. Proves create-or-flag idempotency and that
// a newly-created admin gets a real password hash (so it can log in).

const h = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('@/lib/db/index', () => ({
  get db() {
    return h.db;
  },
  closeDb: async () => {},
}));

import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import * as schema from '@/db/schema';
import { verifyPassword, hashPassword } from '@/lib/auth/password';
import { grantAdmin } from '../scripts/grant-admin';

// Real bcrypt hash, used to seed pre-existing accounts in tests.
const hashForTest = (pw: string) => hashPassword(pw);

let client: PGlite;

beforeAll(async () => {
  client = new PGlite();
  h.db = drizzle(client, { schema });
  await client.exec(`
    CREATE TABLE users (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      email text UNIQUE NOT NULL,
      password_hash text NOT NULL,
      first_name text,
      last_name text,
      source text DEFAULT 'web',
      registered_via text,
      is_admin boolean NOT NULL DEFAULT false,
      system_key text,
      session_version integer NOT NULL DEFAULT 0,
      created_at timestamp with time zone DEFAULT now(),
      updated_at timestamp with time zone DEFAULT now()
    );
    CREATE UNIQUE INDEX idx_users_system_key ON users (system_key);
    CREATE TABLE tokens (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_type text NOT NULL,
      token_hash text NOT NULL,
      expires_at timestamp with time zone NOT NULL,
      rotated_at timestamp with time zone,
      created_at timestamp with time zone DEFAULT now()
    );
  `);
});

afterAll(async () => {
  await client.close();
});

beforeEach(async () => {
  await client.exec(`DELETE FROM tokens;`);
  await client.exec(`DELETE FROM users;`);
});

async function rowOf(email: string) {
  const r = await client.query<{ is_admin: boolean; password_hash: string }>(
    `SELECT is_admin, password_hash FROM users WHERE email = $1`,
    [email]
  );
  return r.rows[0];
}

describe('grantAdmin', () => {
  it('creates a new login-capable admin (password authenticates)', async () => {
    const result = await grantAdmin('new@admin.chat', 'a-strong-password-123');
    expect(result).toEqual({ created: true });

    const row = await rowOf('new@admin.chat');
    expect(row.is_admin).toBe(true);
    expect(row.password_hash).toMatch(/^\$2[aby]\$/); // bcrypt hash prefix
    expect(await verifyPassword('a-strong-password-123', row.password_hash)).toBe(true);
  });

  it('promotes an existing account AND resets its password (locks out a pre-registrant)', async () => {
    // Simulate an attacker who pre-registered the admin address with their own password.
    const attackerHash = await hashForTest('attacker-password-xxx');
    await client.query(
      `INSERT INTO users (email, password_hash, is_admin) VALUES ($1, $2, false)`,
      ['existing@admin.chat', attackerHash]
    );

    const result = await grantAdmin('existing@admin.chat', 'operator-password-999');
    expect(result).toEqual({ created: false });

    const row = await rowOf('existing@admin.chat');
    expect(row.is_admin).toBe(true);
    // The operator's password now authenticates; the attacker's no longer does.
    expect(await verifyPassword('operator-password-999', row.password_hash)).toBe(true);
    expect(await verifyPassword('attacker-password-xxx', row.password_hash)).toBe(false);

    const count = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM users WHERE email = $1`,
      ['existing@admin.chat']
    );
    expect(count.rows[0].n).toBe(1);
  });

  it('atomically revokes tokens and bumps session_version on promotion (pre-registrant lockout)', async () => {
    await client.query(
      `INSERT INTO users (id, email, password_hash, is_admin, session_version) VALUES ($1, $2, $3, false, 0)`,
      ['33333333-3333-3333-3333-333333333333', 'tokened@admin.chat', await hashForTest('attacker-password-xxx')]
    );
    // Seed a live refresh token the attacker holds.
    await client.query(
      `INSERT INTO tokens (user_id, token_type, token_hash, expires_at)
       VALUES ($1, 'refresh', 'attacker-token-hash', now() + interval '90 days')`,
      ['33333333-3333-3333-3333-333333333333']
    );

    await grantAdmin('tokened@admin.chat', 'operator-password-999');

    // The attacker's token row is gone — it can no longer authenticate as the now-admin user.
    const tokenRows = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM tokens WHERE user_id = $1`,
      ['33333333-3333-3333-3333-333333333333']
    );
    expect(tokenRows.rows[0].n).toBe(0);

    // session_version is bumped so any token minted by a refresh racing the promotion
    // (carrying the old version) is rejected once Phase 7's version check is in place.
    const userRow = await client.query<{ is_admin: boolean; session_version: number }>(
      `SELECT is_admin, session_version FROM users WHERE id = $1`,
      ['33333333-3333-3333-3333-333333333333']
    );
    expect(userRow.rows[0].is_admin).toBe(true);
    expect(userRow.rows[0].session_version).toBe(1);
  });

  it('normalizes the email to lowercase', async () => {
    await grantAdmin('MixedCase@Admin.Chat', 'a-strong-password-123');
    expect(await rowOf('mixedcase@admin.chat')).toBeDefined();
  });

  it('refuses to create a new admin with a too-short password', async () => {
    await expect(grantAdmin('brandnew@admin.chat', 'short')).rejects.toThrow(/12-128 characters/);
    expect(await rowOf('brandnew@admin.chat')).toBeUndefined();
  });

  it('refuses an over-long (>128 char) password', async () => {
    await expect(grantAdmin('longpw@admin.chat', 'a'.repeat(129))).rejects.toThrow(/12-128 characters/);
    expect(await rowOf('longpw@admin.chat')).toBeUndefined();
  });

  it('refuses a long-but-WEAK password (enforces the strength policy)', async () => {
    // 12+ chars but a common pattern → checkPasswordStrength score < 3 (the -2
    // common-pattern penalty pulls it under the threshold).
    await expect(grantAdmin('weak@admin.chat', 'passwordpassword')).rejects.toThrow(/too weak/);
    expect(await rowOf('weak@admin.chat')).toBeUndefined();
  });

  it('refuses to promote an existing account without a password', async () => {
    await client.query(
      `INSERT INTO users (email, password_hash, is_admin) VALUES ($1, $2, false)`,
      ['noflag@admin.chat', await hashForTest('Whatever-12-chars!')]
    );
    await expect(grantAdmin('noflag@admin.chat')).rejects.toThrow(/12-128 characters/);
    // Not promoted.
    expect((await rowOf('noflag@admin.chat')).is_admin).toBe(false);
  });
});
