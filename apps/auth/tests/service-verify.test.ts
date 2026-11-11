// POST /api/service/verify-key (#314, plan phase 2), over HTTP through
// startService on pglite built from the auth journal, with the real api-key
// plugin. Keys are made through the service-keys script's own path
// (parseArgs → runServiceKeys), except the ones the script refuses to make,
// which are created in process the way a key made outside the script would be.
// Spec 314's apps/auth scenarios 1–10, 12, 13 and 15 are here; 11 is in
// blocked-paths.test.ts, 14 in service-keys.test.ts, and the Sentry leg of 12
// in service-verify-sentry.test.ts.
import { inspect } from 'node:util';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { limits, serviceUsers } from '@ansari/auth';

import { createMcpVerifyAlerts, EXCHANGE_ALERT_MESSAGE, MCP_VERIFY_ALERT_MESSAGE, type McpVerifyAlert } from '../src/alerts';
import { createApp } from '../src/app';
import { SERVICE_VERIFY_PATH } from '../src/routes/service-verify';
import { WHATSAPP_SESSION_PATH } from '../src/routes/whatsapp';
import { parseArgs, runServiceKeys } from '../scripts/service-keys';
import { keyWindows, leakedWindows } from './helpers/leak-scan';
import { BASE, signUpTokens, startService, type Service } from './helpers/service';

const MCP = { mcp: ['complete'] };

/** Every console line written while this file runs, for the leak scan at the end. */
const logged: unknown[][] = [];
const consoleSpies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) =>
  vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
    logged.push(args);
  })
);

/** Every raw key this file made: none may reach a response or a log. */
const rawKeys = new Set<string>();
const remember = (key: string) => {
  rawKeys.add(key);
  return key;
};

class Clock {
  at = Date.now();
  now = () => this.at;
  advance(ms: number) {
    this.at += ms;
  }
}

const clock = new Clock();
const alerts: McpVerifyAlert[] = [];
const alertsOf = (kind: McpVerifyAlert['kind']) => alerts.filter((a) => a.kind === kind);
/** A fresh alert window, so one test's counts never reach the next. */
const nextAlertWindow = () => clock.advance(limits.EXCHANGE_ALERT_WINDOW * 1000);

function startVerifyService(): Promise<Service> {
  return startService({
    verify: {
      alerts: createMcpVerifyAlerts({ send: (alert) => alerts.push(alert), now: clock.now }),
      now: clock.now,
    },
  });
}

type ServiceName = serviceUsers.ServiceName;

const LIMIT_FLAGS: Record<ServiceName, string[]> = {
  'ansari-mcp': [
    '--rate-max', String(limits.MCP_KEY_INITIAL.rateLimitMax),
    '--rate-window', String(limits.MCP_KEY_INITIAL.rateLimitTimeWindow / 1000),
    '--daily', String(limits.MCP_KEY_INITIAL.refillAmount),
    '--client-id', 'ansari-mcp-production',
  ],
  whatsapp: ['--rate-max', '60', '--rate-window', '60', '--daily', '3000'],
};

async function serviceUserOf(on: Service, name: ServiceName): Promise<string> {
  const found = await serviceUsers.findServiceUser(on.db, name);
  if (found.kind === 'one') return found.user.id;
  if (found.kind === 'many') throw new Error(`more than one ${name} service user`);
  return (await serviceUsers.createServiceUser(on.db, name)).id;
}

/** A key made by the service-keys script's create-key, as an operator would; returns the raw key and its id. */
async function scriptKey(name: ServiceName = 'ansari-mcp', on: Service = service, flags = LIMIT_FLAGS[name]) {
  const userId = await serviceUserOf(on, name);
  const result = await runServiceKeys({ db: on.db, auth: on.auth }, parseArgs(['create-key', name, ...flags, '--confirm', userId]));
  expect(result.exitCode).toBe(0);
  const { prefix } = serviceUsers.SERVICES[name];
  const raw = result.lines.find((l) => l.startsWith(prefix) && l.length > prefix.length + 60);
  const id = /Created key ([0-9a-f-]{36})/.exec(result.lines.join('\n'))?.[1];
  if (!raw || !id) throw new Error('no key in the script output');
  return { key: remember(raw), id };
}

/** A key the script would refuse to make (a key created outside it): in process, owned by `userId`. */
async function outsideKey(userId: string, body: Record<string, unknown> = {}, on: Service = service) {
  const created = await on.auth.api.createApiKey({
    body: { userId, prefix: 'ansari_mcp_', name: 'outside', permissions: MCP, rateLimitEnabled: false, ...body },
  });
  return { key: remember(created.key), id: created.id };
}

type KeyRow = { remaining: number | null; request_count: number; last_request: string | null; enabled: boolean };

async function keyRow(id: string, on: Service = service): Promise<KeyRow | undefined> {
  const { rows } = await on.client.query<KeyRow>(
    'select remaining, request_count, last_request, enabled from auth.apikey where id = $1',
    [id]
  );
  return rows[0];
}

type PostOptions = { contentType?: string | null; headers?: Record<string, string>; method?: string; path?: string; on?: Service };
type Answer = { status: number; text: string; headers: Headers };

/** A raw request to the route. Every response is checked for every key this file has made. */
async function post(body: unknown, opts: PostOptions = {}): Promise<Answer> {
  const headers: Record<string, string> = { ...opts.headers };
  if (opts.contentType !== null) headers['content-type'] = opts.contentType ?? 'application/json';
  const res = await fetch(`${(opts.on ?? service).publicUrl}${opts.path ?? SERVICE_VERIFY_PATH}`, {
    method: opts.method ?? 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await res.text();
  expect(leakedWindows(text, rawKeys)).toEqual([]);
  return { status: res.status, text, headers: res.headers };
}

const verify = (key: string, opts: PostOptions = {}) => post({ key, permissions: MCP }, opts);

const REFUSED = '{"valid":false}';
const INVALID = '{"message":"Invalid request"}';
const INTERNAL = '{"message":"Internal error"}';

function expectRefused(res: Answer): void {
  expect(res.status).toBe(200);
  expect(res.text).toBe(REFUSED);
  expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8');
  expect(res.headers.get('content-length')).toBe(String(REFUSED.length));
}

let service: Service;
let mcpUserId: string;
let key: string;
let keyId: string;

beforeAll(async () => {
  service = await startVerifyService();
  mcpUserId = await serviceUserOf(service, 'ansari-mcp');
  ({ key, id: keyId } = await scriptKey());
});

afterAll(async () => {
  await service?.close();
  for (const spy of consoleSpies) spy.mockRestore();
});

describe('the leak scan itself (a verification pattern is code)', () => {
  it('catches a line holding one 16-character window of a key, and never flags the bare prefix', () => {
    const sample = `ansari_mcp_${'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijkl'}`;
    expect(keyWindows(sample)).toHaveLength(64 - 16 + 1);
    const bad = `upstream said: ${sample.slice(30, 46)} (truncated)`;
    expect(leakedWindows(bad, [sample])).toEqual([sample.slice(30, 46)]);
    // Fifteen characters of the random part is a near miss, not a window.
    expect(leakedWindows(`x ${sample.slice(11, 26)} y`, [sample])).toEqual([]);
    expect(leakedWindows('key ansari_mcp_ (prefix only), ansari_mcp_ again', [sample])).toEqual([]);
    expect(leakedWindows(`full key ${sample}`, [sample]).length).toBe(49);
  });
});

describe('a valid ansari-mcp key', () => {
  it('→ 200 { valid: true, client_id, key_id }, and remaining drops by exactly 1', async () => {
    const before = await keyRow(keyId);
    const res = await verify(key);
    expect(res.status).toBe(200);
    expect(JSON.parse(res.text)).toEqual({ valid: true, client_id: 'ansari-mcp-production', key_id: keyId });
    expect(Object.keys(JSON.parse(res.text) as object)).toEqual(['valid', 'client_id', 'key_id']);
    const after = await keyRow(keyId);
    expect(after?.remaining).toBe((before?.remaining ?? 0) - 1);
    expect(after?.request_count).toBe((before?.request_count ?? 0) + 1);
  });

  it('every client id the script accepts is served as stored', async () => {
    for (const clientId of ['ansari-mcp', 'ansari-mcp-beta', 'ansari-mcp-dev.1_x']) {
      const flags = [...LIMIT_FLAGS['ansari-mcp'].slice(0, -1), clientId];
      const made = await scriptKey('ansari-mcp', service, flags);
      const res = await verify(made.key);
      expect(JSON.parse(res.text)).toEqual({ valid: true, client_id: clientId, key_id: made.id });
    }
  });

  it('extra fields in the body are ignored', async () => {
    const res = await post({ key, permissions: MCP, client_id: 'ansari-mcp-forged', extra: [1, 2] });
    expect(JSON.parse(res.text)).toMatchObject({ valid: true, client_id: 'ansari-mcp-production' });
  });

  it('the plugin returns metadata as an object here, and clientIdOf reads it (scenario 15)', async () => {
    const made = await scriptKey();
    const verified = await service.auth.api.verifyApiKey({ body: { key: made.key, permissions: MCP } });
    expect(verified.valid).toBe(true);
    expect(verified.key?.metadata).toEqual({ clientId: 'ansari-mcp-production' });
    expect(serviceUsers.clientIdOf(verified.key?.metadata)).toBe('ansari-mcp-production');
    // The stored form is JSON text; clientIdOf reads that too.
    const { rows } = await service.client.query<{ metadata: string }>('select metadata from auth.apikey where id = $1', [made.id]);
    expect(typeof rows[0]?.metadata).toBe('string');
    expect(serviceUsers.clientIdOf(rows[0]?.metadata)).toBe('ansari-mcp-production');
  });
});

describe('refusals: one byte-identical { valid: false }', () => {
  /** A script-made key whose row `sql` then changes (the hash's id is $1). */
  async function seeded(sql: string) {
    const made = await scriptKey();
    await service.client.query(sql, [made.id]);
    return made;
  }

  const cases: [string, () => Promise<{ key: string; id: string | null; kept: boolean }>][] = [
    ['an unknown key', async () => ({ key: remember(`ansari_mcp_${'Q'.repeat(64)}`), id: null, kept: false })],
    ['a disabled key', async () => ({ ...(await seeded('update auth.apikey set enabled = false where id = $1')), kept: true })],
    [
      // The plugin deletes an expired key when it is presented: its behaviour, not the route's.
      'an expired key',
      async () => ({ ...(await seeded(`update auth.apikey set expires_at = now() - interval '1 minute' where id = $1`)), kept: false }),
    ],
    [
      'an exhausted key (refilled daily)',
      async () => ({ ...(await seeded('update auth.apikey set remaining = 0, last_refill_at = now() where id = $1')), kept: true }),
    ],
    [
      'a rate-limited key',
      async () => ({
        ...(await seeded('update auth.apikey set request_count = rate_limit_max, last_request = now() where id = $1')),
        kept: true,
      }),
    ],
    ['a key with no permissions', async () => ({ ...(await seeded('update auth.apikey set permissions = null where id = $1')), kept: true })],
  ];

  it.each(cases)('%s', async (_name, make) => {
    const made = await make();
    expectRefused(await verify(made.key));
    if (!made.id) return;
    // Spec 314 amendment 1: the plugin deletes an expired key when it is
    // presented; every other refused row is kept. A plugin bump that changes
    // either fails here.
    if (made.kept) expect(await keyRow(made.id)).toBeDefined();
    else expect(await keyRow(made.id)).toBeUndefined();
  });

  it('USAGE_EXCEEDED and RATE_LIMITED each raised one key-refused alert in the window', () => {
    const codes = alertsOf('key-refused').map((a) => (a.kind === 'key-refused' ? a.code : null));
    expect(codes.sort()).toEqual(['RATE_LIMITED', 'USAGE_EXCEEDED']);
  });

  it('an exhausted key is kept, and served again after its daily refill', async () => {
    const made = await seeded('update auth.apikey set remaining = 0, last_refill_at = now() where id = $1');
    expectRefused(await verify(made.key));
    await service.client.query(
      `update auth.apikey set last_refill_at = now() - interval '1 day' - interval '1 minute' where id = $1`,
      [made.id]
    );
    expect(JSON.parse((await verify(made.key)).text)).toMatchObject({ valid: true, key_id: made.id });
  });
});

describe('a WhatsApp key (wrong permission, wrong owner)', () => {
  it('→ the same { valid: false }, with remaining, request_count and last_request untouched', async () => {
    const wa = await scriptKey('whatsapp');
    // Used once by its own route, so last_request and request_count are not their initial values.
    await service.client.query(`update auth.apikey set request_count = 3, last_request = now() - interval '1 hour' where id = $1`, [wa.id]);
    const before = await keyRow(wa.id);
    expectRefused(await verify(wa.key));
    expect(await keyRow(wa.id)).toEqual(before);
  });
});

describe('a permission set other than { mcp: [complete] } → 400 before any key is touched', () => {
  const requests: [string, (key: string) => unknown][] = [
    ['whatsapp: mint', (k) => ({ key: k, permissions: { whatsapp: ['mint'] } })],
    ['an empty object', (k) => ({ key: k, permissions: {} })],
    ['an extra permission', (k) => ({ key: k, permissions: { mcp: ['complete'], whatsapp: ['mint'] } })],
    ['an extra action', (k) => ({ key: k, permissions: { mcp: ['complete', 'admin'] } })],
    ['a repeated action', (k) => ({ key: k, permissions: { mcp: ['complete', 'complete'] } })],
    ['no action', (k) => ({ key: k, permissions: { mcp: [] } })],
    ['an action as a string', (k) => ({ key: k, permissions: { mcp: 'complete' } })],
    ['a differently cased resource', (k) => ({ key: k, permissions: { MCP: ['complete'] } })],
    ['permissions as an array', (k) => ({ key: k, permissions: [['mcp', ['complete']]] })],
    ['permissions null', (k) => ({ key: k, permissions: null })],
    ['permissions missing', (k) => ({ key: k })],
  ];

  it.each(requests)('%s → the one 400, no plugin call, the key row unchanged', async (_name, body) => {
    const made = await scriptKey();
    const before = await keyRow(made.id);
    const spy = vi.spyOn(service.auth.api, 'verifyApiKey');
    try {
      const res = await post(body(made.key));
      expect(res.status).toBe(400);
      expect(res.text).toBe(INVALID);
      expect(res.text).not.toMatch(/mcp|whatsapp|permission|complete|mint/i);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
    expect(await keyRow(made.id)).toEqual(before);
  });

  it('the spy sees the plugin call for the served set (so the cases above are not vacuous)', async () => {
    const spy = vi.spyOn(service.auth.api, 'verifyApiKey');
    try {
      expect((await verify(key)).status).toBe(200);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('the owner and the client id', () => {
  it('a key carrying mcp: complete owned by a non-service user → { valid: false }', async () => {
    const member = await signUpTokens(service, 'mcp-member@example.com');
    const made = await outsideKey(member.id, { metadata: { clientId: 'ansari-mcp-production' } });
    expectRefused(await verify(made.key));
  });

  it("a key carrying mcp: complete owned by the WhatsApp service user → { valid: false }", async () => {
    const waUser = await serviceUserOf(service, 'whatsapp');
    const made = await outsideKey(waUser, { metadata: { clientId: 'ansari-mcp-production' } });
    expectRefused(await verify(made.key));
  });

  it.each([
    ['no metadata', {}],
    ['metadata without clientId', { metadata: { other: 'x' } }],
    ['an off-pattern clientId (claude-skill)', { metadata: { clientId: 'claude-skill' } }],
    ['a clientId that only starts with ansari-mcp', { metadata: { clientId: 'ansari-mcpx' } }],
    ['an upper-case clientId', { metadata: { clientId: 'ansari-mcp-PROD' } }],
    ['a non-string clientId', { metadata: { clientId: 42 } }],
  ])('%s → { valid: false }, and one client-id-invalid alert per window naming the key', async (_name, body) => {
    nextAlertWindow();
    const sent = alertsOf('client-id-invalid').length;
    const first = await outsideKey(mcpUserId, body);
    const second = await outsideKey(mcpUserId, body);
    for (const made of [first, second, first]) expectRefused(await verify(made.key));
    expect(alertsOf('client-id-invalid').slice(sent)).toEqual([
      { kind: 'client-id-invalid', keyId: first.id, windowSeconds: limits.EXCHANGE_ALERT_WINDOW },
    ]);
  });
});

describe('the service user (scenario 7)', () => {
  it('missing: a valid key → 500 and one alert per window; an unknown key → { valid: false }', async () => {
    const lone = await startVerifyService();
    try {
      nextAlertWindow();
      const sent = alertsOf('service-user-unresolvable').length;
      const made = await scriptKey('ansari-mcp', lone);
      const owner = await serviceUserOf(lone, 'ansari-mcp');
      await lone.client.query(`delete from auth.account where user_id = $1`, [owner]);
      for (let i = 0; i < 3; i++) {
        const res = await verify(made.key, { on: lone });
        expect(res.status).toBe(500);
        expect(res.text).toBe(INTERNAL);
      }
      expect(alertsOf('service-user-unresolvable').slice(sent)).toEqual([
        { kind: 'service-user-unresolvable', serviceUsers: 0, windowSeconds: limits.EXCHANGE_ALERT_WINDOW },
      ]);
      expectRefused(await verify(remember(`ansari_mcp_${'R'.repeat(64)}`), { on: lone }));
    } finally {
      await lone.close();
    }
  });

  it('duplicated by a forced second row: a valid key → 500 and an alert; an unknown key → { valid: false }', async () => {
    const dup = await startVerifyService();
    try {
      nextAlertWindow();
      const sent = alertsOf('service-user-unresolvable').length;
      const made = await scriptKey('ansari-mcp', dup);
      await dup.client.exec(`
        alter table auth.account drop constraint account_provider_id_account_id_unique;
        with second as (
          insert into auth.users (name, email, role, registered_via)
          values ('service-ansari-mcp', 'second-mcp@example.com', 'user', 'service') returning id
        )
        insert into auth.account (account_id, provider_id, user_id, updated_at)
        select 'ansari-mcp', 'service', id, now() from second;
      `);
      const res = await verify(made.key, { on: dup });
      expect(res.status).toBe(500);
      expect(res.text).toBe(INTERNAL);
      expect(alertsOf('service-user-unresolvable').slice(sent)).toEqual([
        { kind: 'service-user-unresolvable', serviceUsers: 2, windowSeconds: limits.EXCHANGE_ALERT_WINDOW },
      ]);
      expectRefused(await verify(remember(`ansari_mcp_${'S'.repeat(64)}`), { on: dup }));
    } finally {
      await dup.close();
    }
  });
});

describe('outages are 500, never { valid: false } (scenario 8)', () => {
  it('auth.apikey dropped → 500 for a valid and an unknown key once the check window has passed', async () => {
    const outage = await startVerifyService();
    try {
      const made = await scriptKey('ansari-mcp', outage);
      const unknown = remember(`ansari_mcp_${'T'.repeat(64)}`);
      // An unknown key while the relation is there: refused, and the check is cached.
      expectRefused(await verify(unknown, { on: outage }));
      await outage.client.exec('drop table auth.apikey');
      // Inside the window, the stated residual: still refused.
      expectRefused(await verify(unknown, { on: outage }));
      clock.advance(limits.APIKEY_RELATION_CHECK_TTL);
      for (const presented of [made.key, unknown]) {
        const res = await verify(presented, { on: outage });
        expect(res.status).toBe(500);
        expect(res.text).toBe(INTERNAL);
      }
    } finally {
      await outage.close();
    }
  });

  it('the database stopped under the running app → 500 for a valid and an unknown key', async () => {
    const stopped = await startVerifyService();
    const made = await scriptKey('ansari-mcp', stopped);
    clock.advance(limits.APIKEY_RELATION_CHECK_TTL);
    await stopped.client.close();
    for (const presented of [made.key, remember(`ansari_mcp_${'U'.repeat(64)}`)]) {
      const res = await verify(presented, { on: stopped });
      expect(res.status).toBe(500);
      expect(res.text).toBe(INTERNAL);
    }
    await stopped.close().catch(() => undefined);
  });
});

describe('the body → the one 400 (scenario 9)', () => {
  const cases: [string, () => string, string | null][] = [
    ['malformed JSON', () => '{"key":', 'application/json'],
    ['a text/plain body', () => JSON.stringify({ key, permissions: MCP }), 'text/plain'],
    ['no Content-Type', () => JSON.stringify({ key, permissions: MCP }), null],
    ['over the byte limit', () => JSON.stringify({ key, permissions: MCP, pad: 'x'.repeat(limits.VERIFY_BODY_LIMIT) }), 'application/json'],
    ['a JSON string', () => JSON.stringify(key), 'application/json'],
    ['a JSON array', () => JSON.stringify([key, MCP]), 'application/json'],
    ['key missing', () => JSON.stringify({ permissions: MCP }), 'application/json'],
    ['key not a string', () => JSON.stringify({ key: 12345, permissions: MCP }), 'application/json'],
    ['key empty', () => JSON.stringify({ key: '', permissions: MCP }), 'application/json'],
    ['key over 256 characters', () => JSON.stringify({ key: `ansari_mcp_${'A'.repeat(246)}`, permissions: MCP }), 'application/json'],
    ['key with a space', () => JSON.stringify({ key: `${key.slice(0, 20)} ${key.slice(20)}`, permissions: MCP }), 'application/json'],
    ['key with a tab', () => JSON.stringify({ key: `${key}\t`, permissions: MCP }), 'application/json'],
    ['key with a non-ASCII character', () => JSON.stringify({ key: `${key.slice(0, 74)}é`, permissions: MCP }), 'application/json'],
  ];

  it.each(cases)('%s → the exact 400, no plugin call', async (_name, body, contentType) => {
    const before = await keyRow(keyId);
    const spy = vi.spyOn(service.auth.api, 'verifyApiKey');
    try {
      const res = await post(body(), { contentType });
      expect(res.status).toBe(400);
      expect(res.text).toBe(INVALID);
      expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8');
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
    expect(await keyRow(keyId)).toEqual(before);
  });

  it('a key of exactly 256 printable characters is in bounds (refused as unknown, not a 400)', async () => {
    expectRefused(await verify(remember(`ansari_mcp_${'V'.repeat(245)}`)));
  });
});

describe('transport (scenario 10)', () => {
  const ORIGINS: [string, string | undefined][] = [
    ['the configured CORS_ORIGIN', BASE],
    ['null', 'null'],
    ['https://evil.example', 'https://evil.example'],
    ['no Origin', undefined],
  ];
  const corsHeaders = (headers: Headers) => [...headers.keys()].filter((h) => h.startsWith('access-control-'));

  it.each(ORIGINS)('no Access-Control-* header on POST or OPTIONS (%s)', async (_name, origin) => {
    const originHeader: Record<string, string> = origin ? { origin } : {};
    for (const presented of [key, `ansari_mcp_${'W'.repeat(64)}`]) {
      const res = await verify(presented, { headers: originHeader });
      expect(res.status).toBe(200);
      expect(corsHeaders(res.headers)).toEqual([]);
    }
    const invalid = await post('{', { headers: originHeader });
    expect(invalid.status).toBe(400);
    expect(corsHeaders(invalid.headers)).toEqual([]);
    const preflight = await fetch(`${service.publicUrl}${SERVICE_VERIFY_PATH}`, {
      method: 'OPTIONS',
      headers: { ...originHeader, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' },
    });
    expect(preflight.status).toBe(404);
    expect(corsHeaders(preflight.headers)).toEqual([]);
  });

  it.each(['GET', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'])('%s → 404 with an empty body and no Access-Control-* header', async (method) => {
    const res = await fetch(`${service.publicUrl}${SERVICE_VERIFY_PATH}`, { method, headers: { origin: BASE } });
    expect(res.status).toBe(404);
    expect(await res.text()).toBe('');
    expect(corsHeaders(res.headers)).toEqual([]);
  });

  it('a sub-path → 404 with no Access-Control-* header', async () => {
    const res = await verify(key, { path: `${SERVICE_VERIFY_PATH}/extra`, headers: { origin: BASE } });
    expect(res.status).toBe(404);
    expect(corsHeaders(res.headers)).toEqual([]);
  });

  it('is mounted before corsFor, beside the exchange', () => {
    const app = createApp({ auth: service.auth, db: service.db });
    type Layer = { name: string; matchers: ((path: string) => unknown)[] };
    const stack = (app as unknown as { router: { stack: Layer[] } }).router.stack;
    const at = (path: string) => stack.findIndex((l) => l.name === 'router' && l.matchers.some((m) => m(path)));
    const corsAt = stack.findIndex((l) => l.name === 'corsMiddleware');
    expect(at(SERVICE_VERIFY_PATH)).toBeGreaterThanOrEqual(0);
    expect(at(WHATSAPP_SESSION_PATH)).toBeGreaterThanOrEqual(0);
    expect(corsAt).toBeGreaterThan(at(SERVICE_VERIFY_PATH));
  });

  it('is not reachable under /api/auth/*', async () => {
    for (const path of ['/api/auth/service/verify-key', '/api/auth/api/service/verify-key']) {
      const before = await keyRow(keyId);
      const res = await verify(key, { path, headers: { 'x-real-ip': '198.51.100.9', origin: BASE } });
      expect(res.status).toBe(404);
      expect(await keyRow(keyId)).toEqual(before);
    }
  });
});

describe('alerts (scenario 13)', () => {
  it('per-key window volume: one alert at MCP_VERIFY_KEY_ALERT, counts and the key id only', async () => {
    const made = await scriptKey();
    const sent = alertsOf('key-window-volume').length;
    for (let i = 0; i < limits.MCP_VERIFY_KEY_ALERT + 5; i++) expect((await verify(made.key)).status).toBe(200);
    expect(alertsOf('key-window-volume').slice(sent)).toEqual([
      {
        kind: 'key-window-volume',
        keyId: made.id,
        requests: limits.MCP_VERIFY_KEY_ALERT,
        windowSeconds: limits.MCP_KEY_INITIAL.rateLimitTimeWindow / 1000,
        threshold: limits.MCP_VERIFY_KEY_ALERT,
      },
    ]);
  });

  it('per-key daily volume: one alert at MCP_VERIFY_DAILY_ALERT since the refill', async () => {
    const made = await scriptKey();
    const daily = limits.MCP_KEY_INITIAL.refillAmount;
    await service.client.query(`update auth.apikey set remaining = $1, last_refill_at = now() where id = $2`, [
      daily - (limits.MCP_VERIFY_DAILY_ALERT - 1),
      made.id,
    ]);
    const sent = alertsOf('key-daily-volume').length;
    for (let i = 0; i < 3; i++) expect((await verify(made.key)).status).toBe(200);
    expect(alertsOf('key-daily-volume').slice(sent)).toEqual([
      { kind: 'key-daily-volume', keyId: made.id, requests: limits.MCP_VERIFY_DAILY_ALERT, threshold: limits.MCP_VERIFY_DAILY_ALERT },
    ]);
  });

  it('refusal volume: one alert per window at MCP_VERIFY_UNAUTHORIZED_ALERT, and again in the next window', async () => {
    const { max } = limits.MCP_VERIFY_UNAUTHORIZED_ALERT;
    const unknown = remember(`ansari_mcp_${'X'.repeat(64)}`);
    for (let round = 0; round < 2; round++) {
      nextAlertWindow();
      const sent = alertsOf('unauthorized-volume').length;
      for (let i = 0; i < max + 5; i++) expectRefused(await verify(unknown));
      expect(alertsOf('unauthorized-volume').slice(sent)).toEqual([
        { kind: 'unauthorized-volume', windowSeconds: limits.EXCHANGE_ALERT_WINDOW, threshold: max },
      ]);
    }
  });

  it('USAGE_EXCEEDED fires once per window, and again in the next', async () => {
    const made = await scriptKey();
    await service.client.query('update auth.apikey set remaining = 0, last_refill_at = now() where id = $1', [made.id]);
    for (let round = 0; round < 2; round++) {
      nextAlertWindow();
      const sent = alertsOf('key-refused').length;
      for (let i = 0; i < 3; i++) expectRefused(await verify(made.key));
      expect(alertsOf('key-refused').slice(sent)).toEqual([
        { kind: 'key-refused', code: 'USAGE_EXCEEDED', windowSeconds: limits.EXCHANGE_ALERT_WINDOW },
      ]);
    }
  });

  it('every alert carries numbers, its kind, a refusal code or a key id, and nothing else', () => {
    expect(new Set(alerts.map((a) => a.kind))).toEqual(
      new Set(['key-window-volume', 'key-daily-volume', 'key-refused', 'unauthorized-volume', 'service-user-unresolvable', 'client-id-invalid'])
    );
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

describe('MCP alert dedup (unit, injected clock)', () => {
  it('each fire-once kind sends once per EXCHANGE_ALERT_WINDOW, and again in the next window', () => {
    const sent: McpVerifyAlert[] = [];
    const fake = new Clock();
    const tracker = createMcpVerifyAlerts({ send: (a) => sent.push(a), now: fake.now });
    const windowMs = limits.EXCHANGE_ALERT_WINDOW * 1000;
    const round = () => {
      for (let i = 0; i < 5; i++) {
        tracker.clientIdInvalid(`00000000-0000-4000-8000-00000000000${i}`);
        tracker.keyRefused('USAGE_EXCEEDED');
        tracker.serviceUserUnresolvable(0);
      }
      for (let i = 0; i < limits.MCP_VERIFY_UNAUTHORIZED_ALERT.max + 5; i++) tracker.unauthorized();
    };
    round();
    fake.advance(windowMs - 1);
    round();
    const kinds = () => sent.map((a) => a.kind).sort();
    const once = ['client-id-invalid', 'key-refused', 'service-user-unresolvable', 'unauthorized-volume'];
    expect(kinds()).toEqual(once);
    expect(sent.find((a) => a.kind === 'client-id-invalid')).toMatchObject({ keyId: '00000000-0000-4000-8000-000000000000' });
    fake.advance(1);
    round();
    expect(kinds()).toEqual([...once, ...once].sort());
  });

  it('a key over MCP_VERIFY_KEY_ALERT in every 60 s key window alerts once per EXCHANGE_ALERT_WINDOW, not once per key window', () => {
    const sent: McpVerifyAlert[] = [];
    const fake = new Clock();
    const tracker = createMcpVerifyAlerts({ send: (a) => sent.push(a), now: fake.now });
    const keyWindowMs = limits.MCP_KEY_INITIAL.rateLimitTimeWindow;
    const usage = {
      id: '00000000-0000-4000-8000-0000000000aa',
      requestCount: limits.MCP_VERIFY_KEY_ALERT,
      rateLimitTimeWindow: keyWindowMs,
      remaining: null,
      refillAmount: null,
      lastRefillAt: null,
      createdAt: new Date(fake.at).toISOString(),
    };
    const alertWindowMs = limits.EXCHANGE_ALERT_WINDOW * 1000;
    expect(alertWindowMs / keyWindowMs).toBeGreaterThanOrEqual(2);
    // Every key window inside one alert window crosses the threshold.
    for (let t = 0; t < alertWindowMs; t += keyWindowMs) {
      tracker.keyVerified(usage);
      fake.advance(keyWindowMs);
    }
    expect(sent.filter((a) => a.kind === 'key-window-volume')).toHaveLength(1);
    // The next alert window may fire again.
    tracker.keyVerified(usage);
    expect(sent.filter((a) => a.kind === 'key-window-volume')).toHaveLength(2);
  });

  it('sends under the MCP message and mcp-verify-<kind> tags, never the WhatsApp ones', () => {
    expect(MCP_VERIFY_ALERT_MESSAGE).toBe('auth: MCP key verify alert');
    expect(EXCHANGE_ALERT_MESSAGE).not.toBe(MCP_VERIFY_ALERT_MESSAGE);
  });
});

describe('key material at rest and in logs (scenario 12)', () => {
  it("the apikey rows hold no window of any key's random part outside the hash", async () => {
    const { rows } = await service.client.query<{ row: Record<string, unknown> }>('select row_to_json(t) as row from auth.apikey t');
    expect(rows.length).toBeGreaterThan(10);
    const text = JSON.stringify(rows.map(({ row }) => ({ ...row, key: undefined })));
    expect(text).toContain('ansari_mcp_'); // the public prefix is stored, and exempt
    expect(leakedWindows(text, rawKeys)).toEqual([]);
  });

  it('the console carries no window of any key, no key hash and no driver error object', async () => {
    expect(logged.length).toBeGreaterThan(0);
    const text = logged.map((args) => args.map((a) => inspect(a, { depth: 8 })).join(' ')).join('\n');
    expect(leakedWindows(text, rawKeys)).toEqual([]);
    const { rows } = await service.client.query<{ key: string }>('select key from auth.apikey');
    for (const { key: hash } of rows) expect(text).not.toContain(hash);
    for (const args of logged) for (const arg of args) expect(arg).not.toBeInstanceOf(Error);
  });
});
