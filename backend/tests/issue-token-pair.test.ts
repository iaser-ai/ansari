import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

// Phase 2 (token consolidation): issueTokenPair is the single generate-and-store
// site for login/register/refresh. Exercised against pglite (like token-grace)
// with config mocked to a known secret + expiries.

const h = vi.hoisted(() => ({ db: null as unknown }));

vi.mock('@/lib/db/index', () => ({
  get db() {
    return h.db;
  },
  closeDb: async () => {},
}));

const SECRET = 'issue-token-pair-secret-at-least-32-characters';
vi.mock('@/lib/config', () => ({
  config: {
    auth: {
      jwtSecret: 'issue-token-pair-secret-at-least-32-characters',
      accessTokenExpiryHours: 2,
      refreshTokenExpiryHours: 2160,
    },
  },
}));

import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import * as schema from '@/db/schema';
import { hashToken, verifyToken } from '@/lib/auth/jwt';
import { issueTokenPair } from '@/lib/db/users';

let client: PGlite;
const USER_ID = '22222222-2222-2222-2222-222222222222';

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
  `);
  await client.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3)`, [
    USER_ID,
    'pair@example.com',
    'nologin',
  ]);
});

afterAll(async () => {
  await client.close();
});

describe('issueTokenPair', () => {
  it('returns an access + refresh token signed with the config secret', async () => {
    const { accessToken, refreshToken } = await issueTokenPair(USER_ID);

    expect(typeof accessToken).toBe('string');
    expect(typeof refreshToken).toBe('string');
    expect(accessToken).not.toEqual(refreshToken);

    const accessPayload = verifyToken(accessToken, SECRET);
    const refreshPayload = verifyToken(refreshToken, SECRET);
    expect(accessPayload).not.toBeNull();
    expect(refreshPayload).not.toBeNull();
    expect(accessPayload!.type).toBe('access');
    expect(refreshPayload!.type).toBe('refresh');
    expect(accessPayload!.user_id).toBe(USER_ID);
    expect(refreshPayload!.user_id).toBe(USER_ID);
  });

  it('sets token expiries from config (access 2h, refresh 2160h)', async () => {
    const { accessToken, refreshToken } = await issueTokenPair(USER_ID);
    const access = verifyToken(accessToken, SECRET)!;
    const refresh = verifyToken(refreshToken, SECRET)!;
    // jsonwebtoken sets exp = iat + expiresIn(seconds).
    expect(access.exp - access.iat).toBe(2 * 60 * 60);
    expect(refresh.exp - refresh.iat).toBe(2160 * 60 * 60);
  });

  it('stores both tokens (hashed) with the correct types', async () => {
    const { accessToken, refreshToken } = await issueTokenPair(USER_ID);

    const rows = await client.query<{ token_type: string; token_hash: string }>(
      `SELECT token_type, token_hash FROM tokens WHERE token_hash IN ($1, $2)`,
      [hashToken(accessToken), hashToken(refreshToken)]
    );
    const byType = Object.fromEntries(rows.rows.map((r) => [r.token_type, r.token_hash]));
    expect(byType['access']).toBe(hashToken(accessToken));
    expect(byType['refresh']).toBe(hashToken(refreshToken));
  });
});
