// The service-keys operator script (spec 329, plan phase 4): service users,
// and keys issued, listed, rotated, changed and revoked in grant-admin.ts's
// posture, against the auth database on pglite. Script functions are driven
// directly; Sentry through a spy transport.
import { createHash } from 'node:crypto';

import * as Sentry from '@sentry/node';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { limits, serviceUsers } from '@ansari/auth';

import {
  checkKeyLimits,
  EXIT_NOTHING_WRITTEN,
  EXIT_UNRECORDED,
  KEY_EVENT_MESSAGE,
  parseArgs,
  RefusedError,
  sentryRecorder,
  serviceKeys,
  type KeyEvent,
  type Recorder,
} from '../scripts/service-keys';
import { urlHostPort } from '../scripts/url-host';
import { startService, type Service } from './helpers/service';

/** The plan's URL: a user, a password and a query string, none of which may be printed. */
const DB_URL = 'postgres://user:secret@db.example:6543/auth?sslmode=require';
/**
 * The same shape with distinctive userinfo: the output says "user" in its own
 * words ("Service user for …"), so this one shows the URL's user is not echoed.
 */
const DB_URL_DISTINCT = 'postgres://opsname-zq:pw-zq-9@db.example:6543/authdb-zq?sslmode=verify-full&application_name=zq';

const INITIAL = limits.WHATSAPP_KEY_INITIAL;
const LIMIT_FLAGS = ['--rate-max', '60', '--rate-window', '60', '--daily', '3000'];
const WA_KEY = /ansari_wa_[A-Za-z]{64}/g;

let service: Service;

beforeAll(async () => {
  service = await startService();
});
afterAll(async () => {
  await service.close();
});

beforeEach(async () => {
  // Service users are one per name: each test starts without any (keys and
  // the `service` rows go with the cascade).
  await service.client.query(`delete from auth.users where registered_via = 'service'`);
});

/** A recorder that keeps events in memory and flushes as told. */
function memoryRecorder(flushed = true): Recorder & { events: KeyEvent[]; flushes: number } {
  return {
    events: [],
    flushes: 0,
    capture(event) {
      this.events.push(event);
    },
    async flush() {
      this.flushes += 1;
      return flushed;
    },
  };
}

type RunOptions = { url?: string | undefined; recorder?: Recorder; flushTimeoutMs?: number };

async function run(argv: string[], opts: RunOptions = {}) {
  const connect = vi.fn(() => ({ db: service.db, auth: service.auth }));
  const print = vi.fn<(line: string) => void>();
  const result = await serviceKeys(argv, {
    databaseUrl: 'url' in opts ? opts.url : DB_URL,
    connect,
    recorder: opts.recorder ?? memoryRecorder(),
    print,
    flushTimeoutMs: opts.flushTimeoutMs,
  });
  return { ...result, text: result.lines.join('\n'), connect, print };
}

async function serviceUserId(name = 'whatsapp'): Promise<string> {
  const found = await serviceUsers.findServiceUser(service.db, name as serviceUsers.ServiceName);
  if (found.kind !== 'one') throw new Error(`expected one service user, got ${found.kind}`);
  return found.user.id;
}

async function createService(name = 'whatsapp'): Promise<string> {
  const { exitCode } = await run(['create-service', name, '--confirm', name]);
  expect(exitCode).toBe(0);
  return serviceUserId(name);
}

/** create-key (or rotate) with --confirm; returns the key's id and the raw key from the output. */
async function createKey(kind: 'create-key' | 'rotate' = 'create-key', flags = LIMIT_FLAGS, name = 'whatsapp') {
  const userId = await serviceUserId(name);
  const result = await run([kind, name, ...flags, '--confirm', userId]);
  expect(result.exitCode, result.text).toBe(0);
  const prefix = serviceUsers.SERVICES[name as serviceUsers.ServiceName].prefix;
  const key = result.lines.find((l) => l.startsWith(prefix) && l.length > prefix.length + 60);
  const id = /Created key ([0-9a-f-]{36})/.exec(result.text)?.[1];
  if (!key || !id) throw new Error('no key in the output');
  return { ...result, key, id, userId };
}

async function keyRow(id: string) {
  const { rows } = await service.client.query<Record<string, unknown>>('select * from auth.apikey where id = $1', [id]);
  return rows[0];
}

async function rowCounts() {
  const { rows } = await service.client.query<{ users: number; accounts: number; keys: number }>(
    `select (select count(*)::int from auth.users where email like 'service-%') as users,
            (select count(*)::int from auth.account where provider_id = 'service') as accounts,
            (select count(*)::int from auth.apikey) as keys`
  );
  return rows[0];
}

const verify = (key: string, permissions: Record<string, string[]> = { whatsapp: ['mint'] }) =>
  service.auth.api.verifyApiKey({ body: { key, permissions } });

const occurrences = (text: string, needle: string) => text.split(needle).length - 1;

describe('parseArgs', () => {
  it('parses each subcommand, the window in seconds stored as milliseconds', () => {
    expect(parseArgs(['create-service', 'whatsapp'])).toEqual({ kind: 'create-service', service: 'whatsapp', confirm: null });
    expect(parseArgs(['list', 'ansari-mcp'])).toEqual({ kind: 'list', service: 'ansari-mcp' });
    expect(parseArgs(['create-key', 'whatsapp', ...LIMIT_FLAGS, '--name', 'wa main', '--client-id', 'wa-svc'])).toEqual({
      kind: 'create-key',
      service: 'whatsapp',
      confirm: null,
      limits: INITIAL,
      name: 'wa main',
      clientId: 'wa-svc',
    });
    const id = '3f2a9c1e-0000-4000-8000-00000000000A';
    expect(parseArgs(['revoke', 'whatsapp', '--key', id, '--confirm', 'u'])).toEqual({
      kind: 'revoke',
      service: 'whatsapp',
      keyId: id.toLowerCase(),
      confirm: 'u',
    });
    expect(parseArgs(['update-limits', 'whatsapp', '--key', id, ...LIMIT_FLAGS])).toMatchObject({
      kind: 'update-limits',
      limits: INITIAL,
    });
  });

  it.each([
    [['create-key', 'whatsapp', ...LIMIT_FLAGS, '--expires-in', '86400'], /no expiry/],
    [['create-key', 'whatsapp', ...LIMIT_FLAGS, '--expiresIn', '86400'], /no expiry/],
    [['rotate', 'whatsapp', ...LIMIT_FLAGS, '--expiration', '1'], /no expiry/],
    [['create-key', 'whatsapp', '--rate-max', '60', '--rate-window', '60', '--remaining', '100'], /without a refill/],
    [['create-key', 'whatsapp', '--rate-max', '60', '--rate-window', '60'], /no defaults; missing --daily/],
    [['create-key', 'whatsapp', '--daily', '10'], /missing --rate-max, --rate-window/],
    [['create-key', 'whatsapp', ...LIMIT_FLAGS, '--permissions', 'x'], /not an option/],
    [['create-key', 'whatsapp', ...LIMIT_FLAGS, '--daily', '5'], /given twice/],
    [['create-key', 'whatsapp', '--rate-max', '1.5', '--rate-window', '60', '--daily', '1'], /whole number/],
    [['create-key', 'whatsapp', '--rate-max', '-1', '--rate-window', '60', '--daily', '1'], /needs a value|whole number/],
    [['create-key', 'leaderboard', ...LIMIT_FLAGS], /Unknown service/],
    [['revoke', 'whatsapp'], /needs --key/],
    [['revoke', 'whatsapp', '--key', 'not-an-id'], /key id as list prints it/],
    [['list', 'whatsapp', '--confirm', 'x'], /not an option of list/],
    [['create-service', 'whatsapp', '--confirm'], /needs a value/],
    [['delete', 'whatsapp'], /Usage/],
    [[], /Usage/],
  ])('refuses %j', (argv, reason) => {
    expect(() => parseArgs(argv)).toThrow(RefusedError);
    expect(() => parseArgs(argv)).toThrow(reason);
  });
});

describe('checkKeyLimits', () => {
  const bounds = limits.WHATSAPP_KEY_BOUNDS;

  it('accepts the initial values and both ends of every bound', () => {
    expect(checkKeyLimits('whatsapp', INITIAL)).toEqual(INITIAL);
    for (const edge of ['min', 'max'] as const) {
      const values = {
        rateLimitMax: bounds.rateLimitMax[edge],
        rateLimitTimeWindow: bounds.rateLimitTimeWindow[edge],
        refillAmount: bounds.refillAmount[edge],
        refillInterval: limits.KEY_REFILL_INTERVAL,
      };
      expect(checkKeyLimits('whatsapp', values)).toEqual(values);
    }
  });

  it('refuses a budget without a refill, and a key without a rate limit', () => {
    const { refillAmount, refillInterval, ...rest } = INITIAL;
    expect(() => checkKeyLimits('whatsapp', { ...rest, refillAmount })).toThrow(/without a refill/);
    expect(() => checkKeyLimits('whatsapp', { ...rest, refillInterval })).toThrow(/without a refill/);
    expect(() => checkKeyLimits('whatsapp', { ...INITIAL, refillInterval: 3_600_000 })).toThrow(/without a refill/);
    expect(() => checkKeyLimits('whatsapp', { refillAmount, refillInterval })).toThrow(/needs a rate limit/);
  });

  it.each([
    ['rateLimitMax', bounds.rateLimitMax.min - 1, /--rate-max/],
    ['rateLimitMax', bounds.rateLimitMax.max + 1, /--rate-max/],
    ['rateLimitTimeWindow', bounds.rateLimitTimeWindow.min - 1, /--rate-window/],
    ['rateLimitTimeWindow', bounds.rateLimitTimeWindow.max + 1, /--rate-window/],
    ['refillAmount', bounds.refillAmount.min - 1, /--daily/],
    ['refillAmount', bounds.refillAmount.max + 1, /--daily/],
  ])('refuses %s = %d', (field, value, reason) => {
    expect(() => checkKeyLimits('whatsapp', { ...INITIAL, [field]: value })).toThrow(reason);
  });
});

describe('urlHostPort', () => {
  it('is hostname and port only, with postgres default port, and null when the URL does not parse', () => {
    expect(urlHostPort(DB_URL)).toBe('db.example:6543');
    expect(urlHostPort('postgresql://u:p@DB.Example/auth')).toBe('db.example:5432');
    expect(urlHostPort('not a url with secret')).toBeNull();
    expect(urlHostPort(undefined)).toBeNull();
  });
});

describe('every subcommand', () => {
  const KEY_ID = '00000000-0000-4000-8000-000000000001';
  /** Each subcommand as an operator would type it, before --confirm. */
  const SUBCOMMANDS: Record<string, string[]> = {
    'create-service': ['create-service', 'whatsapp'],
    'create-key': ['create-key', 'whatsapp', ...LIMIT_FLAGS],
    list: ['list', 'whatsapp'],
    rotate: ['rotate', 'whatsapp', ...LIMIT_FLAGS],
    'update-limits': ['update-limits', 'whatsapp', '--key', KEY_ID, ...LIMIT_FLAGS],
    revoke: ['revoke', 'whatsapp', '--key', KEY_ID],
  };

  it.each(Object.keys(SUBCOMMANDS))('%s refuses to run without a database URL, before connecting', async (name) => {
    for (const url of [undefined, '']) {
      const { exitCode, text, connect } = await run([...SUBCOMMANDS[name]!, '--confirm', 'x'], { url });
      expect(exitCode).toBe(1);
      expect(text).toMatch(/DATABASE_URL is not set/);
      expect(connect).not.toHaveBeenCalled();
    }
    const unparsable = await run(SUBCOMMANDS[name]!, { url: 'postgres://user:secret@[bad' });
    expect(unparsable.exitCode).toBe(1);
    expect(unparsable.text).toMatch(/does not parse/);
    expect(unparsable.text).not.toMatch(/secret|\[bad/);
    expect(unparsable.connect).not.toHaveBeenCalled();
  });

  it.each(Object.keys(SUBCOMMANDS))('%s refuses a mismatched --confirm and writes nothing', async (name) => {
    let argv = SUBCOMMANDS[name]!;
    if (name !== 'create-service') await createService();
    if (name === 'rotate' || name === 'update-limits' || name === 'revoke') {
      const { id } = await createKey();
      argv = argv.map((arg) => (arg === KEY_ID ? id : arg));
    }
    const before = await rowCounts();
    const { rows: keysBefore } = await service.client.query('select * from auth.apikey order by id');
    const recorder = memoryRecorder();
    const otherId = '00000000-0000-4000-8000-0000000000ff';
    const result = await run([...argv, '--confirm', otherId], { recorder });
    if (name === 'list') {
      // list writes nothing and takes no --confirm at all.
      expect(result.exitCode).toBe(1);
      expect(result.text).toMatch(/not an option of list/);
    } else {
      expect(result.exitCode).toBe(EXIT_NOTHING_WRITTEN);
      expect(result.text).toMatch(/Nothing was written/);
    }
    expect(await rowCounts()).toEqual(before);
    expect((await service.client.query('select * from auth.apikey order by id')).rows).toEqual(keysBefore);
    expect(recorder.events).toEqual([]);
  });

  it.each(Object.keys(SUBCOMMANDS))(
    '%s prints the database as hostname:port only, never the URL, its user, password or query',
    async (name) => {
      let argv = SUBCOMMANDS[name]!;
      if (name !== 'create-service') {
        const userId = await createService();
        const { id } = await createKey();
        argv = argv.map((a) => (a === KEY_ID ? id : a));
        // update-limits and revoke confirm with the key's id; the other writes with the user's.
        if (name !== 'list') argv = [...argv, '--confirm', name === 'update-limits' || name === 'revoke' ? id : userId];
      } else {
        argv = [...argv, '--confirm', 'whatsapp'];
      }
      for (const url of [DB_URL, DB_URL_DISTINCT]) {
        // A write subcommand runs again against the second URL: undo the first write.
        if (url === DB_URL_DISTINCT && name === 'create-service') {
          await service.client.query(`delete from auth.users where registered_via = 'service'`);
        }
        const { text, exitCode, print, connect } = await run(argv, { url });
        expect(exitCode, text).toBe(0);
        expect(text.split('\n')[0]).toBe('Auth database: db.example:6543');
        // Printed at once, before the script connects (and so before any write),
        // and every line printed is the line returned, in order.
        expect(print.mock.calls[0]).toEqual(['Auth database: db.example:6543']);
        expect(print.mock.invocationCallOrder[0]!).toBeLessThan(connect.mock.invocationCallOrder[0]!);
        expect(print.mock.calls.map(([line]) => line)).toEqual(text.split('\n'));
        expect(text).toContain('db.example:6543');
        for (const leak of ['user:secret', 'secret', 'sslmode', '/auth?', 'opsname-zq', 'pw-zq', 'authdb-zq', 'verify-full', 'application_name', 'postgres://']) {
          expect(text, leak).not.toContain(leak);
        }
      }
    }
  );

  it.each(['create-key', 'rotate', 'update-limits', 'revoke'])('%s logs the key id it acted on', async (name) => {
    const userId = await createService();
    const first = await createKey();
    if (name === 'create-key') {
      expect(first.text).toContain(`Created key ${first.id}`);
      return;
    }
    const argv =
      name === 'rotate'
        ? ['rotate', 'whatsapp', ...LIMIT_FLAGS]
        : name === 'update-limits'
          ? ['update-limits', 'whatsapp', '--key', first.id, ...LIMIT_FLAGS]
          : ['revoke', 'whatsapp', '--key', first.id];
    const confirm = name === 'rotate' ? userId : first.id;
    const { text, exitCode } = await run([...argv, '--confirm', confirm]);
    expect(exitCode).toBe(0);
    expect(text).toContain(first.id);
    if (name === 'rotate') expect(text).toMatch(/Created key [0-9a-f-]{36}/);
  });
});

describe('confirm binding and labels (security PR gate, pass 1)', () => {
  it.each(['update-limits', 'revoke'])(
    "%s confirms with the KEY's id: the service user's id, or another key's id, writes nothing",
    async (name) => {
      const userId = await createService();
      const target = await createKey();
      const other = await createKey('rotate');
      const argv =
        name === 'update-limits'
          ? ['update-limits', 'whatsapp', '--key', target.id, '--rate-max', '1', '--rate-window', '30', '--daily', '500']
          : ['revoke', 'whatsapp', '--key', target.id];
      const shown = await run(argv);
      expect(shown.text).toContain(`--confirm ${target.id}`);
      const before = await keyRow(target.id);
      for (const confirm of [userId, other.id]) {
        const result = await run([...argv, '--confirm', confirm]);
        expect(result.exitCode, result.text).toBe(EXIT_NOTHING_WRITTEN);
        expect(result.text).toMatch(/not this key's id/);
      }
      expect(await keyRow(target.id)).toEqual(before);
      expect((await run([...argv, '--confirm', target.id])).exitCode).toBe(0);
    }
  );

  it('rotate prints revoke commands confirmed by each old key id', async () => {
    const userId = await createService();
    const old = await createKey();
    const { text } = await run(['rotate', 'whatsapp', ...LIMIT_FLAGS, '--confirm', userId]);
    expect(text).toContain(`revoke whatsapp --key ${old.id} --confirm ${old.id}`);
  });

  const KEY = `ansari_wa_${'Q'.repeat(64)}`;
  it.each([
    ['a full key', KEY],
    ['a key without its prefix', 'Q'.repeat(64)],
    ['a truncated key', KEY.slice(0, 40)],
    ["another service's prefix", 'ansari_mcp_partner'],
    ['a newline', 'wa main\ninjected line'],
    ['a carriage return', 'wa main\rx'],
    ['a tab', 'wa\tmain'],
    ['a quote', "wa o'main"],
    ['65 characters', 'a'.repeat(65)],
    ['a zero-width space', '\u200b'],
  ])('--name and --client-id refuse %s, without echoing it', async (_case, value) => {
    const userId = await createService();
    for (const flag of ['--name', '--client-id']) {
      const before = await rowCounts();
      const recorder = memoryRecorder();
      const result = await run(['create-key', 'whatsapp', ...LIMIT_FLAGS, flag, value, '--confirm', userId], { recorder });
      expect(result.exitCode, result.text).toBe(1);
      expect(result.text).toContain(flag);
      expect(result.text).not.toContain(value);
      expect(await rowCounts()).toEqual(before);
      expect(recorder.events).toEqual([]);
    }
  });

  it.each([['wa main'], ['partner-1.prod_2'], [`${'x'.repeat(31)} ${'y'.repeat(31)}`], ['a'.repeat(31)]])(
    '--name and --client-id accept an inert label (%s)',
    (value) => {
      expect(parseArgs(['create-key', 'whatsapp', ...LIMIT_FLAGS, '--name', value, '--client-id', value])).toMatchObject({
        name: value,
        clientId: value,
      });
    }
  );
});

describe('create-service', () => {
  it('shows what it would create, writes nothing and exits 2', async () => {
    const before = await rowCounts();
    const { exitCode, text } = await run(['create-service', 'whatsapp']);
    expect(exitCode).toBe(EXIT_NOTHING_WRITTEN);
    expect(text).toContain('service-whatsapp@noreply.askansari.ai');
    expect(text).toContain('--confirm whatsapp');
    expect(await rowCounts()).toEqual(before);
  });

  it('creates the user (no credential, role user) and its service row, and records it', async () => {
    const recorder = memoryRecorder();
    const { exitCode, text } = await run(['create-service', 'whatsapp', '--confirm', 'whatsapp'], { recorder });
    expect(exitCode).toBe(0);
    const id = await serviceUserId();
    expect(text).toContain(id);
    const { rows } = await service.client.query<Record<string, unknown>>(
      `select u.email, u.role, u.registered_via, a.provider_id, a.account_id, a.password
       from auth.users u join auth.account a on a.user_id = u.id where u.id = $1`,
      [id]
    );
    expect(rows).toEqual([
      {
        email: 'service-whatsapp@noreply.askansari.ai',
        role: 'user',
        registered_via: 'service',
        provider_id: 'service',
        account_id: 'whatsapp',
        password: null,
      },
    ]);
    expect(recorder.events).toEqual([{ action: 'create-service', service: 'whatsapp', userId: id, keyId: null, name: null }]);
  });

  it('refuses an existing service name', async () => {
    await createService();
    for (const argv of [['create-service', 'whatsapp'], ['create-service', 'whatsapp', '--confirm', 'whatsapp']]) {
      const { exitCode, text } = await run(argv);
      expect(exitCode).toBe(1);
      expect(text).toMatch(/already has a service user/);
    }
    expect((await rowCounts())?.users).toBe(1);
  });

  it('writes the user and the service row in one transaction: a failed row leaves neither', async () => {
    // Another user already holds the (service, whatsapp) row, so the second insert fails.
    const { rows } = await service.client.query<{ id: string }>(
      `insert into auth.users (name, email) values ('squatter', 'squatter-${Date.now()}@example.com') returning id`
    );
    await service.client.query(
      `insert into auth.account (account_id, provider_id, user_id, updated_at) values ('whatsapp', 'service', $1, now())`,
      [rows[0]!.id]
    );
    await expect(serviceUsers.createServiceUser(service.db, 'whatsapp')).rejects.toThrow();
    const { rows: users } = await service.client.query(`select id from auth.users where email = 'service-whatsapp@noreply.askansari.ai'`);
    expect(users).toEqual([]);
    await service.client.query('delete from auth.users where id = $1', [rows[0]!.id]);
  });

  it('findServiceUser reports none, one and many', async () => {
    expect(await serviceUsers.findServiceUser(service.db, 'whatsapp')).toEqual({ kind: 'none' });
    const id = await createService();
    expect(await serviceUsers.findServiceUser(service.db, 'whatsapp')).toMatchObject({ kind: 'one', user: { id } });
    // Only possible without unique(provider_id, account_id): drop it for this check.
    await service.client.query('alter table auth.account drop constraint account_provider_id_account_id_unique');
    try {
      const { rows } = await service.client.query<{ id: string }>(
        `insert into auth.users (name, email, registered_via) values ('x', 'second-service@noreply.askansari.ai', 'service') returning id`
      );
      await service.client.query(
        `insert into auth.account (account_id, provider_id, user_id, updated_at) values ('whatsapp', 'service', $1, now())`,
        [rows[0]!.id]
      );
      expect(await serviceUsers.findServiceUser(service.db, 'whatsapp')).toMatchObject({ kind: 'many' });
      const { exitCode, text } = await run(['list', 'whatsapp']);
      expect(exitCode).toBe(1);
      expect(text).toMatch(/2 users claim service "whatsapp"; refusing|2 users claim service "whatsapp" \(/);
    } finally {
      await service.client.query(`delete from auth.users where registered_via = 'service'`);
      await service.client.query(
        'alter table auth.account add constraint account_provider_id_account_id_unique unique (provider_id, account_id)'
      );
    }
  });

  it('key commands refuse a service with no user', async () => {
    const { exitCode, text } = await run(['create-key', 'whatsapp', ...LIMIT_FLAGS]);
    expect(exitCode).toBe(1);
    expect(text).toMatch(/No service user for "whatsapp"/);
  });
});

describe('create-key', () => {
  it('shows the service user and the limits, writes nothing and exits 2', async () => {
    const userId = await createService();
    const { exitCode, text } = await run(['create-key', 'whatsapp', ...LIMIT_FLAGS, '--name', 'wa main']);
    expect(exitCode).toBe(EXIT_NOTHING_WRITTEN);
    expect(text).toContain(`id          ${userId}`);
    expect(text).toContain('60 per 60 s; budget 3000 per 24 h');
    expect(text).toContain(`--name 'wa main' --confirm ${userId}`);
    expect((await rowCounts())?.keys).toBe(0);
  });

  it('prints the raw key exactly once, and the row holds only its hash', async () => {
    await createService();
    const { key, id, text, userId } = await createKey('create-key', [...LIMIT_FLAGS, '--client-id', 'wa-partner']);
    expect(occurrences(text, key)).toBe(1);
    expect(text.match(WA_KEY)).toHaveLength(1);
    expect(text).toMatch(/SHOWN ONCE/);

    const row = await keyRow(id);
    for (const [column, value] of Object.entries(row!)) {
      if (typeof value === 'string') expect(value, column).not.toContain(key.slice(3));
    }
    // The plugin's hash: SHA-256, base64url (packages/auth's probe 1 pins it to defaultKeyHasher).
    expect(row!.key).toBe(createHash('sha256').update(key).digest('base64url'));
    expect(text).not.toContain(row!.key as string);
    expect(row).toMatchObject({
      reference_id: userId,
      prefix: 'ansari_wa_',
      start: null,
      enabled: true,
      rate_limit_enabled: true,
      rate_limit_max: INITIAL.rateLimitMax,
      rate_limit_time_window: INITIAL.rateLimitTimeWindow,
      remaining: INITIAL.refillAmount,
      refill_amount: INITIAL.refillAmount,
      refill_interval: INITIAL.refillInterval,
      expires_at: null,
    });
    expect(JSON.parse(row!.permissions as string)).toEqual({ whatsapp: ['mint'] });
    expect(JSON.parse(row!.metadata as string)).toEqual({ clientId: 'wa-partner' });
    expect((await verify(key)).valid).toBe(true);
    // A whatsapp key is refused at another service's permission.
    expect((await verify(key, { mcp: ['complete'] })).valid).toBe(false);
  });

  it('refuses out-of-bounds limits before writing', async () => {
    const userId = await createService();
    const { exitCode, text } = await run([
      'create-key', 'whatsapp', '--rate-max', '100001', '--rate-window', '60', '--daily', '3000', '--confirm', userId,
    ]);
    expect(exitCode).toBe(1);
    expect(text).toMatch(/Out of bounds.*--rate-max/);
    expect((await rowCounts())?.keys).toBe(0);
  });

  it('refuses an expiry option and a bare budget at the command line', async () => {
    const userId = await createService();
    for (const extra of [['--expires-in', '86400'], ['--remaining', '10']]) {
      const { exitCode, text } = await run(['create-key', 'whatsapp', ...LIMIT_FLAGS, ...extra, '--confirm', userId]);
      expect(exitCode).toBe(1);
      expect(text).toMatch(/no expiry|without a refill/);
    }
    expect((await rowCounts())?.keys).toBe(0);
  });
});

describe('list', () => {
  it('prints id, name, prefix, permissions, enabled, limits and dates per key; never a key or a hash', async () => {
    await createService();
    const a = await createKey('create-key', [...LIMIT_FLAGS, '--name', 'wa-a']);
    const b = await createKey('rotate', [...LIMIT_FLAGS, '--name', 'wa-b']);
    await verify(a.key);
    const { exitCode, text } = await run(['list', 'whatsapp']);
    expect(exitCode).toBe(0);
    expect(text).toContain('2 key(s):');
    for (const { id, key } of [a, b]) {
      expect(text).toContain(`key ${id}`);
      expect(text).not.toContain(key);
      expect(text).not.toContain(key.slice(3, 20));
      expect(text).not.toContain((await keyRow(id))!.key as string);
    }
    for (const field of ['name          wa-a', 'name          wa-b', 'prefix        ansari_wa_', 'permissions   {"whatsapp":["mint"]}', 'enabled       true', 'limits        60 per 60 s; budget 3000 per 24 h', 'created       20', 'last request  20', 'last request  never']) {
      expect(text).toContain(field);
    }
    expect(text.match(WA_KEY)).toBeNull();
  });
});

describe('rotate', () => {
  it('creates a second live key, both verify; prints the new key once and the old key id', async () => {
    await createService();
    const old = await createKey();
    const fresh = await createKey('rotate');
    expect(fresh.id).not.toBe(old.id);
    expect(occurrences(fresh.text, fresh.key)).toBe(1);
    expect(fresh.text.match(WA_KEY)).toHaveLength(1);
    expect(fresh.text).toContain(`Old live key(s): ${old.id}`);
    expect(fresh.text).toContain(`revoke whatsapp --key ${old.id}`);
    expect((await verify(old.key)).valid).toBe(true);
    expect((await verify(fresh.key)).valid).toBe(true);
  });

  it('refuses when there is no live key to rotate', async () => {
    const userId = await createService();
    const { exitCode, text } = await run(['rotate', 'whatsapp', ...LIMIT_FLAGS, '--confirm', userId]);
    expect(exitCode).toBe(1);
    expect(text).toMatch(/no live key to rotate/);
  });
});

describe('revoke', () => {
  it('shows the key and writes nothing without --confirm', async () => {
    await createService();
    const { id } = await createKey();
    const { exitCode, text } = await run(['revoke', 'whatsapp', '--key', id]);
    expect(exitCode).toBe(EXIT_NOTHING_WRITTEN);
    expect(text).toContain(`key ${id}`);
    expect((await keyRow(id))!.enabled).toBe(true);
  });

  it('sets enabled = false and keeps the row; the key no longer verifies; prints the id, no key', async () => {
    await createService();
    const { id, key } = await createKey();
    const { exitCode, text } = await run(['revoke', 'whatsapp', '--key', id, '--confirm', id]);
    expect(exitCode).toBe(0);
    expect(text).toContain(`Revoked key ${id}`);
    expect(text).toContain('enabled = false');
    expect(text).not.toContain(key);
    const row = await keyRow(id);
    expect(row).toBeDefined();
    expect(row!.enabled).toBe(false);
    const result = await verify(key);
    expect(result.valid).toBe(false);
    expect(await keyRow(id)).toBeDefined();
  });

  it("refuses a key that is not the service's", async () => {
    await createService();
    await createService('ansari-mcp');
    const mcp = await createKey('create-key', LIMIT_FLAGS, 'ansari-mcp');
    const { exitCode, text } = await run(['revoke', 'whatsapp', '--key', mcp.id, '--confirm', mcp.id]);
    expect(exitCode).toBe(1);
    expect(text).toMatch(/not a key of this service/);
    expect((await keyRow(mcp.id))!.enabled).toBe(true);
  });
});

describe('update-limits', () => {
  it('writes the new values, enforced at the next verify', async () => {
    await createService();
    const { id, key } = await createKey();
    const { exitCode, text } = await run([
      'update-limits', 'whatsapp', '--key', id, '--rate-max', '1', '--rate-window', '30', '--daily', '500', '--confirm', id,
    ]);
    expect(exitCode, text).toBe(0);
    expect(text).toContain(`Updated key ${id}`);
    expect(await keyRow(id)).toMatchObject({
      rate_limit_max: 1,
      rate_limit_time_window: 30_000,
      refill_amount: 500,
      remaining: 500,
      refill_interval: limits.KEY_REFILL_INTERVAL,
      enabled: true,
    });
    expect((await verify(key)).valid).toBe(true);
    const second = await verify(key);
    expect(second.valid).toBe(false);
    expect(second.error?.code).toBe('RATE_LIMITED');
  });

  it('refuses out-of-bounds values and writes nothing', async () => {
    await createService();
    const { id } = await createKey();
    const before = await keyRow(id);
    for (const flags of [
      ['--rate-max', '0', '--rate-window', '60', '--daily', '10'],
      ['--rate-max', '10', '--rate-window', '86401', '--daily', '10'],
      ['--rate-max', '10', '--rate-window', '60', '--daily', '10000001'],
    ]) {
      const { exitCode, text } = await run(['update-limits', 'whatsapp', '--key', id, ...flags, '--confirm', id]);
      expect(exitCode).toBe(1);
      expect(text).toMatch(/Out of bounds/);
    }
    expect(await keyRow(id)).toEqual(before);
  });
});

describe('SECRET_SCANNING_PATTERNS', () => {
  it('every service prefix is ansari_<service>_, unique, and not the start of another', () => {
    const prefixes = Object.values(serviceUsers.SERVICES).map((s) => s.prefix as string);
    for (const prefix of prefixes) expect(prefix).toMatch(/^ansari_[a-z]+_$/);
    expect(new Set(prefixes).size).toBe(prefixes.length);
    for (const a of prefixes) for (const b of prefixes) if (a !== b) expect(b.startsWith(a), `${a} starts ${b}`).toBe(false);
  });

  it('has one pattern per service, on its prefix', () => {
    expect(Object.keys(serviceUsers.SECRET_SCANNING_PATTERNS).sort()).toEqual(Object.keys(serviceUsers.SERVICES).sort());
    for (const [name, pattern] of Object.entries(serviceUsers.SECRET_SCANNING_PATTERNS)) {
      expect(pattern.source.startsWith(serviceUsers.SERVICES[name as serviceUsers.ServiceName].prefix)).toBe(true);
    }
  });

  it("matches a key freshly created for its service, and not a 63-letter tail, the other service's key or a session token", async () => {
    await createService('whatsapp');
    await createService('ansari-mcp');
    const wa = (await createKey('create-key', LIMIT_FLAGS, 'whatsapp')).key;
    const mcp = (await createKey('create-key', LIMIT_FLAGS, 'ansari-mcp')).key;
    const { whatsapp, 'ansari-mcp': amcp } = serviceUsers.SECRET_SCANNING_PATTERNS;
    const { rows } = await service.client.query<{ token: string }>('select token from auth.session limit 1');
    const sessionToken = rows[0]?.token ?? (await import('better-auth/crypto')).generateRandomString(32);
    expect(sessionToken).toHaveLength(32);

    const cases: [RegExp, string, boolean][] = [
      [whatsapp, wa, true],
      [amcp, mcp, true],
      [whatsapp, wa.slice(0, -1), false],
      [amcp, mcp.slice(0, -1), false],
      [whatsapp, mcp, false],
      [amcp, wa, false],
      [whatsapp, sessionToken, false],
      [amcp, sessionToken, false],
      [whatsapp, `ansari_wa_${sessionToken}`, false],
    ];
    const hits = cases.map(([pattern, candidate, expected]) => {
      expect(pattern.test(candidate), `${pattern.source} vs ${candidate.slice(0, 8)}…`).toBe(expected);
      return pattern.test(candidate);
    });
    expect(hits.filter(Boolean)).toHaveLength(2);
  });
});

describe('the durable record', () => {
  const envelopes: unknown[] = [];
  let transportFlushes: boolean;

  beforeAll(() => {
    Sentry.init({
      dsn: 'https://public@o0.ingest.sentry.io/0',
      defaultIntegrations: false,
      transport: () => ({
        send: async (envelope) => {
          envelopes.push(envelope);
          return {};
        },
        flush: async () => transportFlushes,
      }),
    });
  });
  afterAll(async () => {
    await Sentry.close();
  });
  beforeEach(() => {
    envelopes.length = 0;
    transportFlushes = true;
  });

  it('create, rotate, update-limits and revoke each send one Sentry event with no key material', async () => {
    const userId = await createService();
    envelopes.length = 0;
    const first = await run(['create-key', 'whatsapp', ...LIMIT_FLAGS, '--name', 'wa-1', '--confirm', userId], {
      recorder: sentryRecorder,
    });
    const key1 = first.lines.find((l) => l.startsWith('ansari_wa_'))!;
    const id1 = /Created key ([0-9a-f-]{36})/.exec(first.text)![1]!;
    const rotated = await run(['rotate', 'whatsapp', ...LIMIT_FLAGS, '--name', 'wa-2', '--confirm', userId], {
      recorder: sentryRecorder,
    });
    const key2 = rotated.lines.find((l) => l.startsWith('ansari_wa_'))!;
    const id2 = /Created key ([0-9a-f-]{36})/.exec(rotated.text)![1]!;
    await run(['update-limits', 'whatsapp', '--key', id2, ...LIMIT_FLAGS, '--confirm', id2], { recorder: sentryRecorder });
    await run(['revoke', 'whatsapp', '--key', id1, '--confirm', id1], { recorder: sentryRecorder });
    await run(['list', 'whatsapp'], { recorder: sentryRecorder });

    expect(envelopes).toHaveLength(4);
    const serialized = JSON.stringify(envelopes);
    expect(occurrences(serialized, KEY_EVENT_MESSAGE)).toBe(4);
    for (const [action, id, name] of [
      ['create-key', id1, 'wa-1'],
      ['rotate', id2, 'wa-2'],
      ['update-limits', id2, 'wa-2'],
      ['revoke', id1, 'wa-1'],
    ] as const) {
      const event = envelopes.map((e) => JSON.stringify(e)).find((e) => e.includes(`"action":"${action}"`));
      expect(event, action).toBeDefined();
      expect(event).toContain(id);
      expect(event).toContain(`"name":"${name}"`);
      expect(event).toContain('"service":"whatsapp"');
    }
    for (const key of [key1, key2]) {
      expect(serialized).not.toContain(key);
      expect(serialized).not.toContain(key.slice(3, 20));
    }
    for (const id of [id1, id2]) expect(serialized).not.toContain((await keyRow(id))!.key as string);
  });

  it('awaits the flush before it returns', async () => {
    await createService();
    let release!: (ok: boolean) => void;
    const recorder: Recorder = {
      capture: () => {},
      flush: () => new Promise<boolean>((resolve) => (release = resolve)),
    };
    let settled = false;
    const { id } = await createKey();
    const pending = run(['revoke', 'whatsapp', '--key', id, '--confirm', id], { recorder }).then((r) => {
      settled = true;
      return r;
    });
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    await new Promise((r) => setTimeout(r, 50));
    expect(settled).toBe(false);
    release(true);
    expect((await pending).exitCode).toBe(0);
  });

  it('a failed flush keeps the write, prints the key-log banner and exits non-zero', async () => {
    const userId = await createService();
    transportFlushes = false;
    const { exitCode, text, lines } = await run(['create-key', 'whatsapp', ...LIMIT_FLAGS, '--confirm', userId], {
      recorder: sentryRecorder,
      flushTimeoutMs: 200,
    });
    expect(exitCode).toBe(EXIT_UNRECORDED);
    expect(exitCode).not.toBe(0);
    expect(text).toMatch(/SENTRY RECORD OF THIS ACTION WAS NOT SENT/);
    expect(text).toMatch(/runbook's key log/);
    const id = /Created key ([0-9a-f-]{36})/.exec(text)![1]!;
    expect(text).toMatch(new RegExp(`action create-key, service whatsapp, user ${userId}, key ${id}`));
    // The write stands, and the key was still shown once (it is not stored anywhere else).
    expect(await keyRow(id)).toMatchObject({ enabled: true });
    const key = lines.find((l) => l.startsWith('ansari_wa_'))!;
    expect(occurrences(text, key)).toBe(1);
    expect((await verify(key)).valid).toBe(true);
  });

  it('a recorder that reports an unsent flush is a failure too', async () => {
    await createService();
    const recorder = memoryRecorder(false);
    const { id } = await createKey();
    const { exitCode, text } = await run(['revoke', 'whatsapp', '--key', id, '--confirm', id], { recorder });
    expect(recorder.flushes).toBe(1);
    expect(exitCode).toBe(EXIT_UNRECORDED);
    expect(text).toMatch(/NOT SENT/);
  });
});
