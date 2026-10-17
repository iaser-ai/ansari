import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { NextRequest } from 'next/server';
import type { PGlite } from '@electric-sql/pglite';

/**
 * The compatibility layer and the switched routes end to end (spec 300, plan
 * phase 8): apps/api's real handlers → the real apps/auth over HTTP on
 * localhost (both listeners, its own pglite) → and the app database built from
 * the real journal (a second pglite). The phase 1 contract suite runs these
 * routes too; this suite covers what the contract does not pin.
 */

const h = vi.hoisted(() => ({ db: null as unknown }));

vi.mock('@/lib/db/index', () => ({
  get db() {
    return h.db;
  },
  closeDb: async () => {},
}));

vi.mock('@sentry/nextjs', () => ({
  captureMessage: () => {},
  captureException: () => {},
  setUser: () => {},
  setTag: () => {},
}));

import bcrypt from 'bcrypt';
import { POST as register } from '../../src/app/api/v2/users/register/route';
import { POST as login } from '../../src/app/api/v2/users/login/route';
import { POST as refreshToken } from '../../src/app/api/v2/users/refresh_token/route';
import { POST as logout } from '../../src/app/api/v2/users/logout/route';
import { DELETE as meDelete, GET as meGet } from '../../src/app/api/v2/users/me/route';
import { POST as requestReset } from '../../src/app/api/v2/request_password_reset/route';
import { POST as resetPassword } from '../../src/app/api/v2/reset_password/route';
import { GET as threadsGet } from '../../src/app/api/v2/threads/route';
import { GET as threadGet } from '../../src/app/api/v2/threads/[id]/route';
import { GET as adminStats } from '../../src/app/api/v2/admin/stats/route';
import { POST as chatCompletions } from '../../src/app/api/v1/chat/completions/route';
import { resetEnvCache } from '@/lib/config';
import { banUserByEmail } from '../../../../packages/auth/src/users';
import {
  API_EGRESS_IP,
  appDrizzle,
  legacyAccessToken,
  migrateAppDb,
  setApiEnv,
  startAuth,
  startEdge,
  type AuthService,
  type Edge,
} from './helpers';
import { resetRateLimitStore } from '@/lib/rate-limit';
import { LEGACY_IP_LIMITS } from '@/lib/auth-service/limits';
import { send, signIn, signUp, STRONG_PASSWORD } from '../../../auth/tests/helpers/service';

type Handler = (request: NextRequest, context?: never) => Promise<Response>;

let service: AuthService;
let app: PGlite;
let n = 0;
let ip = 0;
const nextEmail = (tag: string) => `${tag}-${++n}@layer.test`;
const nextIp = () => `203.0.113.${(++ip % 250) + 1}`;

interface CallOptions {
  body?: unknown;
  token?: string;
  ip?: string | null;
  headers?: Record<string, string>;
  url?: string;
}

async function call(handler: Handler, options: CallOptions = {}, context?: unknown) {
  const headers: Record<string, string> = { ...options.headers };
  const clientIp = options.ip === undefined ? nextIp() : options.ip;
  if (clientIp) headers['x-real-ip'] = clientIp;
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  const request = new NextRequest(options.url ?? 'http://localhost/api/v2/x', {
    method: options.body === undefined ? 'GET' : 'POST',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const response = await (handler as (r: NextRequest, c?: unknown) => Promise<Response>)(request, context);
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : undefined };
}

async function registerUser(email = nextEmail('user'), extra: Record<string, unknown> = {}) {
  const res = await call(register, { body: { email, password: STRONG_PASSWORD, ...extra } });
  expect(res.status).toBe(200);
  return { email, access: res.body.access_token as string, refresh: res.body.refresh_token as string };
}

async function idOf(email: string) {
  const { rows } = await app.query<{ id: string }>('select id from users where email = $1', [email]);
  return rows[0]?.id;
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
  resetRateLimitStore();
  await service.client.exec('TRUNCATE auth.rate_limit, auth.verification');
  service.mail.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('scenario 1: a migrated legacy user', () => {
  it('logs in through the layer with the legacy password; me has the same id; threads list', async () => {
    const email = nextEmail('legacy');
    const { rows } = await app.query<{ id: string }>(
      "insert into users (email, first_name, last_name) values ($1, 'Amina', 'Khan') returning id",
      [email]
    );
    const id = rows[0].id;
    await app.query("insert into threads (user_id, name) values ($1, 'old thread')", [id]);
    await service.client.query(
      "insert into auth.users (id, name, email, email_verified, first_name, last_name) values ($1, 'Amina', $2, true, 'Amina', 'Khan')",
      [id, email]
    );
    await service.client.query(
      "insert into auth.account (account_id, provider_id, user_id, password, updated_at) values ($1, 'credential', $2, $3, now())",
      [id, id, await bcrypt.hash(STRONG_PASSWORD, 10)]
    );

    const res = await call(login, { body: { email, password: STRONG_PASSWORD } });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ first_name: 'Amina', last_name: 'Khan', token_type: 'bearer' });
    expect((await call(meGet, { token: res.body.access_token })).body.id).toBe(id);
    const threads = await call(threadsGet, { token: res.body.access_token });
    expect(threads.body.map((t: { thread_name: string }) => t.thread_name)).toEqual(['old thread']);
  });
});

describe('scenario 3: register through the layer', () => {
  it('stores scrypt, writes both rows with one id, and logout then login works', async () => {
    const { email, access } = await registerUser(nextEmail('new'), { first_name: 'Bilal' });
    const id = await idOf(email);
    const { rows } = await service.client.query<{ password: string; user_id: string }>(
      "select a.password, a.user_id from auth.account a join auth.users u on u.id = a.user_id where u.email = $1 and a.provider_id = 'credential'",
      [email]
    );
    expect(rows[0].user_id).toBe(id);
    expect(rows[0].password.startsWith('$2')).toBe(false);
    expect(rows[0].password).toMatch(/^[0-9a-f]+:[0-9a-f]+$/);

    expect((await call(logout, { token: access })).status).toBe(200);
    const again = await call(login, { body: { email, password: STRONG_PASSWORD } });
    expect(again.status).toBe(200);
    expect(again.body.first_name).toBe('Bilal');
  });

  it('forwards X-Ansari-Client and the newsletter opt-in to apps/auth', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await call(register, {
      body: { email: nextEmail('optin'), password: STRONG_PASSWORD, register_to_mail_list: true },
      headers: { 'x-ansari-client': 'askansari-ios' },
    });
    const signUpCall = fetchSpy.mock.calls.find(([url]) => String(url).endsWith('/api/auth/sign-up/email'));
    const init = signUpCall?.[1] as RequestInit;
    expect(JSON.parse(init.body as string).register_to_mail_list).toBe(true);
    expect(new Headers(init.headers).get('x-ansari-client')).toBe('askansari-ios');
  });

  it('apps/auth unreachable: 503, never a credentials error', async () => {
    process.env.AUTH_URL = 'http://127.0.0.1:9';
    resetEnvCache();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await call(login, { body: { email: nextEmail('down'), password: STRONG_PASSWORD } })).status).toBe(503);
    expect((await call(register, { body: { email: nextEmail('down'), password: STRONG_PASSWORD } })).status).toBe(503);
  });

  it('every layer route answers 503 with the legacy detail when apps/auth is unreachable', async () => {
    const { refresh } = await registerUser(nextEmail('outage-all'));
    process.env.AUTH_URL = 'http://127.0.0.1:9';
    resetEnvCache();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const unavailable = { status: 503, body: { detail: 'Authentication service unavailable' } };
    expect(await call(requestReset, { body: { email: nextEmail('any') } })).toEqual(unavailable);
    expect(await call(resetPassword, { body: { reset_token: 'x', new_password: STRONG_PASSWORD } })).toEqual(unavailable);
    expect(await call(refreshToken, { body: { refresh_token: refresh } })).toEqual(unavailable);
    expect(await call(login, { body: { email: nextEmail('any'), password: STRONG_PASSWORD } })).toEqual(unavailable);
  });
});

describe('layer edges the contract does not reach', () => {
  it('register refuses an address only the app database holds (a system row), before apps/auth', async () => {
    const email = nextEmail('app-only');
    await app.query("insert into users (email, system_key) values ($1, 'leaderboard')", [email]);
    expect(await call(register, { body: { email, password: STRONG_PASSWORD } })).toEqual({
      status: 409,
      body: { detail: 'An account with this email already exists' },
    });
    expect((await service.client.query('select 1 from auth.users where email = $1', [email])).rows).toHaveLength(0);
  });

  it('login refuses an account apps/api will not accept (its email is held under another id)', async () => {
    const email = nextEmail('conflict');
    expect((await signUp(service, email)).status).toBe(200);
    await app.query('insert into users (email) values ($1)', [email]);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await call(login, { body: { email, password: STRONG_PASSWORD } })).toEqual({
      status: 401,
      body: { detail: 'Invalid email or password' },
    });
  });

  it('reset: better-auth\'s minimum length refuses a short password the score passed, as a weak password', async () => {
    const { email } = await registerUser(nextEmail('short-reset'));
    await call(requestReset, { body: { email } });
    const mail = await vi.waitFor(() => {
      const sent = service.mail.find((m) => m.to === email);
      if (!sent) throw new Error('no reset mail yet');
      return sent;
    });
    const token = decodeURIComponent(/reset-password\?token=([^"'&<\s]+)/.exec(mail.html)![1]);
    expect(await call(resetPassword, { body: { reset_token: token, new_password: 'Sh0rt!7' } })).toEqual({
      status: 400,
      body: { detail: 'Password is too weak. Use at least 8 characters' },
    });
  });

  it("reset requests over apps/api's per-IP limit are a 429, for known and unknown emails alike", async () => {
    const clientIp = '198.51.100.41';
    const { max } = LEGACY_IP_LIMITS.request_password_reset;
    const statuses: number[] = [];
    for (let i = 0; i <= max; i++) {
      statuses.push((await call(requestReset, { body: { email: nextEmail('nobody') }, ip: clientIp })).status);
    }
    expect(statuses).toEqual([...Array<number>(max).fill(200), 429]);
  });

  it("apps/auth's per-email reset cap still holds behind it, across client IPs", async () => {
    const email = nextEmail('reset-cap');
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) statuses.push((await call(requestReset, { body: { email } })).status);
    expect(statuses).toEqual([200, 200, 200, 429]);
  });

  it('the layer forwards no client IP and no credential to apps/auth', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await registerUser(nextEmail('no-forward'));
    const calls = fetchSpy.mock.calls.filter(([url]) => String(url).startsWith(service.publicUrl));
    expect(calls.length).toBeGreaterThanOrEqual(2);
    for (const [, init] of calls) {
      const names = [...new Headers((init as RequestInit).headers).keys()];
      expect(names.filter((n) => n === 'x-real-ip' || n.startsWith('x-ansari-internal') || n.startsWith('x-ansari-forwarded'))).toEqual([]);
    }
  });

  it('refresh_token returns the same session token it was given', async () => {
    const { refresh } = await registerUser(nextEmail('same-refresh'));
    const res = await call(refreshToken, { body: { refresh_token: refresh } });
    expect(res.body.refresh_token).toBe(refresh);
    expect(res.body.access_token).not.toBe(refresh);
  });
});

describe('scenario 9: account deletion', () => {
  it('a 25-hour-old session: delete succeeds, cascades, and the JWT then gets 401', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() });
    const { email, refresh } = await registerUser(nextEmail('old-session'));
    const id = await idOf(email);
    await app.query("insert into threads (user_id, name) values ($1, 't')", [id]);
    await app.query("insert into preferences (user_id, key, value) values ($1, 'k', 'v')", [id]);

    vi.setSystemTime(Date.now() + 25 * 60 * 60 * 1000);
    const fresh = await call(refreshToken, { body: { refresh_token: refresh } });
    expect(fresh.status).toBe(200);
    const jwt = fresh.body.access_token as string;

    expect((await call(meDelete, { token: jwt })).body).toEqual({ message: 'Account successfully deleted' });
    const { rows } = await app.query<{ n: number }>(
      'select (select count(*) from threads where user_id = $1)::int + (select count(*) from preferences where user_id = $1)::int as n',
      [id]
    );
    expect(rows[0].n).toBe(0);
    const tombstone = await app.query<{ auth_deleted_at: Date | null }>(
      'select auth_deleted_at from deleted_users where id = $1',
      [id]
    );
    expect(tombstone.rows[0].auth_deleted_at).toBeInstanceOf(Date);
    expect((await service.client.query('select 1 from auth.users where id = $1', [id])).rows).toHaveLength(0);
    expect(await call(threadsGet, { token: jwt })).toEqual({
      status: 401,
      body: { detail: 'Token not found or expired' },
    });
  });

  it('scenario 9b: a system account is refused before anything is deleted', async () => {
    const { email, access } = await registerUser(nextEmail('sys'));
    const id = await idOf(email);
    await app.query("update users set system_key = 'ai-skill' where id = $1", [id]);
    await app.query("insert into threads (user_id, name) values ($1, 'kept')", [id]);

    const res = await call(meDelete, { token: access });
    expect(res.status).toBe(403);
    expect(await idOf(email)).toBe(id);
    expect((await app.query('select 1 from threads where user_id = $1', [id])).rows).toHaveLength(1);
    expect((await app.query('select 1 from deleted_users where id = $1', [id])).rows).toHaveLength(0);
  });
});

describe('scenario 19: the identical 409, layer and direct', () => {
  it('a taken address and a reserved one give the same answer on both paths', async () => {
    const { email } = await registerUser(nextEmail('taken'));
    const layerTaken = await call(register, { body: { email, password: STRONG_PASSWORD } });
    const layerReserved = await call(register, {
      body: { email: 'x@system.ansari.chat', password: STRONG_PASSWORD },
    });
    expect(layerTaken).toEqual({ status: 409, body: { detail: 'An account with this email already exists' } });
    expect(layerReserved).toEqual(layerTaken);

    for (const address of [email, 'x@system.ansari.chat']) {
      const direct = await signUp(service, address);
      expect(direct.status).toBe(409);
      expect(((await direct.json()) as { message: string }).message).toBe(layerTaken.body.detail);
    }
  });
});

describe('scenario 20: a system address reset', () => {
  it('sends nothing and creates nothing', async () => {
    const res = await call(requestReset, { body: { email: 'ai-skill@system.ansari.chat' } });
    expect(res).toEqual({ status: 200, body: { status: 'success' } });
    await new Promise((r) => setTimeout(r, 50));
    expect(service.mail).toHaveLength(0);
    const { rows } = await service.client.query('select 1 from auth.verification union all select 1 from auth.users where email like $1', ['%@system.ansari.chat']);
    expect(rows).toHaveLength(0);
  });
});

describe('scenarios 21 and 22: sign-in limits through the layer', () => {
  // The per-IP rule runs in apps/api (lib/auth-service/limits.ts): apps/auth
  // sees only apps/api's IP on layer calls, and keys none of them by IP.
  it(`login ${LEGACY_IP_LIMITS.login.max + 1} from one X-Real-IP is 429 at apps/api, before apps/auth; forged XFF changes nothing`, async () => {
    const { email } = await registerUser(nextEmail('limited'));
    const clientIp = '198.51.100.21';
    for (let i = 0; i < LEGACY_IP_LIMITS.login.max; i++) {
      const res = await call(login, {
        body: { email, password: STRONG_PASSWORD },
        ip: clientIp,
        headers: { 'x-forwarded-for': `10.0.0.${i}, 192.0.2.${i}` },
      });
      expect(res.status).toBe(200);
    }
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const over = await call(login, {
      body: { email, password: STRONG_PASSWORD },
      ip: clientIp,
      headers: { 'x-forwarded-for': '10.9.9.9' },
    });
    expect(over.status).toBe(429);
    expect(over.body).toEqual({ detail: 'Too many requests. Please try again later.' });
    expect(fetchSpy.mock.calls.filter(([url]) => String(url).startsWith(service.publicUrl))).toHaveLength(0);
  });

  it('two layer clients with different IPs land in different buckets', async () => {
    const { email } = await registerUser(nextEmail('buckets'));
    for (let i = 0; i < LEGACY_IP_LIMITS.login.max; i++) {
      await call(login, { body: { email, password: STRONG_PASSWORD }, ip: '198.51.100.31' });
    }
    expect((await call(login, { body: { email, password: STRONG_PASSWORD }, ip: '198.51.100.31' })).status).toBe(429);
    expect((await call(login, { body: { email, password: STRONG_PASSWORD }, ip: '198.51.100.32' })).status).toBe(200);
  });

  it('refresh_token has no per-IP limit: many refreshes from one NAT address all succeed (batch 5, G)', async () => {
    // The released client signs out on ANY non-OK refresh (legacy ApiService.ts
    // refreshAccessToken), so a shared per-IP 429 would sign out a whole NAT.
    const a = await registerUser(nextEmail('nat-a'));
    const b = await registerUser(nextEmail('nat-b'));
    const nat = '198.51.100.50';
    for (let i = 0; i < 80; i++) {
      const res = await call(refreshToken, { body: { refresh_token: (i % 2 ? a : b).refresh }, ip: nat });
      expect(res.status).toBe(200);
    }
    expect(LEGACY_IP_LIMITS).not.toHaveProperty('refresh_token');
  });

  it('every 429 has the legacy shape: the detail and a Retry-After, from apps/api and from apps/auth alike', async () => {
    const raw = async (handler: Handler, body: unknown, ip: string) => {
      const request = new NextRequest('http://localhost/api/v2/x', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-real-ip': ip },
        body: JSON.stringify(body),
      });
      return (handler as (r: NextRequest) => Promise<Response>)(request);
    };
    const legacy429 = async (res: Response) => {
      expect(res.status).toBe(429);
      expect(await res.json()).toEqual({ detail: 'Too many requests. Please try again later.' });
      expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0);
    };
    // apps/api's own per-IP limit.
    const { email } = await registerUser(nextEmail('shape-ip'));
    for (let i = 0; i < LEGACY_IP_LIMITS.login.max; i++) {
      await raw(login, { email, password: STRONG_PASSWORD }, '198.51.100.60');
    }
    await legacy429(await raw(login, { email, password: STRONG_PASSWORD }, '198.51.100.60'));
    // apps/auth's per-email lock, translated by the layer.
    const locked = await registerUser(nextEmail('shape-email'));
    for (let i = 0; i < 5; i++) await call(login, { body: { email: locked.email, password: 'Wrong-Password-1!' } });
    await legacy429(await raw(login, { email: locked.email, password: STRONG_PASSWORD }, '198.51.100.61'));
  });

  it("apps/auth's per-email lock still trips behind the layer, from any number of client IPs", async () => {
    const { email } = await registerUser(nextEmail('email-lock'));
    for (let i = 0; i < 5; i++) {
      expect((await call(login, { body: { email, password: 'Wrong-Password-1!' } })).status).toBe(401);
    }
    expect((await call(login, { body: { email, password: STRONG_PASSWORD } })).status).toBe(429);
  });

  it('direct sign-ins at apps/auth do not spend the layer budget (different services, different keys)', async () => {
    const { email } = await registerUser(nextEmail('direct'));
    const clientIp = '198.51.100.22';
    for (let i = 0; i < LEGACY_IP_LIMITS.login.max * 2; i++) {
      expect((await signIn(service, email, STRONG_PASSWORD, { ip: clientIp })).status).toBe(200);
    }
    expect((await call(login, { body: { email, password: STRONG_PASSWORD }, ip: clientIp })).status).toBe(200);
  });
});

describe('scenario 5: admin/stats through the real route', () => {
  const statsUrl = 'http://localhost/api/v2/admin/stats?days=30&limit=50';

  async function setRole(email: string, role: string) {
    await service.client.query('update auth.users set role = $1 where email = $2', [role, email]);
  }

  it('admin 200, non-admin 403, unauthenticated 401, demoted admin 403 on the next request', async () => {
    const admin = await registerUser(nextEmail('admin'));
    await setRole(admin.email, 'admin');
    const member = await registerUser(nextEmail('member'));

    expect((await call(adminStats, { token: admin.access, url: statsUrl })).status).toBe(200);
    expect((await call(adminStats, { token: member.access, url: statsUrl })).status).toBe(403);
    expect((await call(adminStats, { url: statsUrl })).status).toBe(401);

    await setRole(admin.email, 'user');
    expect((await call(adminStats, { token: admin.access, url: statsUrl })).status).toBe(403);
  });

  it('apps/auth unreachable: 503, never 200', async () => {
    const outage = await startAuth();
    const res = await call(register, { body: { email: nextEmail('outage-admin'), password: STRONG_PASSWORD } });
    const jwt = res.body.access_token as string;
    await outage.client.query("update auth.users set role = 'admin'");
    expect((await call(adminStats, { token: jwt, url: statsUrl })).status).toBe(200);
    await outage.close();

    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect((await call(adminStats, { token: jwt, url: statsUrl })).status).toBe(503);
  });
});

describe('scenario 25: ownership is unchanged on the switched routes', () => {
  it('a user cannot read another user\'s thread', async () => {
    const owner = await registerUser(nextEmail('owner'));
    const other = await registerUser(nextEmail('other'));
    const { rows } = await app.query<{ id: string }>(
      "insert into threads (user_id, name) values ($1, 'private') returning id",
      [await idOf(owner.email)]
    );
    const context = { params: Promise.resolve({ id: rows[0].id }) };
    expect((await call(threadGet as Handler, { token: owner.access }, context)).status).toBe(200);
    expect((await call(threadGet as Handler, { token: other.access }, context)).status).toBe(404);
  });
});

describe('the machine callers, both directions', () => {
  const LEADERBOARD_KEY = 'leaderboard-key-for-the-layer-suite-0123456789';

  beforeEach(() => {
    process.env.LEADERBOARD_API_KEY = LEADERBOARD_KEY;
    resetEnvCache();
  });

  afterEach(() => {
    delete process.env.LEADERBOARD_API_KEY;
    resetEnvCache();
  });

  it('a user JWT on /api/v1/chat/completions gets 401 and is never verified as a JWT', async () => {
    const { access } = await registerUser(nextEmail('machine'));
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const res = await call(chatCompletions, {
      token: access,
      body: { model: 'ansari', messages: [{ role: 'user', content: 'salam' }] },
    });
    expect(res.status).toBe(401);
    expect(fetchSpy.mock.calls.filter(([url]) => String(url).startsWith(service.publicUrl))).toHaveLength(0);
  });

  it('LEADERBOARD_API_KEY on a JWT route gets 401', async () => {
    expect(await call(threadsGet, { token: LEADERBOARD_KEY })).toEqual({
      status: 401,
      body: { detail: 'Invalid or expired token' },
    });
  });

  it('there is no Next.js middleware in front of the routes', () => {
    expect(existsSync(path.resolve(__dirname, '../../src/middleware.ts'))).toBe(false);
    expect(existsSync(path.resolve(__dirname, '../../middleware.ts'))).toBe(false);
  });
});

describe('the revocation window is pinned', () => {
  // A JWT minted just before the cause keeps working until its exp (15 min,
  // I-7) and no longer; the session token can mint no new one at once.
  // Deletion is the exception: the tombstone refuses the JWT at once.
  const LIFETIME_S = 900;

  const causes: [string, (user: { email: string; access: string }) => Promise<void>][] = [
    ['logout through the layer', async ({ access }) => {
      expect((await call(logout, { token: access })).status).toBe(200);
    }],
    ['a password reset', async ({ email }) => {
      await call(requestReset, { body: { email } });
      const mail = await vi.waitFor(() => {
        const sent = service.mail.find((m) => m.to === email);
        if (!sent) throw new Error('no reset mail yet');
        return sent;
      });
      const token = decodeURIComponent(/reset-password\?token=([^"'&<\s]+)/.exec(mail.html)![1]);
      expect((await call(resetPassword, { body: { reset_token: token, new_password: 'Fresh-Lantern-Orchard-4' } })).status).toBe(200);
    }],
    ['a ban (the phase 5 script)', async ({ email }) => {
      await banUserByEmail(service.db, email);
    }],
  ];

  it.each(causes)('%s: no new JWT at once; the issued JWT dies at its exp, within 900 s', async (_name, cause) => {
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() });
    const user = await registerUser(nextEmail('window'));
    const issuedAt = Date.now();
    await cause(user);
    const revokedAt = Date.now();

    expect((await call(refreshToken, { body: { refresh_token: user.refresh } })).status).toBe(401);
    expect((await send(service.publicUrl, '/api/auth/token', { bearer: user.refresh })).status).toBe(401);

    expect((await call(threadsGet, { token: user.access })).status).toBe(200);
    vi.setSystemTime(issuedAt + (LIFETIME_S - 2) * 1000);
    expect((await call(threadsGet, { token: user.access })).status).toBe(200);
    const lastAccepted = Date.now();
    vi.setSystemTime(issuedAt + (LIFETIME_S + 1) * 1000);
    expect((await call(threadsGet, { token: user.access })).status).toBe(401);

    expect((lastAccepted - revokedAt) / 1000).toBeLessThanOrEqual(LIFETIME_S);
  });

  it('deletion: the session mints nothing, and the JWT is refused at once', async () => {
    const user = await registerUser(nextEmail('window-delete'));
    expect((await call(meDelete, { token: user.access })).status).toBe(200);
    expect((await call(refreshToken, { body: { refresh_token: user.refresh } })).status).toBe(401);
    expect(await call(threadsGet, { token: user.access })).toEqual({
      status: 401,
      body: { detail: 'Token not found or expired' },
    });
  });
});

describe('against apps/auth in production mode, behind an edge (its client-IP rule on)', () => {
  // Production apps/auth refuses any router request with no usable client IP.
  // apps/api reaches it over the public domain, so the edge stamps apps/api's
  // egress IP on every call: the JWKS fetch from a cold cache and every layer
  // call. One IP for all of them must be enough (R1).
  let prod: AuthService;
  let edge: Edge;

  beforeAll(async () => {
    prod = await startAuth({ production: true });
    edge = await startEdge(prod.publicUrl);
  });

  afterAll(async () => {
    await edge.stop();
    await prod.close();
    setApiEnv(service.publicUrl);
  });

  it('the whole legacy cycle works, starting from a cold JWKS cache', async () => {
    setApiEnv(edge.url);
    const email = nextEmail('prod');
    const registered = await call(register, { body: { email, password: STRONG_PASSWORD } });
    expect(registered.status).toBe(200);
    expect((await call(threadsGet, { token: registered.body.access_token })).status).toBe(200);

    const loggedIn = await call(login, { body: { email, password: STRONG_PASSWORD } });
    expect(loggedIn.status).toBe(200);
    const refreshed = await call(refreshToken, { body: { refresh_token: loggedIn.body.refresh_token } });
    expect(refreshed.status).toBe(200);
    expect((await call(meGet, { token: refreshed.body.access_token })).body.email).toBe(email);
    expect((await call(logout, { token: refreshed.body.access_token })).status).toBe(200);
    expect((await call(meDelete, { token: registered.body.access_token })).status).toBe(200);
    // Every call apps/auth saw came from apps/api's one IP.
    expect(edge.stamped.length).toBeGreaterThanOrEqual(8);
    expect(new Set(edge.stamped)).toEqual(new Set([API_EGRESS_IP]));
    const { rows } = await prod.client.query<{ key: string }>('select key from auth.rate_limit');
    expect(rows.filter((r) => r.key.includes(API_EGRESS_IP)).map((r) => r.key)).toEqual([`${API_EGRESS_IP}|/jwks`]);
  });
});

describe('every switched route requires a verified JWT', () => {
  // The route set comes from the source, not from a list: every route file
  // that calls requireUser or requireAdmin, and every HTTP method it
  // exports. A handler that skipped its check would answer something else.
  const SRC = path.resolve(__dirname, '../../src/app/api');
  const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
  // Handlers in a guarded file that are public by design. Each must NOT answer
  // 401, so a stale entry fails here instead of hiding a guard.
  const PUBLIC = new Set(['GET v2/share/[id]/route.ts']);

  function routeFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) return routeFiles(full);
      return name === 'route.ts' ? [full] : [];
    });
  }

  const guarded = routeFiles(SRC).filter((f) =>
    /\b(requireUser|requireAdmin)\(request\)/.test(readFileSync(f, 'utf8'))
  );

  it('finds the switched routes', () => {
    expect(guarded.length).toBeGreaterThanOrEqual(12);
  });

  it('every guarded handler answers 401 with no bearer and with a legacy HS256 token', async () => {
    const legacy = await legacyAccessToken('00000000-0000-4000-8000-000000000000');
    const context = { params: Promise.resolve({ id: '00000000-0000-4000-8000-000000000001' }) };
    let checked = 0;
    for (const file of guarded) {
      const mod = (await import(file)) as Record<string, unknown>;
      for (const method of METHODS) {
        const handler = mod[method] as ((r: NextRequest, c: unknown) => Promise<Response>) | undefined;
        if (typeof handler !== 'function') continue;
        for (const token of [undefined, legacy]) {
          const headers: Record<string, string> = { 'x-real-ip': nextIp(), 'content-type': 'application/json' };
          if (token) headers.authorization = `Bearer ${token}`;
          const request = new NextRequest('http://localhost/api/v2/x', {
            method,
            headers,
            body: method === 'GET' ? undefined : '{}',
          });
          const response = await handler(request, context);
          const name = `${method} ${path.relative(SRC, file)}`;
          if (PUBLIC.has(name)) {
            expect(response.status, `${name} is public`).not.toBe(401);
            continue;
          }
          expect(response.status, `${name} (${token ? 'legacy token' : 'no bearer'})`).toBe(401);
          checked += 1;
        }
      }
    }
    expect(checked).toBeGreaterThanOrEqual(2 * 15);
  });
});

// The no-import / no-dependency scan for better-auth and @ansari/auth lives in
// tests/source-scan/ (scan 3).
