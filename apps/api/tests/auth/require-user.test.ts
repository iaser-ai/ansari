import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';
import type { PGlite } from '@electric-sql/pglite';

/**
 * `requireUser` and `requireAdmin` end to end: JWTs minted by the real
 * apps/auth, verified against its public JWKS (no credential), users resolved
 * in the app database built from the real journal, the role read with the
 * admin's own JWT (owner amendment 2026-10-17).
 */

const h = vi.hoisted(() => ({ db: null as unknown }));

vi.mock('@/lib/db/index', () => ({
  get db() {
    return h.db;
  },
  closeDb: async () => {},
}));

vi.mock('@sentry/nextjs', () => ({ captureMessage: () => {}, setUser: () => {} }));

import { requireUser } from '@/lib/auth/require-user';
import { requireAdmin } from '@/lib/auth/require-admin';
import { resetEnvCache } from '@/lib/config';
import {
  appDrizzle,
  insertLegacyUserRow,
  legacyAccessToken,
  migrateAppDb,
  setApiEnv,
  startAuth,
  type AuthService,
} from './helpers';
import { signUpTokens, mintJwt } from '../../../auth/tests/helpers/service';

let service: AuthService;
let app: PGlite;
let n = 0;
const nextEmail = (tag: string) => `${tag}-${++n}@require.test`;

function request(token?: string, scheme = 'Bearer') {
  const headers: Record<string, string> = {};
  if (token !== undefined) headers.authorization = `${scheme} ${token}`;
  return new NextRequest('http://localhost/api/v2/threads', { headers });
}

async function errorOf(result: Awaited<ReturnType<typeof requireUser>>) {
  if (!('error' in result)) throw new Error('expected an error');
  return { status: result.error.status, body: await result.error.json() };
}

async function setRole(id: string, role: string) {
  await service.client.query('update auth.users set role = $1 where id = $2', [role, id]);
}

beforeAll(async () => {
  service = await startAuth();
});

afterAll(async () => {
  await service.close();
});

beforeEach(async () => {
  app = await migrateAppDb();
  h.db = appDrizzle(app);
  setApiEnv(service.publicUrl);
});

describe('requireUser', () => {
  it('a JWT from apps/auth resolves to the app user, creating the row on first use', async () => {
    const email = nextEmail('ok');
    const { id, jwt } = await signUpTokens(service, email);
    const result = await requireUser(request(jwt));
    expect('user' in result && { id: result.user.id, email: result.user.email }).toEqual({ id, email });
  });

  it('the JWKS is public: anyone can fetch it, and apps/api needs no credential', async () => {
    const { jwt } = await signUpTokens(service, nextEmail('public-jwks'));
    const direct = await fetch(`${service.publicUrl}/api/auth/jwks`, {
      headers: { 'x-real-ip': '203.0.113.200' },
    });
    expect(direct.status).toBe(200);
    expect('user' in (await requireUser(request(jwt)))).toBe(true);
  });

  it("first use: a token whose session has ended gets no app row (apps/auth's live-sid check)", async () => {
    const { id, jwt, sessionToken } = await signUpTokens(service, nextEmail('dead-first-use'));
    await service.client.query('delete from auth.session where token = $1', [sessionToken]);
    expect(await errorOf(await requireUser(request(jwt)))).toEqual({
      status: 401,
      body: { detail: 'Token not found or expired' },
    });
    const { rows } = await app.query('select id from users where id = $1', [id]);
    expect(rows).toEqual([]);
  });

  it('no bearer: 401 Not authenticated', async () => {
    for (const req of [request(), request('abc', 'Basic'), request('a b')]) {
      expect(await errorOf(await requireUser(req))).toEqual({
        status: 401,
        body: { detail: 'Not authenticated' },
      });
    }
  });

  it('a token that does not verify: 401 Invalid or expired token', async () => {
    const legacy = await legacyAccessToken();
    for (const token of ['garbage', legacy]) {
      expect(await errorOf(await requireUser(request(token)))).toEqual({
        status: 401,
        body: { detail: 'Invalid or expired token' },
      });
    }
  });

  it('a deleted account: 401 Token not found or expired, the legacy detail', async () => {
    const { id, jwt } = await signUpTokens(service, nextEmail('deleted'));
    await requireUser(request(jwt));
    await app.query('delete from users where id = $1', [id]);
    await app.query('insert into deleted_users (id) values ($1)', [id]);
    expect(await errorOf(await requireUser(request(jwt)))).toEqual({
      status: 401,
      body: { detail: 'Token not found or expired' },
    });
  });

  it('an email conflict: 401, no row, never a 500', async () => {
    const email = nextEmail('conflict');
    await insertLegacyUserRow(app, email);
    const { id, jwt } = await signUpTokens(service, email);
    vi.spyOn(console, 'warn').mockImplementationOnce(() => {});
    expect(await errorOf(await requireUser(request(jwt)))).toEqual({
      status: 401,
      body: { detail: 'Token not found or expired' },
    });
    const { rows } = await app.query('select 1 from users where id = $1', [id]);
    expect(rows).toHaveLength(0);
  });
});

describe('requireAdmin', () => {
  async function adminUser(tag: string) {
    const email = nextEmail(tag);
    const tokens = await signUpTokens(service, email);
    await setRole(tokens.id, 'admin');
    return { ...tokens, email };
  }

  it('an admin passes', async () => {
    const { id, jwt } = await adminUser('admin');
    const result = await requireAdmin(request(jwt));
    expect('user' in result && result.user.id).toBe(id);
  });

  it('a non-admin gets 403', async () => {
    const { jwt } = await signUpTokens(service, nextEmail('plain'));
    expect(await errorOf(await requireAdmin(request(jwt)))).toEqual({
      status: 403,
      body: { detail: 'Admin access required' },
    });
  });

  it('an unauthenticated request gets 401', async () => {
    expect((await errorOf(await requireAdmin(request()))).status).toBe(401);
  });

  it('a banned admin gets 403 while the JWT is still valid', async () => {
    const { id, jwt } = await adminUser('banned');
    expect('user' in (await requireAdmin(request(jwt)))).toBe(true);
    await service.client.query('update auth.users set banned = true where id = $1', [id]);
    expect((await errorOf(await requireAdmin(request(jwt)))).status).toBe(403);
  });

  it('an expired ban no longer blocks', async () => {
    const { id, jwt } = await adminUser('ban-expired');
    await service.client.query(
      "update auth.users set banned = true, ban_expires = now() - interval '1 minute' where id = $1",
      [id]
    );
    expect('user' in (await requireAdmin(request(jwt)))).toBe(true);
  });

  it('a demotion takes effect on the very next request', async () => {
    const { id, jwt } = await adminUser('demoted');
    expect('user' in (await requireAdmin(request(jwt)))).toBe(true);
    await setRole(id, 'user');
    expect((await errorOf(await requireAdmin(request(jwt)))).status).toBe(403);
  });

  it("a revoked session loses admin on the very next request, though the JWT has not expired", async () => {
    const { jwt, sessionToken } = await adminUser('revoked');
    expect('user' in (await requireAdmin(request(jwt)))).toBe(true);
    await service.client.query('delete from auth.session where token = $1', [sessionToken]);
    expect((await errorOf(await requireAdmin(request(jwt)))).status).toBe(403);
  });

  it('an app user apps/auth no longer knows gets 403', async () => {
    const { id, jwt } = await adminUser('gone');
    expect('user' in (await requireAdmin(request(jwt)))).toBe(true);
    await service.client.query('delete from auth.users where id = $1', [id]);
    expect((await errorOf(await requireAdmin(request(jwt)))).status).toBe(403);
  });

  it('a role that only contains "admin" is not admin', async () => {
    const { id, jwt } = await signUpTokens(service, nextEmail('lookalike'));
    await setRole(id, 'superadmin');
    expect((await errorOf(await requireAdmin(request(jwt)))).status).toBe(403);
  });

  it('apps/auth unreachable: 503, never access', async () => {
    // A second apps/auth that can be stopped: warm the JWKS cache and create
    // the app row through it, then take it away.
    const outage = await startAuth();
    const admin = await signUpTokens(outage, nextEmail('outage-admin'));
    await outage.client.query("update auth.users set role = 'admin' where id = $1", [admin.id]);
    const fresh = await mintJwt(outage, admin.sessionToken);
    expect('user' in (await requireAdmin(request(fresh)))).toBe(true);
    await outage.close();

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(await errorOf(await requireAdmin(request(fresh)))).toEqual({
        status: 503,
        body: { detail: 'Authentication service unavailable' },
      });
    } finally {
      warn.mockRestore();
      setApiEnv(service.publicUrl);
    }
  });

  it('first use while apps/auth is unreachable: 503 from requireUser, not 401', async () => {
    const outage = await startAuth();
    const { jwt } = await signUpTokens(outage, nextEmail('first-use-outage'));
    // Warm only the JWKS: a token for a user with no profile on record.
    const other = await signUpTokens(outage, nextEmail('warm'));
    await requireUser(request(other.jwt));
    await outage.close();

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(await errorOf(await requireUser(request(jwt)))).toEqual({
        status: 503,
        body: { detail: 'Authentication service unavailable' },
      });
    } finally {
      warn.mockRestore();
      resetEnvCache();
      setApiEnv(service.publicUrl);
    }
  });
});
