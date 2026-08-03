import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

// Spec 4 Phase 7: rotated-token reuse detection + session-version enforcement +
// the reset-vs-refresh interleaving. Exercised against pglite with the real
// helpers and the real middleware; only db/index, config, and Sentry are mocked.

const SECRET = 'phase7-testing-secret-for-purposes-only-32chars';

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
      jwtSecret: 'phase7-testing-secret-for-purposes-only-32chars',
      accessTokenExpiryHours: 2,
      refreshTokenExpiryHours: 2160,
    },
  },
}));
vi.mock('@sentry/nextjs', () => ({ setUser: vi.fn(), captureRequestError: vi.fn() }));

import jwt from 'jsonwebtoken';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import * as schema from '@/db/schema';
import { hashToken, generateToken } from '@/lib/auth/jwt';
import {
  issueTokenPair,
  lookupRefreshToken,
  bumpSessionVersion,
  deleteUserTokens,
  deleteToken,
  markTokenRotated,
  updateUser,
  REFRESH_TOKEN_GRACE_MS,
} from '@/lib/db/users';
import { db } from '@/lib/db/index';
import { authenticateRequest, validateRefreshToken } from '@/lib/auth/middleware';

let client: PGlite;
const USER_ID = '44444444-4444-4444-4444-444444444444';

async function insertRefresh(token: string, opts: { rotatedAtMs?: number | null; expiresInMs?: number } = {}) {
  const { rotatedAtMs = null, expiresInMs = 2160 * 60 * 60 * 1000 } = opts;
  const expiresAt = new Date(Date.now() + expiresInMs);
  const rotatedAt = rotatedAtMs === null ? null : new Date(Date.now() + rotatedAtMs);
  await client.query(
    `INSERT INTO tokens (user_id, token_type, token_hash, expires_at, rotated_at)
     VALUES ($1, 'refresh', $2, $3, $4)`,
    [USER_ID, hashToken(token), expiresAt.toISOString(), rotatedAt ? rotatedAt.toISOString() : null]
  );
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
  `);
});

afterAll(async () => {
  await client.close();
});

beforeEach(async () => {
  await client.exec('DELETE FROM tokens');
  await client.query(
    `INSERT INTO users (id, email, password_hash, session_version) VALUES ($1, $2, 'nologin', 0)
     ON CONFLICT (id) DO UPDATE SET session_version = 0`,
    [USER_ID, 'phase7@example.com']
  );
});

describe('lookupRefreshToken states', () => {
  it('valid: a fresh (never-rotated) refresh token', async () => {
    await insertRefresh('fresh');
    const r = await lookupRefreshToken('fresh');
    expect(r.status).toBe('valid');
  });

  it('valid: a token rotated within the grace window (concurrent refresh, issue #34)', async () => {
    await insertRefresh('in-grace', { rotatedAtMs: -1000 });
    const r = await lookupRefreshToken('in-grace');
    expect(r.status).toBe('valid');
  });

  it('reuse: a token rotated past the grace window but not yet expired', async () => {
    await insertRefresh('spent', { rotatedAtMs: -(REFRESH_TOKEN_GRACE_MS + 5000) });
    const r = await lookupRefreshToken('spent');
    expect(r.status).toBe('reuse');
  });

  it('not_found: an expired token', async () => {
    await insertRefresh('expired', { expiresInMs: -1000 });
    expect((await lookupRefreshToken('expired')).status).toBe('not_found');
  });

  it('not_found: an unknown token', async () => {
    expect((await lookupRefreshToken('never-issued')).status).toBe('not_found');
  });
});

describe('bumpSessionVersion', () => {
  it('increments the user session_version', async () => {
    await bumpSessionVersion(USER_ID);
    const r = await client.query<{ session_version: number }>(
      `SELECT session_version FROM users WHERE id = $1`,
      [USER_ID]
    );
    expect(r.rows[0].session_version).toBe(1);
  });
});

function bearer(token: string): NextRequest {
  return new NextRequest('http://localhost/api/v2/protected', {
    headers: { Authorization: `Bearer ${token}` },
  });
}

describe('reset-vs-refresh interleaving (spec 4)', () => {
  it('a token minted by a refresh that captured the PRE-reset version is rejected', async () => {
    // A refresh authorizes and captures session_version = 0.
    const capturedVersion = 0;

    // Concurrently, a password reset commits: bump version → 1 and revoke tokens.
    await bumpSessionVersion(USER_ID);
    await deleteUserTokens(USER_ID);

    // The refresh (unaware) now issues a new pair embedding the captured (stale) version.
    const { accessToken } = await issueTokenPair(USER_ID, capturedVersion);

    // Using that access token fails: its embedded version (0) != current (1).
    const result = await authenticateRequest(bearer(accessToken));
    expect('error' in result).toBe(true);
    if ('error' in result) expect(result.error.status).toBe(401);
  });

  it('a token minted with the CURRENT version still authenticates', async () => {
    const { accessToken } = await issueTokenPair(USER_ID, 0); // current version is 0
    const result = await authenticateRequest(bearer(accessToken));
    expect('user' in result).toBe(true);
  });
});

describe('rotated-token reuse end-to-end (validateRefreshToken)', () => {
  it('rejects a refresh token replayed after its grace window closed', async () => {
    const token = generateToken(USER_ID, 'refresh', 2160, SECRET, 0);
    await insertRefresh(token, { rotatedAtMs: -(REFRESH_TOKEN_GRACE_MS + 5000) });

    const result = await validateRefreshToken(token);
    expect('reuse' in result).toBe(true);
  });

  it('accepts a valid refresh token and returns the user', async () => {
    const token = generateToken(USER_ID, 'refresh', 2160, SECRET, 0);
    await insertRefresh(token);

    const result = await validateRefreshToken(token);
    expect('user' in result).toBe(true);
  });
});

describe('executor threading against a real transaction', () => {
  it('rolls back BOTH rotation and issuance when the transaction throws', async () => {
    // If markTokenRotated/issueTokenPair ignored their `exec` and wrote through the
    // module-level db, the rollback below could not undo them — this proves threading.
    await insertRefresh('rollback-rt');

    await expect(
      db.transaction(async (tx) => {
        await markTokenRotated('rollback-rt', tx);
        await issueTokenPair(USER_ID, 0, tx);
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');

    // Rotation undone: rotated_at still NULL.
    const row = await client.query<{ rotated_at: Date | null }>(
      `SELECT rotated_at FROM tokens WHERE token_hash = $1`,
      [hashToken('rollback-rt')]
    );
    expect(row.rows[0].rotated_at).toBeNull();
    // Issuance undone: only the original token row remains.
    const count = await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM tokens`);
    expect(count.rows[0].n).toBe(1);
  });
});

describe('reset transaction (real DB)', () => {
  it('applies password change, version bump, and token revocation together', async () => {
    await insertRefresh('reset-rt');

    await db.transaction(async (tx) => {
      await updateUser(USER_ID, { passwordHash: 'brand-new-hash' }, tx);
      await bumpSessionVersion(USER_ID, tx);
      await deleteUserTokens(USER_ID, undefined, tx);
    });

    const u = await client.query<{ password_hash: string; session_version: number }>(
      `SELECT password_hash, session_version FROM users WHERE id = $1`,
      [USER_ID]
    );
    expect(u.rows[0].password_hash).toBe('brand-new-hash');
    expect(u.rows[0].session_version).toBe(1);
    const t = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM tokens WHERE user_id = $1`,
      [USER_ID]
    );
    expect(t.rows[0].n).toBe(0);
  });
});

describe('reset/logout-vs-refresh, both orderings', () => {
  it('reverse ordering: a refresh that COMMITTED first is still killed by a later reset', async () => {
    // Refresh commits: issues a valid pair at the current version (0).
    const { accessToken } = await issueTokenPair(USER_ID, 0);
    expect('user' in (await authenticateRequest(bearer(accessToken)))).toBe(true);

    // Reset then commits: bump version + revoke all tokens.
    await db.transaction(async (tx) => {
      await bumpSessionVersion(USER_ID, tx);
      await deleteUserTokens(USER_ID, undefined, tx);
    });

    // The previously-valid access token is now dead (deleted AND version-stale).
    expect('error' in (await authenticateRequest(bearer(accessToken)))).toBe(true);
  });

  it('logout-vs-refresh: a refresh that captured the pre-logout version is rejected', async () => {
    // Logout commits (bump + delete) — mirrors the logout route's transaction.
    await db.transaction(async (tx) => {
      await bumpSessionVersion(USER_ID, tx);
      await deleteUserTokens(USER_ID, undefined, tx);
    });
    // A racing refresh (unaware) issues with the captured pre-logout version (0).
    const { accessToken } = await issueTokenPair(USER_ID, 0);
    // Rejected: embedded version 0 != current 1.
    expect('error' in (await authenticateRequest(bearer(accessToken)))).toBe(true);
  });
});

describe('reset token atomic single-use (real DB)', () => {
  it('conditional delete consumes the token exactly once (second consume returns false)', async () => {
    const resetToken = 'one-time-reset';
    await client.query(
      `INSERT INTO tokens (user_id, token_type, token_hash, expires_at)
       VALUES ($1, 'reset', $2, now() + interval '1 hour')`,
      [USER_ID, hashToken(resetToken)]
    );
    // The DELETE ... RETURNING gives the row to exactly one caller.
    expect(await deleteToken(resetToken)).toBe(true);
    expect(await deleteToken(resetToken)).toBe(false);
  });
});

describe('a stale-version pair is fully rejected (both members)', () => {
  it('rejects BOTH the access and the refresh token after a version bump', async () => {
    const { accessToken, refreshToken } = await issueTokenPair(USER_ID, 0);
    await bumpSessionVersion(USER_ID); // version 0 -> 1

    // Access token: stale version -> rejected.
    expect('error' in (await authenticateRequest(bearer(accessToken)))).toBe(true);
    // Refresh token: also stale version -> rejected (not just the access token).
    expect('error' in (await validateRefreshToken(refreshToken))).toBe(true);
  });
});

describe('missing session_version claim', () => {
  it('is treated as version 0 (legacy tokens still authenticate at version 0)', async () => {
    // A token minted before this field existed carries no session_version claim.
    const legacy = jwt.sign({ user_id: USER_ID, type: 'access' }, SECRET, {
      algorithm: 'HS256',
      expiresIn: '2h',
    });
    await client.query(
      `INSERT INTO tokens (user_id, token_type, token_hash, expires_at)
       VALUES ($1, 'access', $2, now() + interval '2 hours')`,
      [USER_ID, hashToken(legacy)]
    );
    // User is at version 0 → missing claim (?? 0) matches → accepted.
    expect('user' in (await authenticateRequest(bearer(legacy)))).toBe(true);
  });
});
