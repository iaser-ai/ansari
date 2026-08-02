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
import { grantAdmin } from '../scripts/grant-admin';

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
  `);
});

afterAll(async () => {
  await client.close();
});

beforeEach(async () => {
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
  it('creates a new admin with a real bcrypt password hash', async () => {
    const result = await grantAdmin('new@admin.chat', 'a-strong-password-123');
    expect(result).toEqual({ created: true });

    const row = await rowOf('new@admin.chat');
    expect(row.is_admin).toBe(true);
    expect(row.password_hash).toMatch(/^\$2[aby]\$/); // bcrypt hash prefix
  });

  it('is idempotent: flags an existing account without creating a duplicate', async () => {
    await client.query(
      `INSERT INTO users (email, password_hash, is_admin) VALUES ($1, $2, false)`,
      ['existing@admin.chat', '$2b$12$existinghash0000000000000000000000000000']
    );

    const result = await grantAdmin('existing@admin.chat');
    expect(result).toEqual({ created: false });

    const row = await rowOf('existing@admin.chat');
    expect(row.is_admin).toBe(true);
    // Existing password is left untouched.
    expect(row.password_hash).toBe('$2b$12$existinghash0000000000000000000000000000');

    const count = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM users WHERE email = $1`,
      ['existing@admin.chat']
    );
    expect(count.rows[0].n).toBe(1);
  });

  it('normalizes the email to lowercase', async () => {
    await grantAdmin('MixedCase@Admin.Chat', 'a-strong-password-123');
    expect(await rowOf('mixedcase@admin.chat')).toBeDefined();
  });

  it('refuses to create a new admin without a sufficiently long password', async () => {
    await expect(grantAdmin('brandnew@admin.chat', 'short')).rejects.toThrow(/at least 12 characters/);
    expect(await rowOf('brandnew@admin.chat')).toBeUndefined();
  });
});
