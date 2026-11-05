// POST /api/whatsapp/session (spec 329, plan phase 6), over HTTP through
// startService on pglite built from the auth journal. The decision under the
// lock is pinned in packages/auth `tests/whatsapp.test.ts`; this file owns the
// route: the key refusals, the body, the statuses, transport (CORS, method,
// path), the outage mapping, the alerts, and what reaches responses and logs.
// A lock held from another connection and a stopped database need real
// Postgres: scripts/probes/exchange-outage-probe.ts, output in the review.
import { createHash, randomInt } from 'node:crypto';
import { inspect } from 'node:util';

import { createLocalJWKSet, jwtVerify } from 'jose';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { limits, serviceUsers } from '@ansari/auth';

import { TEST_JWT_AUDIENCE, TEST_JWT_ISSUER } from '../../../packages/auth/tests/helpers/auth-db';
import {
  createExchangeAlerts,
  INELIGIBLE_USER_MESSAGE,
  scrubRequestEvent,
  type ExchangeAlert,
} from '../src/alerts';
import { createApp } from '../src/app';
import { exchangeLimitKey, WHATSAPP_SESSION_PATH } from '../src/routes/whatsapp';
import { BASE, rateLimitRow, send, signUpTokens, startService, type Service } from './helpers/service';

const WHATSAPP = { whatsapp: ['mint'] };

/** The plugin's key hash: SHA-256, base64url (packages/auth's probe 1 pins it to defaultKeyHasher). */
const keyHash = (raw: string) => createHash('sha256').update(raw).digest('base64url');

/** Every console line written while this file runs, for the log-capture assertions at the end. */
const logged: unknown[][] = [];
const consoleSpies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) =>
  vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
    logged.push(args);
  })
);

/** Every value that must never reach a response or a log: raw keys, BSUIDs, phone numbers, bodies. */
const secrets = new Set<string>();
const remember = <T extends string>(value: T): T => {
  secrets.add(value);
  return value;
};

const digits = (n: number) => Array.from({ length: n }, () => randomInt(10)).join('');
const newBsuid = () => remember(`US.${digits(20)}`);
const newPhone = () => remember(`1${digits(11)}`);

class Clock {
  at = Date.now();
  now = () => this.at;
  advance(ms: number) {
    this.at += ms;
  }
}

const clock = new Clock();
const alerts: ExchangeAlert[] = [];
const alertsOf = (kind: ExchangeAlert['kind']) => alerts.filter((a) => a.kind === kind);

let service: Service;
let serviceUserId: string;
let key: string;

/** A fresh exchange-alert window, so one test's counts never reach the next. */
const nextAlertWindow = () => clock.advance(limits.EXCHANGE_ALERT_WINDOW * 1000);

function startExchangeService(): Promise<Service> {
  return startService({
    exchange: {
      alerts: createExchangeAlerts({ send: (alert) => alerts.push(alert), now: clock.now }),
      now: clock.now,
    },
  });
}

beforeAll(async () => {
  service = await startExchangeService();
  serviceUserId = (await serviceUsers.createServiceUser(service.db, 'whatsapp')).id;
  key = await createKey();
});

afterAll(async () => {
  await service?.close();
  for (const spy of consoleSpies) spy.mockRestore();
});

type KeyBody = Record<string, unknown>;

/** A key created in process, as the service-keys script does, owned by `userId`. */
async function createKey(body: KeyBody = {}, on: Service = service, userId = serviceUserId) {
  const created = await on.auth.api.createApiKey({
    body: { userId, prefix: 'ansari_wa_', name: 'test', permissions: WHATSAPP, rateLimitEnabled: false, ...body },
  });
  remember(keyHash(created.key));
  return remember(created.key);
}

type PostOptions = {
  bearer?: string | null;
  authorization?: string;
  contentType?: string | null;
  headers?: Record<string, string>;
  method?: string;
  path?: string;
  on?: Service;
};

type Exchanged = { status: number; text: string; headers: Headers };

/**
 * A raw request to the exchange. Every response is checked for the request's
 * sensitive values (the bearer, the raw body and each value in it).
 */
async function post(body: unknown, opts: PostOptions = {}): Promise<Exchanged> {
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  const headers: Record<string, string> = { ...opts.headers };
  const bearer = opts.bearer === undefined ? key : opts.bearer;
  if (opts.authorization !== undefined) headers.authorization = opts.authorization;
  else if (bearer !== null) headers.authorization = `Bearer ${bearer}`;
  if (opts.contentType !== null) headers['content-type'] = opts.contentType ?? 'application/json';
  const res = await fetch(`${(opts.on ?? service).publicUrl}${opts.path ?? WHATSAPP_SESSION_PATH}`, {
    method: opts.method ?? 'POST',
    headers,
    body: raw,
  });
  const text = await res.text();
  const sensitive = [raw, ...(bearer ? [bearer] : [])];
  if (body && typeof body === 'object') {
    sensitive.push(...Object.values(body).filter((v): v is string => typeof v === 'string' && v.length > 2));
  }
  for (const value of sensitive) if (value.length > 2) expect(text).not.toContain(value);
  return { status: res.status, text, headers: res.headers };
}

async function exchange(bsuid = newBsuid(), phone?: string, opts: PostOptions = {}) {
  return post(phone === undefined ? { bsuid } : { bsuid, phone_number: phone }, opts);
}

async function tokenOf(res: Exchanged): Promise<string> {
  expect(res.status, res.text).toBe(200);
  return (JSON.parse(res.text) as { token: string }).token;
}

async function claims(token: string, on: Service = service) {
  const { payload } = await jwtVerify(token, createLocalJWKSet(await on.auth.api.getJwks()), {
    issuer: TEST_JWT_ISSUER,
    audience: TEST_JWT_AUDIENCE,
  });
  return payload as { sub: string; sid: string };
}

async function scalar(sql: string, params: unknown[] = [], on: Service = service): Promise<number> {
  const { rows } = await on.client.query<{ n: number }>(sql, params);
  return Number(rows[0]?.n ?? 0);
}

async function rowCounts(on: Service = service) {
  return {
    users: await scalar('select count(*)::int as n from auth.users', [], on),
    accounts: await scalar('select count(*)::int as n from auth.account', [], on),
    sessions: await scalar('select count(*)::int as n from auth.session', [], on),
  };
}

const sessionCount = (userId: string) =>
  scalar('select count(*)::int as n from auth.session where user_id = $1', [userId]);

const whatsappUserOf = async (bsuid: string) => {
  const { rows } = await service.client.query<{ user_id: string }>(
    `select user_id from auth.account where provider_id = 'whatsapp' and account_id = $1`,
    [bsuid]
  );
  return rows[0]?.user_id;
};

const UNAUTHORIZED = '{"message":"Unauthorized"}';
const INVALID = '{"message":"Invalid request"}';
const INTERNAL = '{"message":"Internal error"}';

describe('key refusals: one byte-identical 401, no rows', () => {
  async function seededKey(sql: string, body: KeyBody = {}) {
    const raw = await createKey(body);
    const hash = keyHash(raw);
    await service.client.query(sql, [hash]);
    return raw;
  }

  const cases: [string, () => Promise<PostOptions>][] = [
    ['no Authorization header', async () => ({ bearer: null })],
    ['a non-Bearer scheme', async () => ({ authorization: `Basic ${key}` })],
    ['an empty bearer', async () => ({ authorization: 'Bearer ' })],
    ['a session token', async () => ({ bearer: remember((await signUpTokens(service, 'wa-session@example.com')).sessionToken) })],
    ['a JWT', async () => ({ bearer: (await signUpTokens(service, 'wa-jwt@example.com')).jwt })],
    ['an unknown key', async () => ({ bearer: remember(`ansari_wa_${'A'.repeat(64)}`) })],
    ['a disabled key', async () => ({ bearer: await seededKey('update auth.apikey set enabled = false where key = $1') })],
    ['an expired key', async () => ({ bearer: await seededKey(`update auth.apikey set expires_at = now() - interval '1 minute' where key = $1`) })],
    [
      'an exhausted key (refilled daily)',
      async () => ({
        bearer: await seededKey('update auth.apikey set remaining = 0, last_refill_at = now() where key = $1', {
          remaining: 5,
          refillAmount: 5,
          refillInterval: limits.KEY_REFILL_INTERVAL,
        }),
      }),
    ],
    [
      'a rate-limited key',
      async () => ({
        bearer: await seededKey('update auth.apikey set request_count = 1, last_request = now() where key = $1', {
          rateLimitEnabled: true,
          rateLimitMax: 1,
          rateLimitTimeWindow: 60_000,
        }),
      }),
    ],
    ['a key with mcp: complete only', async () => ({ bearer: await createKey({ permissions: { mcp: ['complete'] } }) })],
    ['a key with no permissions', async () => ({ bearer: await seededKey('update auth.apikey set permissions = null where key = $1') })],
    [
      "another service's whatsapp: mint key",
      async () => {
        const other = await serviceUsers.createServiceUser(service.db, 'ansari-mcp');
        return { bearer: await createKey({}, service, other.id) };
      },
    ],
  ];

  it.each(cases)('%s → 401, and no user, account or session is created', async (_name, options) => {
    const opts = await options();
    const before = await rowCounts();
    const res = await exchange(newBsuid(), newPhone(), opts);
    expect(res.status).toBe(401);
    expect(res.text).toBe(UNAUTHORIZED);
    expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(res.headers.get('content-length')).toBe(String(UNAUTHORIZED.length));
    expect(await rowCounts()).toEqual(before);
  });

  it('USAGE_EXCEEDED and RATE_LIMITED each raised one alert in the window, however many refusals', () => {
    const refused = alertsOf('key-refused');
    expect(refused.map((a) => a.kind === 'key-refused' && a.code).sort()).toEqual(['RATE_LIMITED', 'USAGE_EXCEEDED']);
  });

  it('a missing or malformed bearer is answered without touching the database', async () => {
    // Past the relation-check window, so a check run here would be a query.
    clock.advance(limits.APIKEY_RELATION_CHECK_TTL);
    const methods = ['query', 'exec', 'transaction', 'sql'] as const;
    const spies = methods.map((m) => vi.spyOn(service.client, m));
    try {
      for (const authorization of [undefined, 'Basic abc', 'Bearer ', 'Bearer a b', 'bearer']) {
        const res = await post({ bsuid: newBsuid() }, authorization === undefined ? { bearer: null } : { authorization });
        expect(res.status).toBe(401);
      }
      expect(spies.map((s) => s.mock.calls.length)).toEqual([0, 0, 0, 0]);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });

  it('a body sent with no key is never parsed', async () => {
    const marker = remember(`{"bsuid":"never-parsed-${digits(8)}"`);
    const parse = vi.spyOn(JSON, 'parse');
    try {
      const res = await post(`${marker}}`, { bearer: null });
      expect(res.status).toBe(401);
      expect(parse.mock.calls.some(([text]) => typeof text === 'string' && text.includes(marker))).toBe(false);
    } finally {
      parse.mockRestore();
    }
  });
});

describe('the exchange', () => {
  it('a new BSUID → 200 with a JWT for a new WhatsApp user and its one session', async () => {
    const bsuid = newBsuid();
    const before = await rowCounts();
    const { sub, sid } = await claims(await tokenOf(await exchange(bsuid, newPhone())));
    expect(await whatsappUserOf(bsuid)).toBe(sub);
    expect(await rowCounts()).toEqual({
      users: before.users + 1,
      accounts: before.accounts + 1,
      sessions: before.sessions + 1,
    });
    expect(await scalar('select count(*)::int as n from auth.session where id = $1 and user_id = $2', [sid, sub])).toBe(1);
  });

  it('the same BSUID twice → the same sub and sid, one session', async () => {
    const bsuid = newBsuid();
    const first = await claims(await tokenOf(await exchange(bsuid)));
    const second = await claims(await tokenOf(await exchange(bsuid)));
    expect(second).toMatchObject({ sub: first.sub, sid: first.sid });
    expect(await sessionCount(first.sub)).toBe(1);
  });

  it('the token passes GET /api/account/me, which never returns the phone number', async () => {
    const phone = newPhone();
    const token = await tokenOf(await exchange(newBsuid(), phone));
    const me = await send(service.publicUrl, '/api/account/me', { bearer: token });
    expect(me.status).toBe(200);
    const text = await me.text();
    expect(JSON.parse(text)).toMatchObject({ registered_via: 'whatsapp', role: 'user', banned: false });
    expect(text).not.toContain(phone);
  });

  it.each([
    ['lower case', 'us.13491208655302741918'],
    ["Meta's parent form", 'US.ENT.13491208655302741918'],
    ['punctuation', 'x_y-z.1:2/3+4=5'],
    ['256 characters', 'A'.repeat(256)],
  ])('a sane but unusual BSUID (%s) is accepted', async (_name, bsuid) => {
    remember(bsuid);
    expect((await exchange(bsuid)).status).toBe(200);
  });

  it.each(['bearer', 'BEARER', 'BeArEr'])('the %s scheme is the Bearer scheme (RFC 7235: case-insensitive)', async (scheme) => {
    const res = await post({ bsuid: newBsuid() }, { authorization: `${scheme} ${key}` });
    expect(res.status, res.text).toBe(200);
  });

  /** Every row of every table in the auth schema, as JSON text, for a needle scan. */
  async function authRowsText(): Promise<string> {
    const { rows: tables } = await service.client.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'auth' ORDER BY table_name`
    );
    expect(tables.length).toBeGreaterThan(5);
    const parts: string[] = [];
    for (const { table_name } of tables) {
      const { rows } = await service.client.query<{ row: unknown }>(`SELECT row_to_json(t) AS row FROM auth."${table_name}" t`);
      parts.push(JSON.stringify(rows));
    }
    return parts.join('\n');
  }

  // Spec 329 §5, owner amendment 2: phone_number is accepted in any shape and ignored.
  // Each shape returns the value sent and the needle that must appear in no row.
  it.each([
    ['digits', () => { const v = remember(`1${digits(11)}`); return [v, v] as const; }],
    ['a leading +', () => { const v = remember(`+${digits(12)}`); return [v, v] as const; }],
    ['a JSON number', () => { const n = remember(`7${digits(10)}`); return [Number(n), n] as const; }],
    ['a nested object', () => { const n = remember(`5${digits(11)}`); return [{ e164: n, country: 'US' }, n] as const; }],
    ['null', () => [null, null] as const],
    ['an empty string', () => ['', null] as const],
    ['33 characters', () => { const v = remember(`9${digits(32)}`); return [v, v] as const; }],
    ['letters and spaces', () => { const v = remember(`abc ${digits(8)} xyz`); return [v, v] as const; }],
  ] as const)('phone_number as %s → 200, and the number is in no auth row', async (_name, make) => {
    const [value, needle] = make();
    const bsuid = newBsuid();
    const res = await post({ bsuid, phone_number: value });
    expect(res.status, res.text).toBe(200);
    const rows = await authRowsText();
    expect(rows).toContain(bsuid); // the scan sees this exchange's own writes
    if (needle !== null) expect(rows).not.toContain(needle);
    expect(res.text).not.toContain('phone');
  });

  it('a maximal valid body (a 256-character BSUID and a long phone_number) → 200, the number in no row', async () => {
    const bsuid = remember(`M.${'7'.repeat(254)}`);
    const number = remember(`3${digits(500)}`);
    const body = JSON.stringify({ bsuid, phone_number: number });
    expect(Buffer.byteLength(body)).toBeLessThan(limits.EXCHANGE_BODY_LIMIT);
    const res = await post(body);
    expect(res.status, res.text).toBe(200);
    const rows = await authRowsText();
    expect(rows).toContain(bsuid);
    expect(rows).not.toContain(number);
  });
});

describe('delegation inputs are just unknown BSUIDs', () => {
  it("an admin's and an email user's id and email, and a google user's account_id, each create a new WhatsApp user", async () => {
    const admin = await signUpTokens(service, 'wa-admin@example.com');
    await service.client.query(`update auth.users set role = 'admin' where id = $1`, [admin.id]);
    const member = await signUpTokens(service, 'wa-member@example.com');
    const googleId = remember(`g-${digits(21)}`);
    await service.client.query(
      `insert into auth.account (account_id, provider_id, user_id, updated_at) values ($1, 'google', $2, now())`,
      [googleId, member.id]
    );
    const seeded = [admin.id, member.id];
    for (const input of [admin.id, 'wa-admin@example.com', member.id, 'wa-member@example.com', googleId]) {
      const { sub } = await claims(await tokenOf(await exchange(input)));
      expect(seeded).not.toContain(sub);
      expect(await whatsappUserOf(input)).toBe(sub);
    }
    for (const id of seeded) {
      expect(await scalar(`select count(*)::int as n from auth.account where user_id = $1 and provider_id = 'whatsapp'`, [id])).toBe(0);
    }
  });
});

describe('bans', () => {
  it('a banned user → 403, every session deleted, and a JWT issued before the ban fails /api/account/me', async () => {
    const bsuid = newBsuid();
    const token = await tokenOf(await exchange(bsuid));
    const { sub } = await claims(token);
    expect((await send(service.publicUrl, '/api/account/me', { bearer: token })).status).toBe(200);
    await service.client.query(`update auth.users set banned = true where id = $1`, [sub]);

    const res = await exchange(bsuid);
    expect(res.status).toBe(403);
    expect(res.text).toBe('{"message":"Forbidden"}');
    expect(await sessionCount(sub)).toBe(0);
    expect((await send(service.publicUrl, '/api/account/me', { bearer: token })).status).toBe(401);
  });

  it('an expired ban is let through', async () => {
    const bsuid = newBsuid();
    const { sub } = await claims(await tokenOf(await exchange(bsuid)));
    await service.client.query(
      `update auth.users set banned = true, ban_expires = now() - interval '1 minute' where id = $1`,
      [sub]
    );
    expect((await exchange(bsuid)).status).toBe(200);
  });
});

describe('the per-user budget', () => {
  const { max } = limits.WHATSAPP_EXCHANGE_PER_USER;
  const countOf = async (userId: string) => (await rateLimitRow(service, exchangeLimitKey(userId)))?.count ?? 0;

  it('is keyed by the user id, never the BSUID or the phone number', async () => {
    const bsuid = newBsuid();
    const phone = newPhone();
    const { sub } = await claims(await tokenOf(await exchange(bsuid, phone)));
    const { rows } = await service.client.query<{ key: string }>('select key from auth.rate_limit');
    const keys = rows.map((r) => r.key);
    expect(keys).toContain(`sub:${sub}|/api/whatsapp/session`);
    for (const k of keys) {
      expect(k).not.toContain(bsuid);
      expect(k).not.toContain(phone);
    }
  });

  it(`answers 429 with an integer X-Retry-After after ${max}, and another user under the same key is unaffected`, async () => {
    const bsuid = newBsuid();
    for (let i = 0; i < max; i++) expect((await exchange(bsuid)).status).toBe(200);
    const res = await exchange(bsuid);
    expect(res.status).toBe(429);
    expect(res.text).toBe('{"message":"Too many requests"}');
    const retryAfter = res.headers.get('x-retry-after') ?? '';
    expect(retryAfter).toMatch(/^[1-9][0-9]*$/);
    expect(Number(retryAfter)).toBeLessThanOrEqual(limits.WHATSAPP_EXCHANGE_PER_USER.window);
    expect((await exchange(newBsuid())).status).toBe(200);
  });

  it('the counter survives a 403 (banned)', async () => {
    const bsuid = newBsuid();
    const { sub } = await claims(await tokenOf(await exchange(bsuid)));
    await service.client.query(`update auth.users set banned = true where id = $1`, [sub]);
    const before = await countOf(sub);
    expect((await exchange(bsuid)).status).toBe(403);
    expect(await countOf(sub)).toBe(before + 1);
  });

  it('the counter survives a 500 (ineligible)', async () => {
    const bsuid = newBsuid();
    const { sub } = await claims(await tokenOf(await exchange(bsuid)));
    await service.client.query(`update auth.users set registered_via = 'web' where id = $1`, [sub]);
    const before = await countOf(sub);
    expect((await exchange(bsuid)).status).toBe(500);
    expect(await countOf(sub)).toBe(before + 1);
  });
});

describe('failures that are not 401', () => {
  it('an ineligible user → 500, one count-only alert per window, and a server warning with the user id', async () => {
    nextAlertWindow();
    const sent = alertsOf('ineligible-user').length;
    const subs: string[] = [];
    for (const repair of [
      `update auth.users set role = 'admin' where id = $1`,
      `update auth.users set email = 'someone-else@noreply.askansari.ai' where id = $1`,
      `insert into auth.account (account_id, provider_id, user_id, updated_at) values ('x', 'credential', $1, now())`,
    ]) {
      const bsuid = newBsuid();
      const { sub } = await claims(await tokenOf(await exchange(bsuid)));
      await service.client.query(repair, [sub]);
      const res = await exchange(bsuid);
      expect(res.status).toBe(500);
      expect(res.text).toBe(INTERNAL);
      subs.push(sub);
    }
    const fired = alertsOf('ineligible-user').slice(sent);
    expect(fired).toEqual([{ kind: 'ineligible-user', windowSeconds: limits.EXCHANGE_ALERT_WINDOW }]);
    for (const sub of subs) {
      expect(logged.some(([message, meta]) => message === INELIGIBLE_USER_MESSAGE && (meta as { userId?: string })?.userId === sub)).toBe(true);
    }
  });

  it('the user deleted between resolve and lock → 500, and no session row', async () => {
    // A trigger on the per-user budget's row, which is written after the
    // user is resolved and before the lock, deletes the user in between.
    await service.client.exec(`
      create function auth.delete_exchange_user() returns trigger language plpgsql as $$
      begin
        delete from auth.users where id = split_part(substr(new.key, 5), '|', 1)::uuid;
        return new;
      end $$;
      create trigger delete_exchange_user after insert on auth.rate_limit for each row
        when (new.key like 'sub:%|/api/whatsapp/session') execute function auth.delete_exchange_user();
    `);
    try {
      const bsuid = newBsuid();
      const before = await scalar('select count(*)::int as n from auth.session');
      const res = await exchange(bsuid);
      expect(res.status).toBe(500);
      expect(res.text).toBe(INTERNAL);
      expect(await whatsappUserOf(bsuid)).toBeUndefined();
      expect(await scalar('select count(*)::int as n from auth.session')).toBe(before);
    } finally {
      await service.client.exec(`
        drop trigger delete_exchange_user on auth.rate_limit;
        drop function auth.delete_exchange_user();
      `);
    }
  });

  it('the WhatsApp service user missing → 500 and one alert per window', async () => {
    const lone = await startExchangeService();
    try {
      nextAlertWindow();
      const sent = alertsOf('service-user-unresolvable').length;
      const owner = await serviceUsers.createServiceUser(lone.db, 'whatsapp');
      const raw = await createKey({}, lone, owner.id);
      await lone.client.query(`delete from auth.account where user_id = $1`, [owner.id]);
      for (let i = 0; i < 3; i++) {
        const res = await exchange(newBsuid(), undefined, { bearer: raw, on: lone });
        expect(res.status).toBe(500);
        expect(res.text).toBe(INTERNAL);
      }
      expect(alertsOf('service-user-unresolvable').slice(sent)).toEqual([
        { kind: 'service-user-unresolvable', serviceUsers: 0, windowSeconds: limits.EXCHANGE_ALERT_WINDOW },
      ]);
      expect(await scalar(`select count(*)::int as n from auth.account where provider_id = 'whatsapp'`, [], lone)).toBe(0);
    } finally {
      await lone.close();
    }
  });

  it('auth.apikey dropped under the running service → 500 for a valid and an unknown key once the check window has passed', async () => {
    const outage = await startExchangeService();
    try {
      const owner = await serviceUsers.createServiceUser(outage.db, 'whatsapp');
      const raw = await createKey({}, outage, owner.id);
      const unknown = `ansari_wa_${'B'.repeat(64)}`;
      // An unknown key while the relation is there: 401, and the check is cached.
      expect((await exchange(newBsuid(), undefined, { bearer: unknown, on: outage })).status).toBe(401);
      await outage.client.exec('drop table auth.apikey');
      // Inside the window, the stated residual: still 401.
      expect((await exchange(newBsuid(), undefined, { bearer: unknown, on: outage })).status).toBe(401);
      clock.advance(limits.APIKEY_RELATION_CHECK_TTL);
      for (const bearer of [raw, unknown]) {
        const res = await exchange(newBsuid(), undefined, { bearer, on: outage });
        expect(res.status).toBe(500);
        expect(res.text).toBe(INTERNAL);
      }
    } finally {
      await outage.close();
    }
  });
});

describe('the body (after a valid key)', () => {
  const longBsuid = 'A'.repeat(257);
  const cases: [string, string, string | null][] = [
    ['malformed JSON', '{"bsuid":', 'application/json'],
    ['a text/plain body', JSON.stringify({ bsuid: 'US.1' }), 'text/plain'],
    ['no Content-Type', JSON.stringify({ bsuid: 'US.1' }), null],
    ['over the byte limit', JSON.stringify({ bsuid: 'US.1', pad: 'x'.repeat(limits.EXCHANGE_BODY_LIMIT) }), 'application/json'],
    ['a JSON string', '"US.1"', 'application/json'],
    ['a JSON array', '["US.1"]', 'application/json'],
    ['bsuid missing', '{}', 'application/json'],
    ['bsuid not a string', '{"bsuid":12345}', 'application/json'],
    ['bsuid empty', '{"bsuid":""}', 'application/json'],
    ['bsuid over 256 characters', JSON.stringify({ bsuid: longBsuid }), 'application/json'],
    ['bsuid with a space', '{"bsuid":"US. 123"}', 'application/json'],
    ['bsuid with a tab', '{"bsuid":"US.\\t123"}', 'application/json'],
    ['bsuid with a control character', '{"bsuid":"US.\\u0001123"}', 'application/json'],
    ['bsuid with a zero-width space', '{"bsuid":"US.\\u200b123"}', 'application/json'],
    ['bsuid with a bidi override', '{"bsuid":"US.\\u202e123"}', 'application/json'],
    ['bsuid with a zero-width joiner', '{"bsuid":"US.\\u200d123"}', 'application/json'],
  ];

  it.each(cases)('%s → the exact 400, no HTML, no body fragment', async (_name, body, contentType) => {
    const before = await rowCounts();
    const res = await post(body, { contentType });
    expect(res.status).toBe(400);
    expect(res.text).toBe(INVALID);
    expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(await rowCounts()).toEqual(before);
  });
});

describe('transport', () => {
  const ORIGINS: [string, string | undefined][] = [
    ['the configured CORS_ORIGIN', BASE],
    ['null', 'null'],
    ['https://evil.example', 'https://evil.example'],
    ['no Origin', undefined],
  ];
  const noCors = (headers: Headers) => [...headers.keys()].filter((h) => h.startsWith('access-control-'));

  it.each(ORIGINS)('no Access-Control-* header on POST or OPTIONS (%s)', async (_name, origin) => {
    const originHeader: Record<string, string> = origin ? { origin } : {};
    const res = await exchange(newBsuid(), undefined, { headers: originHeader });
    expect(res.status).toBe(200);
    expect(noCors(res.headers)).toEqual([]);
    const refused = await exchange(newBsuid(), undefined, { headers: originHeader, bearer: null });
    expect(noCors(refused.headers)).toEqual([]);
    const preflight = await fetch(`${service.publicUrl}${WHATSAPP_SESSION_PATH}`, {
      method: 'OPTIONS',
      headers: { ...originHeader, 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization,content-type' },
    });
    expect(preflight.status).toBe(404);
    expect(noCors(preflight.headers)).toEqual([]);
  });

  it.each(['GET', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'])('%s → 404 with an empty body and no Access-Control-* header', async (method) => {
    const res = await fetch(`${service.publicUrl}${WHATSAPP_SESSION_PATH}`, {
      method,
      headers: { origin: BASE, authorization: `Bearer ${key}` },
    });
    expect(res.status).toBe(404);
    expect(await res.text()).toBe('');
    expect(noCors(res.headers)).toEqual([]);
  });

  it('a sub-path → 404 with no Access-Control-* header', async () => {
    const res = await exchange(newBsuid(), undefined, { path: `${WHATSAPP_SESSION_PATH}/extra`, headers: { origin: BASE } });
    expect(res.status).toBe(404);
    expect(noCors(res.headers)).toEqual([]);
  });

  it('the exchange is mounted before corsFor', () => {
    const app = createApp({ auth: service.auth, db: service.db });
    type Layer = { name: string; matchers: ((path: string) => unknown)[] };
    const stack = (app as unknown as { router: { stack: Layer[] } }).router.stack;
    const exchangeAt = stack.findIndex((l) => l.name === 'router' && l.matchers.some((m) => m(WHATSAPP_SESSION_PATH)));
    const corsAt = stack.findIndex((l) => l.name === 'corsMiddleware');
    expect(exchangeAt).toBeGreaterThanOrEqual(0);
    expect(corsAt).toBeGreaterThan(exchangeAt);
  });

  it('is not reachable under /api/auth/*', async () => {
    const before = await rowCounts();
    for (const path of ['/api/auth/whatsapp/session', '/api/auth/api/whatsapp/session']) {
      const res = await exchange(newBsuid(), undefined, { path, headers: { 'x-real-ip': '198.51.100.7', origin: BASE } });
      expect(res.status).toBe(404);
    }
    expect(await rowCounts()).toEqual(before);
  });
});

describe('alerts', () => {
  it('per-key window volume: one alert at WHATSAPP_EXCHANGE_KEY_ALERT, counts and the key id only', async () => {
    const id = (await service.auth.api.createApiKey({
      body: {
        userId: serviceUserId,
        prefix: 'ansari_wa_',
        name: 'volume',
        permissions: WHATSAPP,
        rateLimitEnabled: true,
        rateLimitMax: 100,
        rateLimitTimeWindow: 60_000,
      },
    }));
    remember(id.key);
    const sent = alertsOf('key-window-volume').length;
    // `{}` is a 400 after the key verifies: each one counts against the key.
    for (let i = 0; i < limits.WHATSAPP_EXCHANGE_KEY_ALERT + 5; i++) {
      expect((await post({}, { bearer: id.key })).status).toBe(400);
    }
    expect(alertsOf('key-window-volume').slice(sent)).toEqual([
      {
        kind: 'key-window-volume',
        keyId: id.id,
        requests: limits.WHATSAPP_EXCHANGE_KEY_ALERT,
        windowSeconds: 60,
        threshold: limits.WHATSAPP_EXCHANGE_KEY_ALERT,
      },
    ]);
  });

  it('per-key daily volume: one alert at WHATSAPP_EXCHANGE_DAILY_ALERT since the refill', async () => {
    const created = await service.auth.api.createApiKey({
      body: {
        userId: serviceUserId,
        prefix: 'ansari_wa_',
        name: 'daily',
        permissions: WHATSAPP,
        rateLimitEnabled: false,
        remaining: 3000,
        refillAmount: 3000,
        refillInterval: limits.KEY_REFILL_INTERVAL,
      },
    });
    remember(created.key);
    await service.client.query(`update auth.apikey set remaining = $1, last_refill_at = now() where id = $2`, [
      3000 - (limits.WHATSAPP_EXCHANGE_DAILY_ALERT - 1),
      created.id,
    ]);
    const sent = alertsOf('key-daily-volume').length;
    for (let i = 0; i < 3; i++) expect((await post({}, { bearer: created.key })).status).toBe(400);
    expect(alertsOf('key-daily-volume').slice(sent)).toEqual([
      {
        kind: 'key-daily-volume',
        keyId: created.id,
        requests: limits.WHATSAPP_EXCHANGE_DAILY_ALERT,
        threshold: limits.WHATSAPP_EXCHANGE_DAILY_ALERT,
      },
    ]);
  });

  it('401 volume: one alert per window at EXCHANGE_UNAUTHORIZED_ALERT, and again in the next window', async () => {
    const { max } = limits.EXCHANGE_UNAUTHORIZED_ALERT;
    for (let round = 0; round < 2; round++) {
      nextAlertWindow();
      const sent = alertsOf('unauthorized-volume').length;
      for (let i = 0; i < max + 5; i++) expect((await post({}, { bearer: null })).status).toBe(401);
      expect(alertsOf('unauthorized-volume').slice(sent)).toEqual([
        { kind: 'unauthorized-volume', windowSeconds: limits.EXCHANGE_ALERT_WINDOW, threshold: max },
      ]);
    }
  });

  it('every alert carries numbers, its kind, a refusal code or a key id, and nothing else', () => {
    expect(alerts.length).toBeGreaterThan(0);
    for (const alert of alerts) {
      for (const [field, value] of Object.entries(alert)) {
        if (field === 'kind') continue;
        if (field === 'keyId') expect(value).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
        else if (field === 'code') expect(['USAGE_EXCEEDED', 'RATE_LIMITED']).toContain(value);
        else expect(typeof value, field).toBe('number');
      }
    }
  });
});

describe('the per-key daily alert across a day (fake clock)', () => {
  it("fires once per refill period from the key row's counts, however the requests spread over hours", () => {
    const sent: ExchangeAlert[] = [];
    const day = new Clock();
    const tracker = createExchangeAlerts({ send: (a) => sent.push(a), now: day.now });
    const refilledAt = new Date(day.at).toISOString();
    const usage = (used: number, lastRefillAt: string) => ({
      id: 'key-1',
      requestCount: 1,
      rateLimitTimeWindow: 60_000,
      remaining: 3000 - used,
      refillAmount: 3000,
      lastRefillAt,
      createdAt: refilledAt,
    });
    // A day's verifies, one every 30 minutes, the count growing past the threshold.
    const step = Math.ceil(limits.WHATSAPP_EXCHANGE_DAILY_ALERT / 40);
    for (let i = 1; i <= 48; i++) {
      day.advance(30 * 60_000);
      tracker.keyVerified(usage(i * step, refilledAt));
    }
    expect(sent.filter((a) => a.kind === 'key-daily-volume')).toHaveLength(1);
    // The next refill period starts a new count and may fire again.
    const nextRefill = new Date(day.at).toISOString();
    tracker.keyVerified(usage(limits.WHATSAPP_EXCHANGE_DAILY_ALERT, nextRefill));
    tracker.keyVerified(usage(limits.WHATSAPP_EXCHANGE_DAILY_ALERT + 1, nextRefill));
    expect(sent.filter((a) => a.kind === 'key-daily-volume')).toHaveLength(2);
  });
});

describe('the Sentry scrub', () => {
  it('an event from the exchange keeps the method, path and safe headers only', () => {
    const scrubbed = scrubRequestEvent({
      message: 'x',
      request: {
        method: 'POST',
        url: `https://auth.example${WHATSAPP_SESSION_PATH}?a=1`,
        headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        data: '{"bsuid":"US.1","phone_number":"15551234567"}',
        query_string: 'a=1',
        cookies: { a: 'b' },
      },
    });
    expect(scrubbed.request).toEqual({
      method: 'POST',
      url: `https://auth.example${WHATSAPP_SESSION_PATH}`,
      headers: { 'content-type': 'application/json' },
    });
  });

  // Since #334 the scrub is unconditional: every path, not only the exchange.
  it('an event from another path is scrubbed the same way', () => {
    const request = {
      method: 'GET',
      url: 'https://auth.example/api/account/me?x=1',
      headers: { authorization: 'Bearer a.jwt.here', cookie: 'c=1', 'user-agent': 'ua' },
      data: '{"email":"a@example.com"}',
    };
    expect(scrubRequestEvent({ request: { ...request } }).request).toEqual({
      method: 'GET',
      url: 'https://auth.example/api/account/me',
      headers: { 'user-agent': 'ua' },
    });
  });
});

describe('logs (every case above)', () => {
  it('carry no raw key, key hash, session token, BSUID, phone number or driver error object', async () => {
    const { rows: sessions } = await service.client.query<{ token: string }>('select token from auth.session');
    const { rows: keys } = await service.client.query<{ key: string }>('select key from auth.apikey');
    const needles = [...secrets, ...sessions.map((s) => s.token), ...keys.map((k) => k.key)];
    expect(logged.length).toBeGreaterThan(0);
    const text = logged.map((args) => args.map((a) => inspect(a, { depth: 8 })).join(' ')).join('\n');
    for (const needle of needles) expect(text).not.toContain(needle);
    for (const args of logged) for (const arg of args) expect(arg).not.toBeInstanceOf(Error);
  });
});
