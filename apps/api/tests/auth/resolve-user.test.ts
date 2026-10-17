import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';

/**
 * First-use app rows, tombstones and refusals (spec 300 scenarios 9a, 9c, 9f),
 * against the real apps/auth (both listeners over its own pglite) and the app
 * database built from the real journal. Only the app `db` handle and Sentry
 * are mocked.
 */

const h = vi.hoisted(() => ({
  db: null as unknown,
  sentry: [] as { message: string; extra: unknown }[],
}));

vi.mock('@/lib/db/index', () => ({
  get db() {
    return h.db;
  },
  closeDb: async () => {},
}));

vi.mock('@sentry/nextjs', () => ({
  captureMessage: (message: string, context: { extra?: unknown }) => {
    h.sentry.push({ message, extra: context?.extra });
  },
  setUser: () => {},
}));

import { resolveUser } from '@/lib/auth/resolve-user';
import { getOrCreateSystemUser } from '@/lib/db/users';
import { resetEnvCache } from '@/lib/config';
import {
  appDrizzle,
  insertLegacyUserRow,
  deadUrl,
  migrateAppDb,
  startAuth,
  type AuthService,
} from './helpers';
import { mintJwt, signUpTokens, send, STRONG_PASSWORD } from '../../../auth/tests/helpers/service';

let service: AuthService;
let app: PGlite;
let n = 0;
const nextEmail = (tag: string) => `${tag}-${++n}@resolve.test`;

beforeAll(async () => {
  service = await startAuth();
});

afterAll(async () => {
  await service.close();
});

beforeEach(async () => {
  app = await migrateAppDb();
  h.db = appDrizzle(app);
  h.sentry.length = 0;
  process.env.AUTH_URL = service.publicUrl;
  resetEnvCache();
});

async function appUser(id: string) {
  const { rows } = await app.query<Record<string, unknown>>(
    'select id, email, first_name, last_name, registered_via, password_hash, system_key from users where id = $1',
    [id]
  );
  return rows[0];
}

async function appUserCount() {
  const { rows } = await app.query<{ n: number }>('select count(*)::int as n from users');
  return rows[0].n;
}

async function authUserCount(id: string) {
  const { rows } = await service.client.query<{ n: number }>(
    'select count(*)::int as n from auth.users where id = $1',
    [id]
  );
  return rows[0].n;
}

/** A user who signs up directly at apps/auth, as apps/frontend does, with their JWT. */
async function signUpDirect(email: string) {
  const res = await send(service.publicUrl, '/api/auth/sign-up/email', {
    body: { email, password: STRONG_PASSWORD, name: 'Amina Yusuf', first_name: 'Amina', last_name: 'Yusuf' },
    headers: { 'x-ansari-client': 'web' },
  });
  expect(res.status).toBe(200);
  const { user, token } = (await res.json()) as { user: { id: string }; token: string };
  return { id: user.id, sessionToken: token, jwt: await mintJwt(service, token) };
}

async function writeTombstone(id: string, authDeleted: boolean) {
  await app.query('delete from users where id = $1', [id]);
  await app.query('insert into deleted_users (id, auth_deleted_at) values ($1, $2)', [
    id,
    authDeleted ? new Date() : null,
  ]);
}

async function tombstone(id: string) {
  const { rows } = await app.query<{ auth_deleted_at: Date | null }>(
    'select auth_deleted_at from deleted_users where id = $1',
    [id]
  );
  return rows[0];
}

/** Every argument any console.warn call received, serialized. */
function captureWarnings() {
  const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  return {
    text: () => JSON.stringify(spy.mock.calls),
    restore: () => spy.mockRestore(),
  };
}

describe('scenario 9c: first-use app row', () => {
  it('creates the row from the profile, with the same id, email and names', async () => {
    const email = nextEmail('direct');
    const { id, jwt } = await signUpDirect(email);
    const result = await resolveUser(id, jwt);
    expect(result.kind).toBe('user');
    expect(await appUser(id)).toEqual({
      id,
      email,
      first_name: 'Amina',
      last_name: 'Yusuf',
      registered_via: 'web',
      password_hash: null,
      system_key: null,
    });
  });

  it('two concurrent first requests create one row', async () => {
    const { id, jwt } = await signUpDirect(nextEmail('race'));
    const results = await Promise.all([resolveUser(id, jwt), resolveUser(id, jwt)]);
    expect(results.map((r) => r.kind)).toEqual(['user', 'user']);
    expect(await appUserCount()).toBe(1);
  });

  it('an existing row is read without asking apps/auth', async () => {
    const { id, jwt } = await signUpDirect(nextEmail('steady'));
    await resolveUser(id, jwt);

    process.env.AUTH_URL = await deadUrl();
    resetEnvCache();
    const result = await resolveUser(id, jwt);
    expect(result.kind === 'user' && result.user.id).toBe(id);
  });

  it('an existing user costs one read, and never the tombstone table (steady state)', async () => {
    const { id, jwt } = await signUpDirect(nextEmail('one-read'));
    await resolveUser(id, jwt);
    const spy = vi.spyOn(app, 'query');
    try {
      const result = await resolveUser(id, jwt);
      expect(result.kind === 'user' && result.user.id).toBe(id);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(String(spy.mock.calls[0]?.[0])).not.toMatch(/deleted_users/);
    } finally {
      spy.mockRestore();
    }
  });

  it('a sub apps/auth does not know is refused, and gets no row', async () => {
    const sub = randomUUID();
    const { token } = await service.auth.api.signJWT({ body: { payload: { sub, sid: randomUUID() } } });
    const result = await resolveUser(sub, token);
    expect(result.kind).toBe('refused');
    expect(await appUserCount()).toBe(0);
  });

  it('apps/auth unreachable on first use is unavailable, not refused, and writes nothing', async () => {
    const { id, jwt } = await signUpDirect(nextEmail('outage'));
    process.env.AUTH_URL = await deadUrl();
    resetEnvCache();
    expect((await resolveUser(id, jwt)).kind).toBe('unavailable');
    expect(await appUserCount()).toBe(0);
  });
});

describe('scenario 9f: an email the app database already holds', () => {
  it('a legacy row under another id: refused, no row, ids-only log, alert', async () => {
    const email = nextEmail('legacy');
    const legacy = await insertLegacyUserRow(app, email);
    const { id, jwt } = await signUpDirect(email);
    const warnings = captureWarnings();

    try {
      expect((await resolveUser(id, jwt)).kind).toBe('refused');
      expect(await appUser(id)).toBeUndefined();
      expect(warnings.text()).toContain(id);
      expect(warnings.text()).toContain(legacy.id);
      expect(warnings.text()).not.toContain(email);
      expect(h.sentry).toEqual([
        { message: 'auth user has no app row: email-conflict', extra: { sub: id, holderId: legacy.id } },
      ]);
      expect(JSON.stringify(h.sentry)).not.toContain(email);
    } finally {
      warnings.restore();
    }
  });

  it('a system row holding the email: refused as system-email', async () => {
    const system = await getOrCreateSystemUser('ai-skill');
    const email = nextEmail('sys-held');
    await app.query('update users set email = $1 where id = $2', [email, system.id]);
    const { id, jwt } = await signUpDirect(email);
    const warnings = captureWarnings();

    try {
      expect((await resolveUser(id, jwt)).kind).toBe('refused');
      expect(await appUser(id)).toBeUndefined();
      expect(h.sentry).toEqual([
        { message: 'auth user has no app row: system-email', extra: { sub: id, holderId: system.id } },
      ]);
    } finally {
      warnings.restore();
    }
  });

  it('an @system.ansari.chat address: refused as reserved-domain', async () => {
    // apps/auth's sign-up hook refuses this domain, so plant it behind it.
    const { id, jwt } = await signUpDirect(nextEmail('planted'));
    const email = 'planted@system.ansari.chat';
    await service.client.query('update auth.users set email = $1 where id = $2', [email, id]);
    const warnings = captureWarnings();

    try {
      expect((await resolveUser(id, jwt)).kind).toBe('refused');
      expect(await appUserCount()).toBe(0);
      expect(warnings.text()).not.toContain(email);
      expect(h.sentry).toEqual([
        { message: 'auth user has no app row: reserved-domain', extra: { sub: id, holderId: null } },
      ]);
    } finally {
      warnings.restore();
    }
  });

  it('the email is compared normalized', async () => {
    const email = nextEmail('case');
    const legacy = await insertLegacyUserRow(app, email);
    const { id, jwt } = await signUpDirect(email);
    await service.client.query('update auth.users set email = $1 where id = $2', [
      `  ${email.toUpperCase()} `,
      id,
    ]);
    const warnings = captureWarnings();
    try {
      expect((await resolveUser(id, jwt)).kind).toBe('refused');
      expect(h.sentry[0]?.extra).toEqual({ sub: id, holderId: legacy.id });
    } finally {
      warnings.restore();
    }
  });
});

describe('scenario 9a: tombstones', () => {
  it('a pending tombstone: the next request completes the auth delete and is refused', async () => {
    const email = nextEmail('pending');
    const { id, jwt } = await signUpTokens(service, email);
    await resolveUser(id, jwt);
    await writeTombstone(id, false);

    expect((await resolveUser(id, jwt)).kind).toBe('refused');
    expect(await authUserCount(id)).toBe(0);
    expect((await tombstone(id)).auth_deleted_at).toBeInstanceOf(Date);
    expect(await appUser(id)).toBeUndefined();
  });

  it('apps/auth failing: the tombstone stays pending and the request is still refused', async () => {
    const { id, jwt } = await signUpTokens(service, nextEmail('auth-down'));
    await resolveUser(id, jwt);
    await writeTombstone(id, false);
    process.env.AUTH_URL = await deadUrl();
    resetEnvCache();
    const warnings = captureWarnings();

    try {
      expect((await resolveUser(id, jwt)).kind).toBe('refused');
      expect((await tombstone(id)).auth_deleted_at).toBeNull();
      expect(await appUser(id)).toBeUndefined();
    } finally {
      warnings.restore();
    }

    // apps/auth is back: the next request finishes the job.
    process.env.AUTH_URL = service.publicUrl;
    resetEnvCache();
    expect((await resolveUser(id, jwt)).kind).toBe('refused');
    expect(await authUserCount(id)).toBe(0);
    expect((await tombstone(id)).auth_deleted_at).toBeInstanceOf(Date);
  });

  it("another user's JWT never completes a pending delete, and that user is untouched", async () => {
    // apps/auth deletes the TOKEN's subject, so the client refuses a token that
    // is not the tombstoned user's before any call (NotTheSubjectError).
    const target = await signUpTokens(service, nextEmail('target'));
    const other = await signUpTokens(service, nextEmail('other'));
    await resolveUser(target.id, target.jwt);
    await writeTombstone(target.id, false);
    const warnings = captureWarnings();

    try {
      expect((await resolveUser(target.id, other.jwt)).kind).toBe('refused');
      expect(await authUserCount(target.id)).toBe(1);
      expect(await authUserCount(other.id)).toBe(1);
      expect((await tombstone(target.id)).auth_deleted_at).toBeNull();
      expect(warnings.text()).toContain('NotTheSubjectError');
    } finally {
      warnings.restore();
    }
  });

  it('a delete that commits while the first-use insert runs: refused, no row survives', async () => {
    // The real race needs two connections (the INSERT's NOT EXISTS snapshot
    // predates the delete's commit); pglite has one. This trigger stands in
    // for it: the tombstone appears after NOT EXISTS has passed and as the
    // row lands, which is the state the race leaves behind.
    await app.exec(`
      CREATE FUNCTION plant_tombstone() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN INSERT INTO deleted_users (id) VALUES (NEW.id); RETURN NEW; END $$;
      CREATE TRIGGER plant_tombstone AFTER INSERT ON users
        FOR EACH ROW EXECUTE FUNCTION plant_tombstone();
    `);
    const { id, jwt } = await signUpDirect(nextEmail('race-delete'));

    expect((await resolveUser(id, jwt)).kind).toBe('refused');
    expect(await appUser(id)).toBeUndefined();
  });

  it('the profile path never re-creates a tombstoned id', async () => {
    // The auth user still exists (say the operator has not run yet), and the
    // tombstone is marked done: nothing may bring the app row back.
    const { id, jwt } = await signUpTokens(service, nextEmail('no-resurrect'));
    await writeTombstone(id, true);

    expect((await resolveUser(id, jwt)).kind).toBe('refused');
    expect(await appUser(id)).toBeUndefined();
    expect(await authUserCount(id)).toBe(1);
  });
});

describe('owner-accepted residual R3: a delete made directly at apps/auth', () => {
  // DELETE /api/account with the user's own token, bypassing apps/api, removes
  // the auth user but leaves the app row and writes no tombstone. A later
  // sign-up with the same email gets a NEW auth id, and first use refuses it as
  // an email conflict whose holder is the orphan row. The Sentry alert names
  // the holder id; the operator response is the orphan audit and cleanup in
  // docs/cutover/better-auth-cutover.md ("Orphan app rows").
  it('re-sign-up with the same email is refused as email-conflict, naming the orphan holder', async () => {
    const email = nextEmail('direct-delete');
    const first = await signUpDirect(email);
    expect((await resolveUser(first.id, first.jwt)).kind).toBe('user');
    const del = await send(service.publicUrl, '/api/account', { method: 'DELETE', bearer: first.jwt });
    expect(del.status).toBe(204);
    expect(await appUser(first.id)).toBeDefined();
    expect(await tombstone(first.id)).toBeUndefined();

    const second = await signUpDirect(email);
    expect(second.id).not.toBe(first.id);
    const warnings = captureWarnings();
    try {
      expect((await resolveUser(second.id, second.jwt)).kind).toBe('refused');
      expect(h.sentry).toEqual([
        { message: 'auth user has no app row: email-conflict', extra: { sub: second.id, holderId: first.id } },
      ]);
    } finally {
      warnings.restore();
    }

    // The documented cleanup: delete the orphan row and tombstone its id, in
    // one transaction. Then the new account's first use succeeds.
    // The runbook's statement, with its psql variable bound as a parameter.
    const cleanup = await app.query(
      `WITH gone AS (DELETE FROM users WHERE id = $1 AND system_key IS NULL RETURNING id)
       INSERT INTO deleted_users (id, auth_deleted_at) SELECT id, now() FROM gone`,
      [first.id]
    );
    expect(cleanup.affectedRows).toBe(1);
    expect((await resolveUser(second.id, second.jwt)).kind).toBe('user');
  });
});
