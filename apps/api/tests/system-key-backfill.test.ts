import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';

// Phase 3 (spec 4): the migration's conditional backfill marks EXISTING system
// rows with system_key ONLY when they are legitimate service-created rows
// (password_hash = 'nologin' AND matching source). A hijacked row (an attacker
// who pre-registered the system email with a real password) must NOT be promoted.
// These two UPDATEs MUST stay identical to drizzle/0003_lying_dracula.sql.

const BACKFILL_AI_SKILL = `
  UPDATE users SET system_key = 'ai-skill'
    WHERE email = 'ai-skill@system.ansari.chat'
      AND password_hash = 'nologin'
      AND source = 'ai-skill';
`;
const BACKFILL_LEADERBOARD = `
  UPDATE users SET system_key = 'leaderboard'
    WHERE email = 'leaderboard@system.ansari.chat'
      AND password_hash = 'nologin'
      AND source = 'leaderboard';
`;

let client: PGlite;

beforeAll(async () => {
  client = new PGlite();
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

async function systemKeyOf(email: string): Promise<string | null> {
  const r = await client.query<{ system_key: string | null }>(
    `SELECT system_key FROM users WHERE email = $1`,
    [email]
  );
  return r.rows[0]?.system_key ?? null;
}

describe('system_key conditional backfill', () => {
  it('marks a legitimate service-created system row and refuses a hijacked one', async () => {
    // Legit ai-skill row (created by the service: nologin hash, matching source).
    await client.query(
      `INSERT INTO users (email, password_hash, source) VALUES ($1, $2, $3)`,
      ['ai-skill@system.ansari.chat', 'nologin', 'ai-skill']
    );
    // Hijacked leaderboard email: an attacker registered it with a real bcrypt hash.
    await client.query(
      `INSERT INTO users (email, password_hash, source) VALUES ($1, $2, $3)`,
      ['leaderboard@system.ansari.chat', '$2b$12$realbcrypthashfromattacker000000000000', 'web']
    );
    // An ordinary user must never be touched.
    await client.query(
      `INSERT INTO users (email, password_hash, source) VALUES ($1, $2, $3)`,
      ['normal@example.com', '$2b$12$anotherrealhash00000000000000000000000', 'web']
    );

    await client.exec(BACKFILL_AI_SKILL);
    await client.exec(BACKFILL_LEADERBOARD);

    expect(await systemKeyOf('ai-skill@system.ansari.chat')).toBe('ai-skill');
    // Hijacked row is NOT promoted (real hash / wrong source).
    expect(await systemKeyOf('leaderboard@system.ansari.chat')).toBeNull();
    // Ordinary user untouched.
    expect(await systemKeyOf('normal@example.com')).toBeNull();
  });

  it('allows many NULL system_key rows under the unique index (real users do not collide)', async () => {
    await client.query(`INSERT INTO users (email, password_hash) VALUES ($1, $2)`, [
      'null1@example.com',
      'h',
    ]);
    await client.query(`INSERT INTO users (email, password_hash) VALUES ($1, $2)`, [
      'null2@example.com',
      'h',
    ]);
    const r = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM users WHERE system_key IS NULL`
    );
    expect(r.rows[0].n).toBeGreaterThanOrEqual(2);
  });
});
