import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

// Spec 4: system accounts are resolved by durable system_key, never email.
// Exercised against pglite (mocking db/index).

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
import { findSystemUser, getOrCreateSystemUser, isUniqueViolation } from '@/lib/db/users';

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

describe('getOrCreateSystemUser', () => {
  it('lazily creates a system row keyed by system_key with a nologin hash', async () => {
    const user = await getOrCreateSystemUser('ai-skill');
    expect(user.systemKey).toBe('ai-skill');
    expect(user.email).toBe('ai-skill@system.ansari.chat');
    expect(user.passwordHash).toBe('nologin');
    expect(user.source).toBe('ai-skill');
  });

  it('is idempotent — a second call returns the same row (no duplicate)', async () => {
    const a = await getOrCreateSystemUser('leaderboard');
    const b = await getOrCreateSystemUser('leaderboard');
    expect(b.id).toBe(a.id);
    const count = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM users WHERE system_key = 'leaderboard'`
    );
    expect(count.rows[0].n).toBe(1);
  });

  it('resolves the two system identities to distinct rows', async () => {
    const aiSkill = await getOrCreateSystemUser('ai-skill');
    const leaderboard = await getOrCreateSystemUser('leaderboard');
    expect(aiSkill.id).not.toBe(leaderboard.id);
    expect((await findSystemUser('ai-skill'))?.id).toBe(aiSkill.id);
    expect((await findSystemUser('leaderboard'))?.id).toBe(leaderboard.id);
  });

  it('does NOT resolve a pre-registered look-alike (email match, system_key NULL)', async () => {
    // Attacker pre-registers the system email with a real password and no system_key.
    await client.query(
      `INSERT INTO users (email, password_hash, source) VALUES ($1, $2, 'web')`,
      ['ai-skill@system.ansari.chat', '$2b$12$realattackerhash000000000000000000000']
    );

    // Lookup by key finds nothing — the look-alike is never treated as system.
    expect(await findSystemUser('ai-skill')).toBeUndefined();

    // And provisioning fails fast (the email is taken by the non-system row) rather
    // than misrouting system data to the attacker.
    await expect(getOrCreateSystemUser('ai-skill')).rejects.toThrow(/already held by a\s+non-system account/);
  });

  it('propagates a non-unique DB error unchanged (not misreported as occupied email)', async () => {
    // Force a non-23505 failure: drop the table so the query errors with 42P01.
    await client.exec(`DROP TABLE users;`);
    await expect(getOrCreateSystemUser('ai-skill')).rejects.toThrow();
    // The failure must NOT be masked as the hijacked-email remediation message.
    await expect(getOrCreateSystemUser('ai-skill')).rejects.not.toThrow(/already held by a/);
    // Restore the table for any later tests / afterAll.
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
});

describe('isUniqueViolation', () => {
  it('is true for SQLSTATE 23505 (top-level or nested under .cause, as drizzle wraps it)', () => {
    expect(isUniqueViolation({ code: '23505' })).toBe(true);
    expect(isUniqueViolation({ message: 'Failed query', cause: { code: '23505' } })).toBe(true);
  });

  it('is false for other DB error codes and non-errors', () => {
    expect(isUniqueViolation({ code: '42P01' })).toBe(false); // undefined_table
    expect(isUniqueViolation({ code: '08006' })).toBe(false); // connection failure
    expect(isUniqueViolation(new Error('boom'))).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
    expect(isUniqueViolation(undefined)).toBe(false);
  });
});
