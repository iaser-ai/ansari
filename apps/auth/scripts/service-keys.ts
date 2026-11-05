/**
 * Service users and their API keys (spec 329). The api-key plugin's HTTP
 * surface is blocked, so this script is the only way to create a service user
 * or to issue, list, rotate, change or revoke its keys. It runs against the
 * AUTH database (`DATABASE_URL` in apps/auth's env) and needs apps/auth's full
 * env, since keys are created through Better Auth in process.
 *
 * Usage (from apps/auth/):
 *   tsx scripts/service-keys.ts create-service <service> [--confirm <service>]
 *   tsx scripts/service-keys.ts create-key <service> --rate-max <n> --rate-window <seconds> --daily <n>
 *                                          [--name <text>] [--client-id <text>] [--confirm <user id>]
 *   tsx scripts/service-keys.ts list <service>
 *   tsx scripts/service-keys.ts rotate <service> (the create-key flags)
 *   tsx scripts/service-keys.ts update-limits <service> --key <key id> --rate-max <n> --rate-window <seconds>
 *                                             --daily <n> [--confirm <key id>]
 *   tsx scripts/service-keys.ts revoke <service> --key <key id> [--confirm <key id>]
 *
 * Every write is two steps, as in grant-admin.ts: without `--confirm` the
 * script shows the service user and what it would do, writes nothing and
 * exits 2; only `--confirm <the id shown>` writes: the service user's id for
 * create-key and rotate, the KEY's id for update-limits and revoke (so a
 * confirm copied from another key's show step never writes), and the service
 * name for create-service, which has no user yet. A mismatch writes nothing
 * and exits 2. `--name` and `--client-id` take 1 to 64 letters, digits,
 * spaces, dots, underscores and hyphens, and never a key-shaped value: both
 * are printed by list and sent to Sentry.
 *
 * - It prints the database as `hostname:port` only, never the URL.
 * - Permissions and the key prefix are fixed per service (SERVICES); limits are
 *   required flags with no defaults, checked against limits.ts's bounds. The
 *   budget is daily and always refills: a budget without a refill deletes the
 *   key the first time it is exhausted. There is no expiry option: a key lives
 *   until it is rotated and revoked, as the runbook schedules.
 * - The raw key is printed once, by create-key or rotate; nothing else prints
 *   a key or a hash. Revoke sets `enabled = false` and keeps the row.
 * - Every write sends one Sentry event (action, service, ids, name; no key
 *   material). If it cannot be flushed, or `SENTRY_DSN` is not set (nothing is
 *   attempted then), the write stands, a banner asks for the runbook's key
 *   log, and the script exits 3.
 */
import 'dotenv/config';
import * as Sentry from '@sentry/node';

import {
  createAuth,
  createDb,
  getEnv,
  limits,
  serviceAddress,
  serviceUsers,
  type Auth,
  type Db,
} from '@ansari/auth';

import { urlHostPort } from './url-host';

type ServiceName = serviceUsers.ServiceName;
type KeyLimits = limits.KeyLimits;

type KeyFlags = { limits: KeyLimits; name: string | null; clientId: string | null };

export type ServiceKeysCommand =
  | { kind: 'create-service'; service: ServiceName; confirm: string | null }
  | ({ kind: 'create-key'; service: ServiceName; confirm: string | null } & KeyFlags)
  | ({ kind: 'rotate'; service: ServiceName; confirm: string | null } & KeyFlags)
  | { kind: 'list'; service: ServiceName }
  | { kind: 'update-limits'; service: ServiceName; keyId: string; limits: KeyLimits; confirm: string | null }
  | { kind: 'revoke'; service: ServiceName; keyId: string; confirm: string | null };

export const USAGE = [
  'Usage: tsx scripts/service-keys.ts create-service <service> [--confirm <service>]',
  '       tsx scripts/service-keys.ts create-key <service> --rate-max <n> --rate-window <seconds> --daily <n> [--name <text>] [--client-id <text>] [--confirm <user id>]',
  '       tsx scripts/service-keys.ts list <service>',
  '       tsx scripts/service-keys.ts rotate <service> --rate-max <n> --rate-window <seconds> --daily <n> [--name <text>] [--client-id <text>] [--confirm <user id>]',
  '       tsx scripts/service-keys.ts update-limits <service> --key <key id> --rate-max <n> --rate-window <seconds> --daily <n> [--confirm <key id>]',
  '       tsx scripts/service-keys.ts revoke <service> --key <key id> [--confirm <key id>]',
  `Services: ${Object.keys(serviceUsers.SERVICES).join(', ')}`,
].join('\n');

/** The exit code of a run that wrote nothing on purpose (show step, confirm mismatch). */
export const EXIT_NOTHING_WRITTEN = 2;
/** The exit code of a write whose Sentry record could not be sent. */
export const EXIT_UNRECORDED = 3;

/** How long the script waits for Sentry before it prints the key-log banner. */
export const SENTRY_FLUSH_TIMEOUT_MS = 5_000;

const SECOND_MS = 1000;

/** A refused input or state. Its message is the script's own words, safe to print. */
export class RefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RefusedError';
  }
}

const NO_EXPIRY =
  'Keys have no expiry option: a production key must not die silently. Rotate and revoke it as the runbook schedules.';
const NO_BARE_BUDGET =
  'A budget without a refill deletes the key the first time it is exhausted. Use --daily, which always refills every 24 h.';

const FLAGS_BY_KIND: Record<ServiceKeysCommand['kind'], readonly string[]> = {
  'create-service': ['--confirm'],
  'create-key': ['--rate-max', '--rate-window', '--daily', '--name', '--client-id', '--confirm'],
  rotate: ['--rate-max', '--rate-window', '--daily', '--name', '--client-id', '--confirm'],
  list: [],
  'update-limits': ['--key', '--rate-max', '--rate-window', '--daily', '--confirm'],
  revoke: ['--key', '--confirm'],
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const isKind = (value: string | undefined): value is ServiceKeysCommand['kind'] =>
  value !== undefined && Object.hasOwn(FLAGS_BY_KIND, value);

function positiveInteger(flag: string, value: string): number {
  const n = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(n)) {
    throw new RefusedError(`${flag} must be a whole number.`);
  }
  return n;
}

/**
 * The limits a key gets from its flags, all three required. The window is
 * given in seconds and stored in milliseconds; the budget always refills daily.
 */
function limitsFrom(flags: Map<string, string>): KeyLimits {
  const missing = ['--rate-max', '--rate-window', '--daily'].filter((f) => !flags.has(f));
  if (missing.length > 0) {
    throw new RefusedError(`Limits have no defaults; missing ${missing.join(', ')}.`);
  }
  return {
    rateLimitMax: positiveInteger('--rate-max', flags.get('--rate-max')!),
    rateLimitTimeWindow: positiveInteger('--rate-window', flags.get('--rate-window')!) * SECOND_MS,
    refillAmount: positiveInteger('--daily', flags.get('--daily')!),
    refillInterval: limits.KEY_REFILL_INTERVAL,
  };
}

/** Parses the command line; throws RefusedError with the reason when it is not a valid command. */
/** A key name or client id: printed by list and sent to Sentry, so a bounded, inert charset. */
const LABEL = /^[A-Za-z0-9 ._-]{1,64}$/;

/**
 * `--name` / `--client-id`, refused unless inert. A raw key pasted into the
 * wrong flag would be printed by list and sent to Sentry, so anything that
 * holds a service's key prefix, or a run of 32 letters (a key body), is refused.
 * The value is never echoed back.
 */
function label(flag: string, value: string | undefined): string | null {
  if (value === undefined) return null;
  if (!LABEL.test(value)) {
    throw new RefusedError(`${flag} takes 1 to 64 letters, digits, spaces, dots, underscores and hyphens.`);
  }
  const lower = value.toLowerCase();
  const keyShaped =
    Object.values(serviceUsers.SERVICES).some((s) => lower.includes(s.prefix)) ||
    Object.values(serviceUsers.SECRET_SCANNING_PATTERNS).some((p) => new RegExp(p.source).test(value)) ||
    // A key's 64-letter body pasted without its prefix.
    /[A-Za-z]{32}/.test(value);
  if (keyShaped) throw new RefusedError(`${flag} looks like a key. Never paste a key into a flag; nothing was written.`);
  return value;
}

export function parseArgs(argv: readonly string[]): ServiceKeysCommand {
  const [kind, service, ...rest] = argv;
  if (!isKind(kind) || service === undefined || service.startsWith('--')) throw new RefusedError(USAGE);
  if (!serviceUsers.isServiceName(service)) {
    throw new RefusedError(`Unknown service "${service}". Services: ${Object.keys(serviceUsers.SERVICES).join(', ')}.`);
  }
  const flags = new Map<string, string>();
  for (let i = 0; i < rest.length; i += 2) {
    const [flag = '', value] = [rest[i], rest[i + 1]];
    if (/^--expir/.test(flag)) throw new RefusedError(NO_EXPIRY);
    if (flag === '--remaining') throw new RefusedError(NO_BARE_BUDGET);
    if (!FLAGS_BY_KIND[kind].includes(flag)) throw new RefusedError(`${flag} is not an option of ${kind}.\n${USAGE}`);
    if (flags.has(flag)) throw new RefusedError(`${flag} is given twice.`);
    if (value === undefined || value.length === 0 || value.startsWith('--')) {
      throw new RefusedError(`${flag} needs a value.`);
    }
    flags.set(flag, value);
  }
  const confirm = flags.get('--confirm') ?? null;
  const keyId = (): string => {
    const id = flags.get('--key');
    if (id === undefined) throw new RefusedError(`${kind} needs --key <key id> (see list).`);
    if (!UUID.test(id)) throw new RefusedError('--key must be a key id as list prints it.');
    return id.toLowerCase();
  };
  switch (kind) {
    case 'create-service':
      return { kind, service, confirm };
    case 'list':
      return { kind, service };
    case 'create-key':
    case 'rotate':
      return {
        kind,
        service,
        confirm,
        limits: limitsFrom(flags),
        name: label('--name', flags.get('--name')),
        clientId: label('--client-id', flags.get('--client-id')),
      };
    case 'update-limits':
      return { kind, service, keyId: keyId(), limits: limitsFrom(flags), confirm };
    case 'revoke':
      return { kind, service, keyId: keyId(), confirm };
  }
}

/**
 * The last check before the plugin is called: inside the service's bounds,
 * and a budget only with its daily refill. A key whose `remaining` has no
 * refill is deleted by the plugin on exhaustion.
 */
export function checkKeyLimits(service: ServiceName, values: Partial<KeyLimits>): KeyLimits {
  const { rateLimitMax, rateLimitTimeWindow, refillAmount, refillInterval } = values;
  if (refillAmount === undefined || refillInterval !== limits.KEY_REFILL_INTERVAL) {
    throw new RefusedError(NO_BARE_BUDGET);
  }
  if (rateLimitMax === undefined || rateLimitTimeWindow === undefined) {
    throw new RefusedError('A key needs a rate limit: --rate-max and --rate-window.');
  }
  const bounds = serviceUsers.SERVICES[service].bounds;
  const outside = (value: number, b: { min: number; max: number }) => value < b.min || value > b.max;
  const problems = [
    outside(rateLimitMax, bounds.rateLimitMax) &&
      `--rate-max must be ${bounds.rateLimitMax.min} to ${bounds.rateLimitMax.max}`,
    outside(rateLimitTimeWindow, bounds.rateLimitTimeWindow) &&
      `--rate-window must be ${bounds.rateLimitTimeWindow.min / SECOND_MS} to ${bounds.rateLimitTimeWindow.max / SECOND_MS} seconds`,
    outside(refillAmount, bounds.refillAmount) &&
      `--daily must be ${bounds.refillAmount.min} to ${bounds.refillAmount.max}`,
  ].filter((p): p is string => typeof p === 'string');
  if (problems.length > 0) throw new RefusedError(`Out of bounds (limits.ts): ${problems.join('; ')}.`);
  return { rateLimitMax, rateLimitTimeWindow, refillAmount, refillInterval };
}

/** One durable record of a write: never key material. */
export type KeyEvent = {
  action: Exclude<ServiceKeysCommand['kind'], 'list'>;
  service: ServiceName;
  userId: string;
  keyId: string | null;
  name: string | null;
};

export type ScriptResult = { lines: string[]; exitCode: number; events: KeyEvent[] };

export type ScriptContext = { db: Db; auth: Auth; now?: Date };

const describeLimits = (l: {
  rateLimitMax: number | null;
  rateLimitTimeWindow: number | null;
  refillAmount: number | null;
  refillInterval: number | null;
}) =>
  `${l.rateLimitMax} per ${(l.rateLimitTimeWindow ?? 0) / SECOND_MS} s; ` +
  `budget ${l.refillAmount} per ${(l.refillInterval ?? 0) / 3_600_000} h`;

const iso = (d: Date | null) => (d ? d.toISOString() : 'never');

function keyLines(key: serviceUsers.ServiceKey): string[] {
  return [
    `  key ${key.id}`,
    `    name          ${key.name ?? ''}`,
    `    prefix        ${key.prefix ?? ''}`,
    `    permissions   ${key.permissions ?? ''}`,
    `    enabled       ${key.enabled}`,
    `    limits        ${describeLimits(key)}; remaining ${key.remaining}`,
    `    created       ${iso(key.createdAt)}`,
    `    last request  ${iso(key.lastRequest)}`,
  ];
}

const command = (argv: string) => `  tsx scripts/service-keys.ts ${argv}`;

/** The service user every key command acts for; refuses none and many. */
async function serviceUser(db: Db, service: ServiceName): Promise<serviceUsers.ServiceUser> {
  const found = await serviceUsers.findServiceUser(db, service);
  if (found.kind === 'none') {
    throw new RefusedError(`No service user for "${service}". Create it first: create-service ${service}.`);
  }
  if (found.kind === 'many') {
    throw new RefusedError(
      `${found.ids.length} users claim service "${service}" (${found.ids.join(', ')}); refusing to act. Resolve this by hand.`
    );
  }
  return found.user;
}

const userLines = (service: ServiceName, user: serviceUsers.ServiceUser) => [
  `Service user for ${service}:`,
  `  id          ${user.id}`,
  `  email       ${user.email}`,
  `  created_at  ${user.createdAt.toISOString()}`,
];

const nothingWritten = (lines: string[]): ScriptResult => ({ lines, exitCode: EXIT_NOTHING_WRITTEN, events: [] });

const mismatch = (expected: string): ScriptResult =>
  nothingWritten([
    `The --confirm value is not ${expected}. Nothing was written. Run without --confirm to see it.`,
  ]);

/** Key flags in the form a show step tells the operator to rerun. */
const flagsText = (l: KeyLimits) =>
  `--rate-max ${l.rateLimitMax} --rate-window ${l.rateLimitTimeWindow / SECOND_MS} --daily ${l.refillAmount}`;

const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

async function createKey(
  ctx: ScriptContext,
  service: ServiceName,
  userId: string,
  flags: KeyFlags
): Promise<{ id: string; key: string; name: string }> {
  const checked = checkKeyLimits(service, flags.limits);
  const { permissions, prefix } = serviceUsers.SERVICES[service];
  // Default name: the service and the minute it was created, so a rotation's two keys differ.
  const name = flags.name ?? `${service} ${(ctx.now ?? new Date()).toISOString().slice(0, 16)}Z`;
  const created = await ctx.auth.api.createApiKey({
    body: {
      userId,
      prefix,
      name,
      permissions: Object.fromEntries(Object.entries(permissions).map(([k, v]) => [k, [...v]])),
      metadata: { clientId: flags.clientId ?? service },
      rateLimitEnabled: true,
      rateLimitTimeWindow: checked.rateLimitTimeWindow,
      rateLimitMax: checked.rateLimitMax,
      remaining: checked.refillAmount,
      refillAmount: checked.refillAmount,
      refillInterval: checked.refillInterval,
    },
  });
  return { id: created.id, key: created.key, name };
}

/** The new key, framed so the operator sees it is shown once and where it goes. */
const rawKeyLines = (key: string) => [
  '================ NEW KEY: SHOWN ONCE, NEVER STORED ================',
  key,
  "Put it in the service's credential store now, as the runbook says. It cannot be shown again.",
  '===================================================================',
];

async function ownedKey(db: Db, userId: string, keyId: string): Promise<serviceUsers.ServiceKey> {
  const key = (await serviceUsers.listServiceKeys(db, userId)).find((k) => k.id === keyId);
  if (!key) throw new RefusedError(`Key ${keyId} is not a key of this service (see list).`);
  return key;
}

/** Runs one command and returns the lines to print, the exit code and the events to record. */
export async function runServiceKeys(ctx: ScriptContext, cmd: ServiceKeysCommand): Promise<ScriptResult> {
  const { db } = ctx;
  if (cmd.kind === 'create-service') {
    const found = await serviceUsers.findServiceUser(db, cmd.service);
    if (found.kind !== 'none') {
      throw new RefusedError(`Service "${cmd.service}" already has a service user; nothing was written.`);
    }
    if (cmd.confirm === null) {
      return nothingWritten([
        `No service user for ${cmd.service}. This would create:`,
        `  email       ${serviceAddress(cmd.service)} (no credential, role user)`,
        `  account     provider service, account id ${cmd.service}`,
        'Nothing was written. To create it, run:',
        command(`create-service ${cmd.service} --confirm ${cmd.service}`),
      ]);
    }
    if (cmd.confirm !== cmd.service) return mismatch(`the service name (${cmd.service})`);
    const user = await serviceUsers.createServiceUser(db, cmd.service);
    return {
      lines: [`Created service user ${user.id} (${user.email}) for ${cmd.service}.`],
      exitCode: 0,
      events: [{ action: cmd.kind, service: cmd.service, userId: user.id, keyId: null, name: null }],
    };
  }

  const user = await serviceUser(db, cmd.service);
  const keys = await serviceUsers.listServiceKeys(db, user.id);

  if (cmd.kind === 'list') {
    return {
      lines: [...userLines(cmd.service, user), `${keys.length} key(s):`, ...keys.flatMap(keyLines)],
      exitCode: 0,
      events: [],
    };
  }

  if (cmd.kind === 'create-key' || cmd.kind === 'rotate') {
    checkKeyLimits(cmd.service, cmd.limits);
    const live = keys.filter((k) => k.enabled);
    if (cmd.kind === 'rotate' && live.length === 0) {
      throw new RefusedError(`Service "${cmd.service}" has no live key to rotate; use create-key.`);
    }
    const extra = [cmd.name && `--name ${quote(cmd.name)}`, cmd.clientId && `--client-id ${quote(cmd.clientId)}`]
      .filter(Boolean)
      .join(' ');
    if (cmd.confirm === null) {
      return nothingWritten([
        ...userLines(cmd.service, user),
        `${live.length} live key(s): ${live.map((k) => k.id).join(', ') || 'none'}`,
        `This would create a key with ${describeLimits(cmd.limits)}.`,
        'Nothing was written. If this is the service you mean, run:',
        command(`${cmd.kind} ${cmd.service} ${flagsText(cmd.limits)}${extra ? ` ${extra}` : ''} --confirm ${user.id}`),
      ]);
    }
    if (cmd.confirm !== user.id) return mismatch(`this service user's id`);
    const created = await createKey(ctx, cmd.service, user.id, cmd);
    const rotated =
      cmd.kind === 'rotate'
        ? [
            `Old live key(s): ${live.map((k) => k.id).join(', ')}`,
            'Once the consumer runs on the new key, revoke each old one:',
            ...live.map((k) => command(`revoke ${cmd.service} --key ${k.id} --confirm ${k.id}`)),
            'Until then both keys are live and the daily budget is doubled; keep the overlap short.',
          ]
        : [];
    return {
      lines: [
        `Created key ${created.id} (${created.name}) for ${cmd.service}: ${describeLimits(cmd.limits)}.`,
        ...rawKeyLines(created.key),
        ...rotated,
      ],
      exitCode: 0,
      events: [{ action: cmd.kind, service: cmd.service, userId: user.id, keyId: created.id, name: created.name }],
    };
  }

  const key = await ownedKey(db, user.id, cmd.keyId);
  if (cmd.kind === 'update-limits') {
    const checked = checkKeyLimits(cmd.service, cmd.limits);
    if (cmd.confirm === null) {
      return nothingWritten([
        ...userLines(cmd.service, user),
        ...keyLines(key),
        `This would set ${describeLimits(checked)}, and today's remaining budget to ${checked.refillAmount}.`,
        'Nothing was written. To apply it, run:',
        command(`update-limits ${cmd.service} --key ${key.id} ${flagsText(checked)} --confirm ${key.id}`),
      ]);
    }
    if (cmd.confirm !== key.id) return mismatch(`this key's id`);
    // The new budget starts now: `remaining` is set to it with the refill.
    await ctx.auth.api.updateApiKey({
      body: { keyId: key.id, userId: user.id, ...checked, remaining: checked.refillAmount },
    });
    return {
      lines: [`Updated key ${key.id} (${key.name ?? ''}): ${describeLimits(checked)}.`],
      exitCode: 0,
      events: [{ action: cmd.kind, service: cmd.service, userId: user.id, keyId: key.id, name: key.name }],
    };
  }

  if (cmd.confirm === null) {
    return nothingWritten([
      ...userLines(cmd.service, user),
      ...keyLines(key),
      'This would revoke the key (enabled = false; the row is kept).',
      'Nothing was written. To revoke it, run:',
      command(`revoke ${cmd.service} --key ${key.id} --confirm ${key.id}`),
    ]);
  }
  if (cmd.confirm !== key.id) return mismatch(`this key's id`);
  await ctx.auth.api.updateApiKey({ body: { keyId: key.id, userId: user.id, enabled: false } });
  return {
    lines: [`Revoked key ${key.id} (${key.name ?? ''}): enabled = false; the row is kept.`],
    exitCode: 0,
    events: [{ action: cmd.kind, service: cmd.service, userId: user.id, keyId: key.id, name: key.name }],
  };
}

/** Where the durable record goes: Sentry in the script, a spy transport in tests. */
export type Recorder = {
  capture: (event: KeyEvent) => void;
  /** True when every captured event was sent within the timeout. */
  flush: (timeoutMs: number) => Promise<boolean>;
  /** Why nothing can be recorded, when that is known up front (printed in the banner). */
  reason?: string;
};

export const KEY_EVENT_MESSAGE = 'auth: service key operator action';

export const sentryRecorder: Recorder = {
  capture(event) {
    Sentry.captureMessage(KEY_EVENT_MESSAGE, {
      level: 'info',
      tags: { alert: 'auth-service-key', action: event.action, service: event.service },
      extra: { ...event },
    });
  },
  async flush(timeoutMs) {
    try {
      return await Sentry.flush(timeoutMs);
    } catch {
      return false;
    }
  },
};

/**
 * No `SENTRY_DSN`: nothing is captured or flushed, on purpose, and every
 * write takes the unrecorded path (banner, key log, exit 3). It does not rely
 * on an uninitialised Sentry's flush happening to answer false.
 */
export const unrecordedRecorder: Recorder = {
  capture() {},
  flush: async () => false,
  reason: 'SENTRY_DSN is not set: no record was attempted.',
};

/** The script's recorder: Sentry when a DSN is set (initialised here), otherwise none. */
export function scriptRecorder(dsn: string | undefined): Recorder {
  if (!dsn) return unrecordedRecorder;
  Sentry.init({ dsn, environment: process.env.NODE_ENV ?? 'development', ...SCRIPT_SENTRY_OPTIONS });
  return sentryRecorder;
}

function unrecordedBanner(events: KeyEvent[], reason: string | undefined): string[] {
  const bar = '!'.repeat(72);
  return [
    bar,
    '!! THE SENTRY RECORD OF THIS ACTION WAS NOT SENT. THE WRITE ABOVE STANDS.',
    ...(reason ? [`!! ${reason}`] : []),
    "!! Record it by hand in the runbook's key log now:",
    ...events.map(
      (e) => `!!   action ${e.action}, service ${e.service}, user ${e.userId}, key ${e.keyId ?? '-'}, name ${e.name ?? '-'}`
    ),
    bar,
  ];
}

/** A refusal is reported in full; anything else by its name only (no driver detail, no key). */
export function scriptError(err: unknown): string {
  if (err instanceof RefusedError) return err.message;
  return err instanceof Error ? err.name : 'unknown';
}

export type ScriptDeps = {
  databaseUrl: string | undefined;
  connect: () => ScriptContext;
  recorder: Recorder;
  /** Prints one line at once (console.log in the script). */
  print: (line: string) => void;
  flushTimeoutMs?: number;
};

/**
 * The whole script: database URL check, parse, `hostname:port`, run, and the
 * durable record. Each line is printed as it is produced, so the database
 * host is on the operator's screen before anything connects or writes.
 * Returns every printed line and the exit code.
 */
export async function serviceKeys(argv: readonly string[], deps: ScriptDeps): Promise<{ lines: string[]; exitCode: number }> {
  const lines: string[] = [];
  const emit = (...out: string[]) => {
    for (const line of out) {
      lines.push(line);
      deps.print(line);
    }
  };
  if (!deps.databaseUrl) {
    emit('DATABASE_URL is not set (the AUTH database). Refusing to run.');
    return { lines, exitCode: 1 };
  }
  const host = urlHostPort(deps.databaseUrl);
  if (host === null) {
    emit('DATABASE_URL does not parse as a URL. Refusing to run.');
    return { lines, exitCode: 1 };
  }
  emit(`Auth database: ${host}`);
  let result: ScriptResult;
  try {
    const cmd = parseArgs(argv);
    result = await runServiceKeys(deps.connect(), cmd);
  } catch (err) {
    emit(`service-keys refused: ${scriptError(err)}`);
    return { lines, exitCode: 1 };
  }
  emit(...result.lines);
  if (result.events.length === 0) return { lines, exitCode: result.exitCode };
  for (const event of result.events) deps.recorder.capture(event);
  if (await deps.recorder.flush(deps.flushTimeoutMs ?? SENTRY_FLUSH_TIMEOUT_MS)) {
    return { lines, exitCode: result.exitCode };
  }
  emit(...unrecordedBanner(result.events, deps.recorder.reason));
  return { lines, exitCode: EXIT_UNRECORDED };
}

/**
 * Sentry options for this script. Breadcrumbs are off: with Sentry's default
 * Console integration every console line becomes a breadcrumb on the next
 * event, and the line before the operator event is the raw key. There is no
 * `beforeSend` (unlike `SERVICE_SENTRY_OPTIONS`): a CLI handles no HTTP
 * request, so no request data is attached to its events.
 */
export const SCRIPT_SENTRY_OPTIONS = {
  sendDefaultPii: false,
  maxBreadcrumbs: 0,
  beforeBreadcrumb: () => null,
} as const;

/**
 * The script's printer: straight to stdout, not through `console`, which
 * Sentry instruments. Breadcrumbs are off as well; either alone keeps the key
 * out of an event.
 */
export function printLine(line: string): void {
  process.stdout.write(`${line}\n`);
}

async function main(): Promise<void> {
  const recorder = scriptRecorder(process.env.SENTRY_DSN);
  const { exitCode } = await serviceKeys(process.argv.slice(2), {
    databaseUrl: process.env.DATABASE_URL,
    connect: () => {
      try {
        getEnv();
      } catch (err) {
        // Names the missing variables, never a value.
        throw new RefusedError(err instanceof Error ? err.message : 'apps/auth env is incomplete');
      }
      const db = createDb();
      return { db, auth: createAuth(db) };
    },
    recorder,
    print: printLine,
  });
  process.exit(exitCode);
}

if (process.argv[1]?.endsWith('service-keys.ts')) {
  main().catch((err: unknown) => {
    console.error('service-keys failed:', scriptError(err));
    process.exit(1);
  });
}
