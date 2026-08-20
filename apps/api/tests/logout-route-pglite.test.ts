import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

// Issue #18: real rollback coverage for the logout route's transaction.
// logout-route.test.ts stubs db.transaction with a passthrough fake, so removing
// the transaction wrapper from logout/route.ts would not fail any mock test.
// Here the REAL route handler runs against pglite with the real middleware and
// real db helpers; only db/index, config, and Sentry are mocked (same pattern as
// session-version-reuse.test.ts).

const h = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('@/lib/db/index', () => ({
  get db() {
    return h.db;
  },
  closeDb: async () => {},
}));
vi.mock('@/lib/config', () => ({
  config: {
    auth: {
      jwtSecret: 'logout-testing-secret-for-purposes-only-32chars',
      accessTokenExpiryHours: 2,
      refreshTokenExpiryHours: 2160,
    },
  },
}));
vi.mock('@sentry/nextjs', () => ({ setUser: vi.fn(), captureRequestError: vi.fn() }));

import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import * as schema from '@/db/schema';
import { issueTokenPair } from '@/lib/db/users';
import { authenticateRequest } from '@/lib/auth/middleware';
import { POST as logout } from '../src/app/api/v2/users/logout/route';

let client: PGlite;
const USER_ID = '55555555-5555-5555-5555-555555555555';

function logoutRequest(token: string): NextRequest {
  return new NextRequest('http://localhost/api/v2/users/logout', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
}

async function userState(): Promise<{ sessionVersion: number; tokenCount: number }> {
  const u = await client.query<{ session_version: number }>(
    `SELECT session_version FROM users WHERE id = $1`,
    [USER_ID]
  );
  const t = await client.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM tokens WHERE user_id = $1`,
    [USER_ID]
  );
  return { sessionVersion: u.rows[0].session_version, tokenCount: t.rows[0].n };
}

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
    CREATE TABLE tokens (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_type text NOT NULL,
      token_hash text NOT NULL,
      expires_at timestamp with time zone NOT NULL,
      rotated_at timestamp with time zone,
      created_at timestamp with time zone DEFAULT now()
    );
    CREATE FUNCTION forbid_token_delete() RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION 'token delete forbidden by test trigger';
    END;
    $$ LANGUAGE plpgsql;
  `);
});

afterAll(async () => {
  await client.close();
});

beforeEach(async () => {
  await client.exec('DROP TRIGGER IF EXISTS block_token_delete ON tokens');
  await client.exec('DELETE FROM tokens');
  await client.query(
    `INSERT INTO users (id, email, password_hash, session_version) VALUES ($1, $2, 'nologin', 0)
     ON CONFLICT (id) DO UPDATE SET session_version = 0`,
    [USER_ID, 'logout-pglite@example.com']
  );
});

describe('POST /api/v2/users/logout against a real DB', () => {
  it('commits the full logout: all tokens deleted AND session_version bumped', async () => {
    const { accessToken } = await issueTokenPair(USER_ID, 0);

    const res = await logout(logoutRequest(accessToken));

    expect(res.status).toBe(200);
    expect(await userState()).toEqual({ sessionVersion: 1, tokenCount: 0 });
  });

  it('rolls back the session_version bump when token deletion fails (atomicity)', async () => {
    const { accessToken } = await issueTokenPair(USER_ID, 0);
    // Make the second write of the transaction (deleteUserTokens) fail with a
    // genuine DB error. If the route dropped its db.transaction wrapper, the
    // bump would have already committed and session_version would read 1.
    await client.exec(`
      CREATE TRIGGER block_token_delete BEFORE DELETE ON tokens
      FOR EACH ROW EXECUTE FUNCTION forbid_token_delete();
    `);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const res = await logout(logoutRequest(accessToken));

      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ detail: 'Logout failed' });
      // Nothing committed: version unchanged, both tokens still present.
      expect(await userState()).toEqual({ sessionVersion: 0, tokenCount: 2 });
      // The session was NOT revoked — the access token still authenticates.
      const auth = await authenticateRequest(logoutRequest(accessToken));
      expect('user' in auth).toBe(true);
    } finally {
      consoleError.mockRestore();
    }
  });

  it('after a failed logout, retrying once the fault clears succeeds completely', async () => {
    const { accessToken } = await issueTokenPair(USER_ID, 0);
    await client.exec(`
      CREATE TRIGGER block_token_delete BEFORE DELETE ON tokens
      FOR EACH ROW EXECUTE FUNCTION forbid_token_delete();
    `);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect((await logout(logoutRequest(accessToken))).status).toBe(500);
    } finally {
      consoleError.mockRestore();
    }
    await client.exec('DROP TRIGGER block_token_delete ON tokens');

    const res = await logout(logoutRequest(accessToken));

    expect(res.status).toBe(200);
    expect(await userState()).toEqual({ sessionVersion: 1, tokenCount: 0 });
    // And the token used for logout is now dead (deleted + version-stale).
    expect('error' in (await authenticateRequest(logoutRequest(accessToken)))).toBe(true);
  });
});
