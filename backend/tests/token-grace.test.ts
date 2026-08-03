import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

// Regression tests for issue #34: refresh-token rotation grace window.
//
// These exercise the real grace-window SQL in lib/db/users.ts against an
// in-memory Postgres (pglite) so the time-based validity logic is tested
// faithfully. The production DATABASE_URL is never touched.
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
import { hashToken } from '@/lib/auth/jwt';
import {
  findToken,
  deleteToken,
  deleteUserTokens,
  markTokenRotated,
  deleteExpiredTokens,
  REFRESH_TOKEN_GRACE_MS,
} from '@/lib/db/users';

let client: PGlite;

const USER_ID = '11111111-1111-1111-1111-111111111111';

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
  `);
  await client.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3)`, [
    USER_ID,
    'test@example.com',
    'x',
  ]);
});

afterAll(async () => {
  await client.close();
});

beforeEach(async () => {
  await client.exec('DELETE FROM tokens');
});

async function insertToken(opts: {
  token: string;
  type?: 'access' | 'refresh' | 'reset';
  expiresInMs?: number;
  rotatedAtMs?: number | null;
}): Promise<void> {
  const { token, type = 'refresh', expiresInMs = 60 * 60 * 1000, rotatedAtMs = null } = opts;
  const expiresAt = new Date(Date.now() + expiresInMs);
  const rotatedAt = rotatedAtMs === null ? null : new Date(Date.now() + rotatedAtMs);
  await client.query(
    `INSERT INTO tokens (user_id, token_type, token_hash, expires_at, rotated_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [USER_ID, type, hashToken(token), expiresAt.toISOString(), rotatedAt ? rotatedAt.toISOString() : null]
  );
}

describe('refresh-token grace window (issue #34)', () => {
  // (c) Access-token auth is unchanged: rotated_at is always NULL for them,
  // so the grace clause is a no-op.
  it('access tokens still authenticate (rotated_at NULL is a no-op)', async () => {
    await insertToken({ token: 'access-1', type: 'access' });
    const found = await findToken('access-1');
    expect(found).toBeDefined();
    expect(found?.user.id).toBe(USER_ID);
  });

  it('expired access tokens are still rejected', async () => {
    await insertToken({ token: 'access-expired', type: 'access', expiresInMs: -1000 });
    expect(await findToken('access-expired')).toBeUndefined();
  });

  // (a) Two concurrent refreshes with the same token both succeed: after the
  // first rotates the token, a second concurrent lookup still finds it.
  it('a token rotated just now is still valid within the grace window', async () => {
    await insertToken({ token: 'refresh-1', type: 'refresh' });
    expect(await findToken('refresh-1')).toBeDefined(); // first refresh validates
    expect(await markTokenRotated('refresh-1')).toBe(true); // ...and rotates
    expect(await findToken('refresh-1')).toBeDefined(); // second concurrent refresh still wins
  });

  // (b) The old refresh token is rejected after the grace window closes.
  it('a rotated refresh token is rejected after the grace window closes', async () => {
    await insertToken({
      token: 'refresh-old',
      type: 'refresh',
      rotatedAtMs: -(REFRESH_TOKEN_GRACE_MS + 5000),
    });
    expect(await findToken('refresh-old')).toBeUndefined();
  });

  // (d) deleteToken invalidates a single token immediately — no grace.
  it('deleteToken invalidates the token immediately, with no grace', async () => {
    await insertToken({ token: 'refresh-logout', type: 'refresh' });
    expect(await deleteToken('refresh-logout')).toBe(true);
    expect(await findToken('refresh-logout')).toBeUndefined();
  });

  it('markTokenRotated pins to the first rotation (idempotent on repeat)', async () => {
    await insertToken({ token: 'refresh-pin', type: 'refresh' });
    expect(await markTokenRotated('refresh-pin')).toBe(true);
    const readRotatedAt = async (): Promise<number> => {
      const res = await client.query<{ rotated_at: Date }>(
        `SELECT rotated_at FROM tokens WHERE token_hash = $1`,
        [hashToken('refresh-pin')]
      );
      return new Date(res.rows[0].rotated_at).getTime();
    };
    const firstRotatedAt = await readRotatedAt();

    // A second rotation must be a no-op so the window can't slide forward.
    expect(await markTokenRotated('refresh-pin')).toBe(false);
    expect(await readRotatedAt()).toBe(firstRotatedAt);
  });

  it('deleteExpiredTokens deletes ONLY past-expiry tokens, retaining rotated-but-unexpired rows for reuse detection', async () => {
    // Past natural expiry → swept.
    await insertToken({ token: 'expired', type: 'refresh', expiresInMs: -1000 });
    // Rotated past the grace window but NOT expired → RETAINED (spec 4 Phase 9),
    // so its replay is still detectable as reuse rather than reading as unknown.
    await insertToken({
      token: 'spent-retained',
      type: 'refresh',
      rotatedAtMs: -(REFRESH_TOKEN_GRACE_MS + 5000),
    });
    await insertToken({ token: 'active', type: 'refresh' });

    // Only the truly-expired token is removed.
    expect(await deleteExpiredTokens()).toBe(1);

    // The spent-but-unexpired rotated row is retained (findToken won't return it —
    // it's past grace — so assert the row's continued existence directly).
    const retained = await client.query(
      `SELECT 1 FROM tokens WHERE token_hash = $1`,
      [hashToken('spent-retained')]
    );
    expect(retained.rows.length).toBe(1);
    // The active token is untouched.
    expect(await findToken('active')).toBeDefined();
  });
});

// Spec 4 Phase 6: full logout revokes ALL of a user's tokens. This proves the
// end-to-end criterion — after deleteUserTokens, both access and refresh tokens
// stop resolving — that the (mocked) logout-route test cannot.
describe('deleteUserTokens (full logout — spec 4)', () => {
  const OTHER_USER_ID = '99999999-9999-9999-9999-999999999999';

  it('revokes both the access and refresh tokens so neither validates', async () => {
    await insertToken({ token: 'at-logout', type: 'access' });
    await insertToken({ token: 'rt-logout', type: 'refresh' });
    expect(await findToken('at-logout')).toBeDefined();
    expect(await findToken('rt-logout')).toBeDefined();

    const removed = await deleteUserTokens(USER_ID);
    expect(removed).toBeGreaterThanOrEqual(2);

    expect(await findToken('at-logout')).toBeUndefined();
    expect(await findToken('rt-logout')).toBeUndefined();
  });

  it('is scoped to the user — another user\'s tokens survive', async () => {
    await client.query(
      `INSERT INTO users (id, email, password_hash) VALUES ($1, $2, 'nologin')
       ON CONFLICT (id) DO NOTHING`,
      [OTHER_USER_ID, 'other-logout@example.com']
    );
    await client.query(
      `INSERT INTO tokens (user_id, token_type, token_hash, expires_at)
       VALUES ($1, 'refresh', $2, now() + interval '1 hour')`,
      [OTHER_USER_ID, hashToken('other-rt')]
    );
    await insertToken({ token: 'mine-rt', type: 'refresh' });

    await deleteUserTokens(USER_ID);

    expect(await findToken('mine-rt')).toBeUndefined(); // mine gone
    expect(await findToken('other-rt')).toBeDefined();  // theirs intact
  });
});
