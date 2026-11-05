// The cutover copy (plan phase 12), run as the REAL scripts in
// apps/auth/scripts/cutover against two pglite databases: the APP database
// built from apps/api's journal (through 0010: the copy runs before the
// window migration 0011) and the AUTH database from packages/auth's. The pipe
// 01 | 02 is emulated by handing 01's stdout to 02's stdin (./psql.ts). The
// real psql pipe and copy.sh run in the phase 13 rehearsal.
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { PGlite } from '@electric-sql/pglite';
import { createAuth, users } from '@ansari/auth';
import bcrypt from 'bcrypt';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  drizzleFor,
  emptyDatabase,
  migrate,
  setAuthEnv,
} from '../../../../packages/auth/tests/helpers/auth-db';
import {
  ID_PREFIX,
  ROWS,
  anomalySql,
  isForwarderHost,
  makeHashes,
  refusal,
} from '../../scripts/cutover/rehearsal-anomalies';
import { urlHost } from '../../scripts/url-host';
import { runPsqlFile } from './psql';
// @ts-expect-error: a plain .mjs operator script, no type declarations
import { baselineSql, migrations } from '../../scripts/cutover/auth-journal.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = resolve(here, '../../scripts/cutover');
const APP_DRIZZLE = resolve(here, '../../../api/drizzle');
const script = (name: string) => resolve(SCRIPTS, name);

const PASSWORD = 'Legacy-pass-123!';
let bcryptHash: string;

/** The app database as the window finds it: apps/api's journal through 0010. */
async function appDatabase(): Promise<PGlite> {
  const client = emptyDatabase();
  const entries = (
    JSON.parse(readFileSync(`${APP_DRIZZLE}/meta/_journal.json`, 'utf8')) as {
      entries: { idx: number; tag: string }[];
    }
  ).entries.sort((a, b) => a.idx - b.idx);
  for (const { tag } of entries) {
    if (tag.startsWith('0011')) break;
    for (const stmt of readFileSync(`${APP_DRIZZLE}/${tag}.sql`, 'utf8').split('--> statement-breakpoint')) {
      if (stmt.trim()) await client.exec(stmt);
    }
  }
  return client;
}

type LegacyRow = {
  id: string;
  email: string;
  hash?: string;
  first?: string | null;
  last?: string | null;
  via?: string | null;
  created?: string;
  updated?: string;
  admin?: boolean;
  systemKey?: string;
};

async function seed(app: PGlite, rows: LegacyRow[]): Promise<void> {
  for (const r of rows) {
    await app.query(
      `INSERT INTO users (id, email, password_hash, first_name, last_name, registered_via, created_at, updated_at, is_admin, system_key)
       VALUES ($1, $2, $3, $4, $5, $6, coalesce($7::timestamptz, now()), coalesce($8::timestamptz, now()), $9, $10)`,
      [
        r.id,
        r.email,
        r.hash ?? bcryptHash,
        r.first ?? null,
        r.last ?? null,
        r.via ?? null,
        r.created ?? null,
        r.updated ?? null,
        r.admin ?? false,
        r.systemKey ?? null,
      ]
    );
  }
}

/** The count copy.sh passes to 02 as expected_rows. */
async function expectedRows(app: PGlite): Promise<string> {
  const [n] = (await runPsqlFile(app, script('01-count-app.sql'))).stdout;
  return n as string;
}

/** 01 | 02, as copy.sh runs them. */
async function copy(app: PGlite, auth: PGlite) {
  const expected_rows = await expectedRows(app);
  const exported = await runPsqlFile(app, script('01-export-app.sql'));
  return runPsqlFile(auth, script('02-import-auth.sql'), {
    stdin: exported.stdout.join(''),
    vars: { expected_rows },
  });
}

async function audits(app: PGlite, auth: PGlite) {
  return {
    app: (await runPsqlFile(app, script('03-audit-app.sql'))).stdout,
    auth: (await runPsqlFile(auth, script('03-audit-auth.sql'))).stdout,
  };
}

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const count = async (db: PGlite, sql: string) =>
  Number((await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${sql}`)).rows[0]?.n);

/** A query from the preflight, by the heading of its section. */
function preflightQuery(heading: string): string {
  const sql = readFileSync(script('00-preflight-app.sql'), 'utf8');
  const section = sql.slice(sql.indexOf(heading));
  const start = section.indexOf('SELECT');
  return section.slice(start, section.indexOf(';', start) + 1);
}

let app: PGlite;
let auth: PGlite;

// This hook's own deadline, above the config's 30 s (#292's value). Two
// pglite cold starts (the app and auth journals) took 27-53 s when the whole
// monorepo's tests ran at once on a shared machine (measured for spec 329; the
// #290/#292/#301 class). 100 s is about twice the observed maximum.
const SETUP_DEADLINE_MS = 100_000;

beforeEach(async () => {
  bcryptHash ??= await bcrypt.hash(PASSWORD, 4);
  app = await appDatabase();
  auth = await migrate();
}, SETUP_DEADLINE_MS);

afterEach(async () => {
  await app?.close();
  await auth?.close();
});

describe('the copy and the audits', () => {
  it('copies every non-system user with the same id, and the audits match', async () => {
    await seed(app, [
      { id: id(1), email: 'a@example.com', first: 'Amina', last: 'Yusuf', via: 'askansari-web' },
      { id: id(2), email: 'b@example.com' },
      { id: id(3), email: 'ai-skill@system.ansari.chat', hash: 'nologin', systemKey: 'ai-skill' },
    ]);
    const run = await copy(app, auth);
    expect(run.echo).toContain('cutover copy: committed');
    const { app: a, auth: b } = await audits(app, auth);
    expect(b).toEqual(a);
    expect(a).toContain('rows|2');
    expect(a).toContain('credentials|2');
    expect(a).toContain('system_domain_rows|0');
    const copied = await auth.query<{ id: string; registered_via: string | null; role: string }>(
      'SELECT id, registered_via, role FROM auth.users ORDER BY id'
    );
    expect(copied.rows).toEqual([
      { id: id(1), registered_via: 'askansari-web', role: 'user' },
      { id: id(2), registered_via: null, role: 'user' },
    ]);
  });

  it('scenario 20: system rows are never copied', async () => {
    await seed(app, [
      { id: id(1), email: 'a@example.com' },
      { id: id(3), email: 'ai-skill@system.ansari.chat', hash: 'nologin', systemKey: 'ai-skill' },
      { id: id(4), email: 'leaderboard@system.ansari.chat', hash: 'nologin', systemKey: 'leaderboard' },
    ]);
    await copy(app, auth);
    expect(await count(auth, `auth.users WHERE email LIKE '%@system.ansari.chat'`)).toBe(0);
    expect(await count(auth, `auth.users WHERE id IN ('${id(3)}', '${id(4)}')`)).toBe(0);
  });

  it('scenario 12: timestamps survive exactly (microseconds, a DST boundary)', async () => {
    await seed(app, [
      {
        id: id(1),
        email: 'a@example.com',
        created: '2026-03-29 01:59:59.123456+00',
        updated: '2026-10-25 00:59:59.999999+00',
      },
    ]);
    await copy(app, auth);
    const [appRow] = (await app.query<{ c: string; u: string }>(`SELECT created_at::text AS c, updated_at::text AS u FROM users WHERE id = '${id(1)}'`)).rows;
    const [userRow] = (await auth.query<{ c: string; u: string }>(`SELECT created_at::text AS c, updated_at::text AS u FROM auth.users WHERE id = '${id(1)}'`)).rows;
    const [accountRow] = (await auth.query<{ c: string; u: string }>(`SELECT created_at::text AS c, updated_at::text AS u FROM auth.account WHERE user_id = '${id(1)}'`)).rows;
    expect(userRow).toEqual(appRow);
    expect(accountRow).toEqual(appRow);
    expect(appRow?.c).toContain('.123456');
  });

  it.each([
    ['created_at', 'UPDATE users SET created_at = NULL'],
    ['updated_at', 'UPDATE users SET updated_at = NULL'],
  ])('a NULL %s aborts the copy with no changes (timestamps are copied exactly, never invented)', async (_col, sql) => {
    await seed(app, [
      { id: id(1), email: 'a@example.com' },
      { id: id(2), email: 'b@example.com' },
    ]);
    await app.exec(`${sql} WHERE id = '${id(2)}'`);
    await expect(copy(app, auth)).rejects.toThrow(/1 row\(s\) have a NULL created_at or updated_at/);
    expect(await count(auth, 'auth.users')).toBe(0);
    expect(await count(auth, 'auth.account')).toBe(0);
  });

  it('scenario 7: the derived name (names, local part, or "User"); first and last copy as stored', async () => {
    await seed(app, [
      { id: id(1), email: 'a@example.com', first: ' Amina ', last: 'Yusuf' },
      { id: id(2), email: 'first-only@example.com', first: 'Amina' },
      { id: id(3), email: 'nonames@example.com' },
      { id: id(4), email: '@example.com' },
    ]);
    await copy(app, auth);
    const rows = (await auth.query<{ id: string; name: string; first_name: string | null; last_name: string | null }>(
      'SELECT id, name, first_name, last_name FROM auth.users ORDER BY id'
    )).rows;
    expect(rows).toEqual([
      { id: id(1), name: 'Amina  Yusuf', first_name: ' Amina ', last_name: 'Yusuf' },
      { id: id(2), name: 'Amina', first_name: 'Amina', last_name: null },
      { id: id(3), name: 'nonames', first_name: null, last_name: null },
      { id: id(4), name: 'User', first_name: null, last_name: null },
    ]);
  });

  it('the SQL name rule matches deriveName in packages/auth (the sign-up hook)', async () => {
    const { deriveName } = await import('../../../../packages/auth/src/name');
    const cases: [string | null, string | null, string][] = [
      [' Amina ', 'Yusuf', 'a@example.com'],
      ['Amina', null, 'b@example.com'],
      [null, null, 'local.part@example.com'],
      ['  ', '\t', 'tabs@example.com'],
      [null, null, '@example.com'],
    ];
    await seed(
      app,
      cases.map(([first, last, email], i) => ({ id: id(i + 1), email, first, last }))
    );
    await copy(app, auth);
    const names = (await auth.query<{ name: string }>('SELECT name FROM auth.users ORDER BY id')).rows.map((r) => r.name);
    expect(names).toEqual(cases.map(([first, last, email]) => deriveName(first, last, email)));
  });

  it('scenario 9i: every copied user is email_verified, and nothing is mailed', async () => {
    await seed(app, [
      { id: id(1), email: 'a@example.com' },
      { id: id(2), email: 'b@example.com' },
    ]);
    await copy(app, auth);
    expect(await count(auth, 'auth.users WHERE email_verified IS NOT TRUE')).toBe(0);
    expect(await count(auth, 'auth.verification')).toBe(0);
  });

  it('scenario 13: a mixed-case, padded email is normalized, and signs in through createAuth with its legacy password', async () => {
    await seed(app, [{ id: id(1), email: '  Alice@Example.COM ' }]);
    await copy(app, auth);
    expect((await auth.query<{ email: string }>('SELECT email FROM auth.users')).rows).toEqual([
      { email: 'alice@example.com' },
    ]);
    setAuthEnv('http://localhost:3100');
    const service = createAuth(drizzleFor(auth));
    const result = await service.api.signInEmail({
      body: { email: 'ALICE@example.com', password: PASSWORD },
    });
    expect(result.user.id).toBe(id(1));
  });

  it('scenario 14: two rows that normalize to one email abort the copy, with no changes', async () => {
    await seed(app, [
      { id: id(1), email: 'Bob@x.com' },
      { id: id(2), email: 'bob@x.com' },
    ]);
    await expect(copy(app, auth)).rejects.toThrow(/1 normalized email\(s\) are held by more than one row/);
    expect(await count(auth, 'auth.users')).toBe(0);
    expect(await count(auth, 'auth.account')).toBe(0);
  });

  it('the collision error names a count, never an address', async () => {
    await seed(app, [
      { id: id(1), email: 'Bob@x.com' },
      { id: id(2), email: 'bob@x.com' },
    ]);
    const error = await copy(app, auth).catch((e: unknown) => e);
    expect(String(error)).not.toMatch(/bob@x\.com/i);
  });

  it('scenario 10: against a non-empty auth.users the copy aborts with no changes', async () => {
    await seed(app, [{ id: id(1), email: 'a@example.com' }]);
    await copy(app, auth);
    const before = await audits(app, auth);
    await expect(copy(app, auth)).rejects.toThrow(/auth\.users is not empty/);
    expect(await audits(app, auth)).toEqual(before);
  });

  it('scenario 10: re-running the account backfill on its own inserts nothing', async () => {
    await seed(app, [
      { id: id(1), email: 'a@example.com' },
      { id: id(2), email: 'b@example.com' },
    ]);
    await copy(app, auth);
    const sql = readFileSync(script('02-import-auth.sql'), 'utf8');
    const start = sql.indexOf('INSERT INTO auth.account');
    const backfill = sql.slice(start, sql.indexOf(';', start) + 1);
    const exported = (await runPsqlFile(app, script('01-export-app.sql'))).stdout.join('');
    await auth.exec(`CREATE TEMP TABLE import_users (id uuid, email text, first_name text, last_name text, password_hash text, registered_via text, created_at timestamptz, updated_at timestamptz)`);
    await auth.query(`COPY import_users FROM '/dev/blob'`, [], { blob: new Blob([exported]) });
    const inserted = await auth.query(backfill);
    expect(inserted.affectedRows).toBe(0);
    expect(await count(auth, 'auth.account')).toBe(2);
    await auth.exec('DISCARD TEMP');
  });

  it('an empty import aborts', async () => {
    await expect(
      runPsqlFile(auth, script('02-import-auth.sql'), { stdin: '', vars: { expected_rows: '0' } })
    ).rejects.toThrow(/the import is empty/);
  });

  // Security review S4: a pipe that drops mid-stream ends \copy at an EOF that
  // looks like end-of-data, and every guard then passes on the subset.
  it('a stream cut short aborts on the count, and nothing is written', async () => {
    await seed(app, [
      { id: id(1), email: 'a@example.com' },
      { id: id(2), email: 'b@example.com' },
      { id: id(3), email: 'c@example.com' },
    ]);
    const expected_rows = await expectedRows(app);
    expect(expected_rows).toBe('3');
    const exported = (await runPsqlFile(app, script('01-export-app.sql'))).stdout.join('');
    const cut = exported.split('\n').slice(0, 2).join('\n') + '\n';
    await expect(
      runPsqlFile(auth, script('02-import-auth.sql'), { stdin: cut, vars: { expected_rows } })
    ).rejects.toThrow(/the import holds 2 row\(s\), but the app counted 3 to copy/);
    expect(await count(auth, 'auth.users')).toBe(0);
    expect(await count(auth, 'auth.account')).toBe(0);
    expect(await count(auth, `pg_class WHERE relname IN ('import_users', 'import_expected')`)).toBe(0);
  });

  it('without expected_rows, 02 refuses to run', async () => {
    await seed(app, [{ id: id(1), email: 'a@example.com' }]);
    const exported = (await runPsqlFile(app, script('01-export-app.sql'))).stdout.join('');
    await expect(runPsqlFile(auth, script('02-import-auth.sql'), { stdin: exported })).rejects.toThrow(
      /expected_rows is not set/
    );
    expect(await count(auth, 'auth.users')).toBe(0);
  });

  it("the count uses 01's filter, and copy.sh passes it to 02", () => {
    const where = (file: string) => /FROM public\.users (WHERE [^)\n]*?)(?: ORDER BY|;|\))/.exec(readFileSync(script(file), 'utf8'))?.[1];
    expect(where('01-count-app.sql')).toBe('WHERE system_key IS NULL');
    expect(where('01-export-app.sql')).toBe(where('01-count-app.sql'));
    const sh = readFileSync(script('copy.sh'), 'utf8');
    expect(sh).toMatch(/expected="\$\(psql_app -At -f "\$here\/01-count-app\.sql"\)"/);
    expect(sh).toMatch(/psql_auth -v expected_rows="\$expected" -f "\$here\/02-import-auth\.sql"/);
  });

  it('scenario 9h: one hash altered in transit fails the hash audit', async () => {
    await seed(app, [
      { id: id(1), email: 'a@example.com' },
      { id: id(2), email: 'b@example.com' },
    ]);
    const exported = (await runPsqlFile(app, script('01-export-app.sql'))).stdout.join('');
    const tampered = exported.replace(bcryptHash, `${bcryptHash.slice(0, -1)}X`);
    expect(tampered).not.toBe(exported);
    await runPsqlFile(auth, script('02-import-auth.sql'), {
      stdin: tampered,
      vars: { expected_rows: await expectedRows(app) },
    });
    const { app: a, auth: b } = await audits(app, auth);
    expect(b).not.toEqual(a);
    const differing = a.filter((line, i) => line !== b[i]).map((line) => line.split('|')[0]);
    expect(differing).toEqual(['hash_checksum']);
  });

  it('scenario 9h: the import table is TEMP, and a failed step 2 leaves none behind', async () => {
    const sql = readFileSync(script('02-import-auth.sql'), 'utf8');
    expect(sql).toMatch(/CREATE TEMP TABLE import_users/);
    await seed(app, [
      { id: id(1), email: 'Bob@x.com' },
      { id: id(2), email: 'bob@x.com' },
    ]);
    await copy(app, auth).catch(() => undefined);
    expect(await count(auth, `pg_class WHERE relname = 'import_users'`)).toBe(0);
  });

  it('no copied row lands outside auth.users and auth.account', async () => {
    await seed(app, [{ id: id(1), email: 'a@example.com' }]);
    await copy(app, auth);
    expect(await count(auth, 'auth.session')).toBe(0);
    expect(await count(auth, `pg_class WHERE relname = 'import_users'`)).toBe(0);
  });
});

/** The dry run's baseline file: what `auth-journal.mjs sql` prints (copy.sh hands psql a file descriptor). */
function baselineFile(sql: string = baselineSql() as string): string {
  const dir = mkdtempSync(resolve(tmpdir(), 'auth-journal-'));
  const file = resolve(dir, 'baseline.sql');
  writeFileSync(file, sql);
  return file;
}

/** 01 | 02 as copy.sh --dry-run runs them: the auth database left as found. */
async function dryCopy(app: PGlite, auth: PGlite, options: { baseline?: boolean | string } = {}) {
  const expected_rows = await expectedRows(app);
  const exported = await runPsqlFile(app, script('01-export-app.sql'));
  const baseline = options.baseline === true ? baselineFile() : options.baseline;
  return runPsqlFile(auth, script('02-import-auth.sql'), {
    stdin: exported.stdout.join(''),
    vars: { expected_rows, dry_run: '1', ...(baseline ? { dry_run_baseline: baseline } : {}) },
  });
}

const authSchemas = (db: PGlite) => count(db, `information_schema.schemata WHERE schema_name = 'auth'`);

describe('copy.sh --dry-run: the same copy, rolled back', () => {
  const legacy = () => [
    { id: id(1), email: 'Mixed@Example.com', first: 'Amina', last: 'Yusuf' },
    { id: id(2), email: 'b@example.com' },
    { id: id(3), email: 'ai-skill@system.ansari.chat', hash: 'nologin', systemKey: 'ai-skill' },
  ];

  it('prints the auth audit from inside its transaction, equal to the app audit, and commits nothing', async () => {
    await seed(app, legacy());
    const run = await dryCopy(app, auth);
    const { app: expected } = await audits(app, auth);
    expect(expected).toContain('rows|2');
    expect(run.stdout).toEqual(expected);
    expect(run.echo).not.toContain('cutover copy: committed');
    expect(await count(auth, 'auth.users')).toBe(0);
    expect(await count(auth, 'auth.account')).toBe(0);
    expect(await count(auth, `pg_class WHERE relname IN ('import_users', 'import_expected')`)).toBe(0);
    // Left as found: the real copy then runs, and its audit matches.
    await copy(app, auth);
    const after = await audits(app, auth);
    expect(after.auth).toEqual(expected);
  });

  it('against an auth database with no schema (before step 5): the baseline is applied inside the transaction and rolled back', async () => {
    await seed(app, legacy());
    const bare = emptyDatabase();
    try {
      const run = await dryCopy(app, bare, { baseline: true });
      expect(run.stdout).toEqual((await audits(app, auth)).app);
      expect(await authSchemas(bare)).toBe(0);
      expect(await count(bare, `information_schema.tables WHERE table_schema NOT IN ('pg_catalog', 'information_schema')`)).toBe(0);
    } finally {
      await bare.close();
    }
  });

  it('the baseline is the whole journal: a baseline missing a later migration fails its assertion, naming it', async () => {
    await seed(app, legacy());
    const all = migrations() as { tag: string; file: string }[];
    expect(all.map((m) => m.tag)).toEqual(['0000_auth_schema', '0001_api_key']);
    // Only 0000's SQL, followed by the full journal's assertion (from the real baseline).
    const full = baselineSql() as string;
    const assertion = full.slice(full.indexOf('do $check$'));
    const only0000 = `${readFileSync(all[0]!.file, 'utf8')}\n${assertion}`;
    const bare = emptyDatabase();
    try {
      await expect(dryCopy(app, bare, { baseline: baselineFile(only0000) })).rejects.toThrow(
        /auth journal check: not applied: 0001_api_key/
      );
      expect(await authSchemas(bare)).toBe(0);
    } finally {
      await bare.close();
    }
  });

  it('the baseline carries every journal file in order, then the assertion', () => {
    const sql = baselineSql() as string;
    const at = (needle: string) => sql.indexOf(needle);
    expect(at('-- 0000_auth_schema')).toBeGreaterThanOrEqual(0);
    expect(at('-- 0001_api_key')).toBeGreaterThan(at('-- 0000_auth_schema'));
    expect(at('CREATE TABLE "auth"."apikey"')).toBeGreaterThan(at('-- 0001_api_key'));
    expect(at('do $check$')).toBeGreaterThan(at('CREATE TABLE "auth"."apikey"'));
    expect(sql).not.toContain('phone_number');
  });

  it('the guards still fire, and a refused dry run leaves the database as found', async () => {
    await seed(app, legacy());
    await app.exec(`UPDATE users SET updated_at = NULL WHERE id = '${id(2)}'`);
    await expect(dryCopy(app, auth)).rejects.toThrow(/1 row\(s\) have a NULL created_at or updated_at/);
    expect(await count(auth, 'auth.users')).toBe(0);
    const bare = emptyDatabase();
    try {
      await expect(dryCopy(app, bare, { baseline: true })).rejects.toThrow(/1 row\(s\) have a NULL created_at or updated_at/);
      expect(await authSchemas(bare)).toBe(0);
    } finally {
      await bare.close();
    }
  });

  it('a non-empty auth database is refused in a dry run too', async () => {
    await seed(app, legacy());
    await copy(app, auth);
    await expect(dryCopy(app, auth)).rejects.toThrow(/auth\.users is not empty/);
  });

  it('dry_run_baseline without dry_run is refused before anything runs', async () => {
    await seed(app, legacy());
    const bare = emptyDatabase();
    try {
      await expect(
        runPsqlFile(bare, script('02-import-auth.sql'), { stdin: '', vars: { expected_rows: '2', dry_run_baseline: '1' } })
      ).rejects.toThrow(/dry_run_baseline is only for copy\.sh --dry-run/);
      expect(await authSchemas(bare)).toBe(0);
    } finally {
      await bare.close();
    }
  });

  it('copy.sh: the dry run passes dry_run to 02, never runs the committing audit path, and checks the auth database afterwards', () => {
    const sh = readFileSync(script('copy.sh'), 'utf8');
    const dry = sh.slice(sh.indexOf('if [ "$dry_run" = 1 ]; then'), sh.indexOf('\nelse\n'));
    expect(dry).toMatch(/-v dry_run=1/);
    expect(dry).toMatch(/DRY RUN LEFT CHANGES/);
    expect(dry).not.toMatch(/03-audit-auth\.sql/);
    expect(sh).toMatch(/dry run audit OK \(nothing committed\)/);
  });
});

describe('the preflight', () => {
  it('counts guests by their exact shape: the email AND the Welcome Guest names', async () => {
    await seed(app, [
      { id: id(1), email: 'guest_AbCdEfGhIj@askansari.ai', first: 'Welcome', last: 'Guest' },
      { id: id(2), email: 'guest_0123456789@ansari.chat', first: 'Welcome', last: 'Guest' },
      // Near-misses: the email shape with other names, the names with another email,
      // a short id, another domain.
      { id: id(3), email: 'guest_KlMnOpQrSt@askansari.ai', first: 'Real', last: 'Person' },
      { id: id(4), email: 'welcome@example.com', first: 'Welcome', last: 'Guest' },
      { id: id(5), email: 'guest_abc@ansari.chat', first: 'Welcome', last: 'Guest' },
      { id: id(6), email: 'guest_AbCdEfGhIk@gmail.com', first: 'Welcome', last: 'Guest' },
    ]);
    // The whole preflight runs clean, and its guest query, run alone, counts
    // exactly the two true guests.
    await runPsqlFile(app, script('00-preflight-app.sql'));
    const sql = readFileSync(script('00-preflight-app.sql'), 'utf8');
    const guestSection = sql.slice(sql.indexOf('== Guests'), sql.indexOf('== Legacy admin'));
    const start = guestSection.indexOf('SELECT');
    const guestQuery = guestSection.slice(start, guestSection.indexOf(';', start) + 1);
    const result = await app.query<{ guests: number }>(guestQuery.replace('count(*)', 'count(*)::int'));
    expect(result.rows[0]?.guests).toBe(2);
    expect(guestSection).toContain("first_name = 'Welcome' AND last_name = 'Guest'");
  });
});

describe('the preflight sees every collision 0011 would abort on', () => {
  it('a system row and a user row sharing a normalized email are reported, as 0011 aborts on them', async () => {
    await seed(app, [
      { id: id(1), email: 'Leaderboard@Example.com' },
      { id: id(2), email: 'leaderboard@example.com', hash: 'nologin', systemKey: 'leaderboard' },
      { id: id(3), email: 'alone@example.com' },
    ]);
    const collisions = await app.query<{ ids: string[]; system_keys: string[] }>(
      preflightQuery('== Collisions')
    );
    expect(collisions.rows).toHaveLength(1);
    expect(collisions.rows[0]?.ids).toEqual([id(1), id(2)]);
    expect(collisions.rows[0]?.system_keys).toEqual(['-', 'leaderboard']);
    // The window migration does abort on exactly this pair.
    const migration = readFileSync(resolve(APP_DRIZZLE, '0011_better_auth_window.sql'), 'utf8');
    await expect(app.exec(migration.split('--> statement-breakpoint').join('\n'))).rejects.toThrow();
  });

  it('the case audit counts a system row whose email is not normalized', async () => {
    await seed(app, [{ id: id(2), email: ' Leaderboard@example.com', hash: 'nologin', systemKey: 'leaderboard' }]);
    const audit = await app.query<{ not_normalized: string; of_which_system: string }>(
      preflightQuery('== Case audit')
    );
    expect(Number(audit.rows[0]?.not_normalized)).toBe(1);
    expect(Number(audit.rows[0]?.of_which_system)).toBe(1);
  });
});

describe('hash formats: only bcrypt $2a$/$2b$ of length 60 is copied', () => {
  // apps/auth reads a hash as bcrypt only by its prefix (packages/auth/src/password.ts);
  // any other hash would go to scrypt and its user could never sign in.
  it('a $2a$ and a $2b$ hash both copy, and both sign in through createAuth', async () => {
    const hash2a = await bcrypt.hash(PASSWORD, await bcrypt.genSalt(4, 'a'));
    expect(hash2a.startsWith('$2a$')).toBe(true);
    expect(bcryptHash.startsWith('$2b$')).toBe(true);
    await seed(app, [
      { id: id(1), email: 'a@example.com', hash: hash2a },
      { id: id(2), email: 'b@example.com' },
    ]);
    await copy(app, auth);
    setAuthEnv('http://localhost:3100');
    const service = createAuth(drizzleFor(auth));
    for (const [email, userId] of [['a@example.com', id(1)], ['b@example.com', id(2)]] as const) {
      const result = await service.api.signInEmail({ body: { email, password: PASSWORD } });
      expect(result.user.id).toBe(userId);
    }
  });

  it.each([
    ['an scrypt-shaped hash', 'abcdef0123456789abcdef0123456789:' + 'ab'.repeat(64)],
    ['a $2y$ hash', () => `$2y$${bcryptHash.slice(4)}`],
    ['a truncated $2b$ hash', () => bcryptHash.slice(0, 59)],
    ['a $2b$ hash with trailing data', () => `${bcryptHash}x`],
  ])('%s aborts the copy with no changes, naming a count', async (_label, value) => {
    const hash = typeof value === 'function' ? value() : value;
    await seed(app, [
      { id: id(1), email: 'a@example.com' },
      { id: id(2), email: 'b@example.com', hash },
    ]);
    const error = await copy(app, auth).catch((e: unknown) => e);
    expect(String(error)).toMatch(/1 row\(s\) have a hash that is not bcrypt \$2a\$\/\$2b\$ of length 60/);
    expect(String(error)).not.toContain(hash);
    expect(String(error)).not.toMatch(/b@example\.com/);
    expect(await count(auth, 'auth.users')).toBe(0);
    expect(await count(auth, 'auth.account')).toBe(0);
  });

  it('the preflight prints prefix, length and count per format, never a hash, and counts the rows the copy refuses', async () => {
    const hash2a = await bcrypt.hash(PASSWORD, await bcrypt.genSalt(4, 'a'));
    await seed(app, [
      { id: id(1), email: 'a@example.com', hash: hash2a },
      { id: id(2), email: 'b@example.com' },
      { id: id(3), email: 'c@example.com' },
      { id: id(4), email: 'd@example.com', hash: 'abcdef:0123' },
      { id: id(5), email: 'ai-skill@system.ansari.chat', hash: 'nologin', systemKey: 'ai-skill' },
    ]);
    const run = await runPsqlFile(app, script('00-preflight-app.sql'));
    const printed = JSON.stringify(run);
    for (const secret of [hash2a, bcryptHash, 'abcdef:0123']) expect(printed).not.toContain(secret);
    const formats = await app.query<{ prefix: string; length: number; rows: number }>(
      preflightQuery('== Hash formats').replace('count(*) AS rows', 'count(*)::int AS rows')
    );
    expect(formats.rows).toEqual([
      { prefix: '$2b$', length: 60, rows: 2 },
      { prefix: '$2a$', length: 60, rows: 1 },
      { prefix: 'abcd', length: 11, rows: 1 },
    ]);
    const refused = await app.query<{ not_bcrypt: number }>(
      preflightQuery('== Rows whose hash is not bcrypt').replace('count(*)', 'count(*)::int')
    );
    expect(refused.rows[0]?.not_bcrypt).toBe(1);
  });
});

describe('the staging anomaly seed (rehearsal-anomalies.ts), through the rehearsal order', () => {
  const ok = {
    cutoverEnv: 'staging',
    appHost: 'ansari-staging-tailscale-forwarder',
    stdoutIsTTY: false,
    command: 'seed',
    password: 'x'.repeat(12),
  };

  it("refuses anything but staging, a host that is not staging's forwarder, a terminal, an unknown command or a short password", () => {
    expect(refusal(ok)).toBeNull();
    expect(refusal({ ...ok, command: 'remove', password: undefined })).toBeNull();
    expect(refusal({ ...ok, cutoverEnv: 'production' })).toMatch(/anything but staging .*'production'/);
    expect(refusal({ ...ok, cutoverEnv: undefined })).toMatch(/unset/);
    expect(refusal({ ...ok, appHost: null })).toMatch(/APP_DATABASE_URL is unset/);
    expect(refusal({ ...ok, appHost: 'roundhouse.proxy.rlwy.net' })).toMatch(/public TCP proxy/);
    for (const host of [
      'db.example.com',
      'postgres.railway.internal',
      'tailscale-forwarder',
      'ansari-staging-tailscale-forwarder.evil.com',
      'localhost',
      '100.64.0.7',
    ]) {
      expect(refusal({ ...ok, appHost: host }), host).toMatch(/not staging's Tailscale forwarder/);
    }
    for (const host of ['ansari-production-tailscale-forwarder', 'ansari-production-tailscale-forwarder.tail1234.ts.net']) {
      expect(refusal({ ...ok, appHost: host }), host).toMatch(/not staging's Tailscale forwarder/);
    }
    for (const host of ['ansari-staging-tailscale-forwarder-2', 'ansari-staging-tailscale-forwarder.tail1234.ts.net']) {
      expect(refusal({ ...ok, appHost: host }), host).toBeNull();
    }
    expect(refusal({ ...ok, stdoutIsTTY: true })).toMatch(/terminal/);
    expect(refusal({ ...ok, command: 'drop' })).toMatch(/usage/);
    expect(refusal({ ...ok, password: 'x'.repeat(11) })).toMatch(/REHEARSAL_PASSWORD/);
    // The environment word first: a production run is refused on it, whatever else holds.
    expect(refusal({ ...ok, cutoverEnv: 'production', appHost: null, stdoutIsTTY: true })).toMatch(/anything but staging/);
  });

  it('urlHost and isForwarderHost read the host as operator-env.sh does', () => {
    expect(urlHost('postgresql://u:p@ansari-staging-tailscale-forwarder:5432/railway?sslmode=require')).toBe(
      'ansari-staging-tailscale-forwarder'
    );
    expect(urlHost('postgres://u:p%40x@Ansari-Staging-Tailscale-Forwarder/db')).toBe('ansari-staging-tailscale-forwarder');
    expect(urlHost('not a url')).toBeNull();
    expect(urlHost(undefined)).toBeNull();
    expect(isForwarderHost('ansari-staging-tailscale-forwarder.', 'staging')).toBe(true);
    expect(isForwarderHost('ansari-staging-tailscale-forwarder', 'production')).toBe(false);
    expect(isForwarderHost('ansari-production-tailscale-forwarder', 'production')).toBe(true);
    expect(isForwarderHost('-bad-staging-tailscale-forwarder', 'staging')).toBe(false);
    expect(isForwarderHost('ansari-staging-tailscale-forwarder.ts.net', 'staging')).toBe(false);
  });

  it('seed → the preflight sees every class; the copy stops on the collision, then the NULL timestamp, then passes', async () => {
    const hashes = await makeHashes(PASSWORD, 4);
    expect(hashes.h2a.startsWith('$2a$')).toBe(true);
    expect(hashes.h2b.startsWith('$2b$')).toBe(true);
    // A pre-existing staging user and the system row stay throughout.
    await seed(app, [
      { id: id(1), email: 'existing@example.com' },
      { id: id(9), email: 'ai-skill@system.ansari.chat', hash: 'nologin', systemKey: 'ai-skill' },
    ]);
    await app.exec(anomalySql('seed', hashes));
    await expect(app.exec(anomalySql('seed', hashes))).rejects.toThrow(/already exist/);

    const n = async (heading: string, col: string) =>
      Number((await app.query<Record<string, unknown>>(preflightQuery(heading))).rows[0]?.[col]);
    expect((await app.query(preflightQuery('== Collisions'))).rows).toHaveLength(1);
    expect(await n('== Case audit', 'not_normalized')).toBe(2);
    expect(await n('== Rows with a NULL timestamp', 'null_updated_at')).toBe(1);
    expect(await n('== Rows whose hash is not bcrypt', 'not_bcrypt')).toBe(1);
    expect(await n('== Guests', 'guests')).toBe(1);
    expect((await app.query(preflightQuery('== Legacy admin'))).rows).toHaveLength(1);
    const formats = await app.query<{ prefix: string; rows: string }>(preflightQuery('== Hash formats'));
    expect(formats.rows.map((r) => [r.prefix, Number(r.rows)])).toEqual([['$2b$', 7], ['$2a$', 1], ['abab', 1]]);

    // 1. The collision aborts: auth empty, no TEMP table left.
    await expect(copy(app, auth)).rejects.toThrow(/held by more than one row/);
    expect(await count(auth, 'auth.users')).toBe(0);
    expect(await count(auth, "pg_class WHERE relname = 'import_users'")).toBe(0);
    // 2. The pair removed, the non-bcrypt hash aborts.
    await app.exec(anomalySql('resolve-collision'));
    await expect(copy(app, auth)).rejects.toThrow(/1 row\(s\) have a hash that is not bcrypt/);
    expect(await count(auth, 'auth.users')).toBe(0);
    expect(await count(auth, "pg_class WHERE relname = 'import_users'")).toBe(0);
    // 3. That row removed, the NULL timestamp aborts.
    await app.exec(anomalySql('resolve-hash'));
    await expect(copy(app, auth)).rejects.toThrow(/NULL created_at or updated_at/);
    expect(await count(auth, 'auth.users')).toBe(0);
    // 4. Fixed, the copy passes and the audits match.
    await app.exec(anomalySql('resolve-null'));
    await copy(app, auth);
    const { app: a, auth: b } = await audits(app, auth);
    expect(b).toEqual(a);
    expect(a).toContain('rows|6');

    // The pass run: system rows absent; mixed case signs in by its uppercase
    // address; both prefixes sign in; the guest signs in.
    expect(await count(auth, "auth.users WHERE email LIKE '%@system.ansari.chat'")).toBe(0);
    setAuthEnv('http://localhost:3100');
    const service = createAuth(drizzleFor(auth));
    for (const [email, userId] of [
      ['REHEARSAL.MIXED@EXAMPLE.COM', ROWS.mixedCase2a.id],
      [ROWS.plain2b.email, ROWS.plain2b.id],
      [ROWS.guest.email, ROWS.guest.id],
      [ROWS.legacyAdmin.email, ROWS.legacyAdmin.id],
    ] as const) {
      const result = await service.api.signInEmail({ body: { email, password: PASSWORD } });
      expect(result.user.id).toBe(userId);
    }

    // remove touches only rehearsal rows.
    await app.exec(anomalySql('remove'));
    expect(await count(app, `users WHERE id::text LIKE '${ID_PREFIX}%'`)).toBe(0);
    expect(await count(app, 'users')).toBe(2);
  });

  it('the CLI exits 2 before generating anything: production, or a laptop shell without the staging word', () => {
    const tsx = resolve(here, '../../node_modules/.bin/tsx');
    for (const env of [
      { CUTOVER_ENV: 'production', APP_DATABASE_URL: 'postgresql://u:p@ansari-staging-tailscale-forwarder/railway' },
      // The old variable name means nothing now.
      { ANSARI_CUTOVER_ENV: 'staging', APP_DATABASE_URL: 'postgresql://u:p@ansari-staging-tailscale-forwarder/railway' },
      // Railway's own variables prove nothing (a laptop `railway shell` injects them).
      { RAILWAY_ENVIRONMENT_NAME: 'staging', APP_DATABASE_URL: 'postgresql://u:p@ansari-staging-tailscale-forwarder/railway' },
      { CUTOVER_ENV: 'staging', APP_DATABASE_URL: 'postgresql://u:p@ansari-production-tailscale-forwarder/railway' },
      { CUTOVER_ENV: 'staging', APP_DATABASE_URL: 'postgresql://u:p@roundhouse.proxy.rlwy.net:41234/railway' },
    ]) {
      const result = spawnSync(tsx, [script('rehearsal-anomalies.ts'), 'seed'], {
        env: { PATH: process.env.PATH ?? '', REHEARSAL_PASSWORD: 'x'.repeat(16), ...env },
        encoding: 'utf8',
      });
      expect(result.status).toBe(2);
      expect(result.stderr).toMatch(/anything but staging|public TCP proxy|not staging's Tailscale forwarder/);
      expect(result.stdout).toBe('');
    }
  });

  it('every rehearsal row is outside the system domain, and every id carries the prefix', () => {
    for (const row of Object.values(ROWS)) {
      expect(row.id.startsWith(ID_PREFIX)).toBe(true);
      expect(row.email).not.toMatch(/@system\.ansari\.chat$/);
    }
  });
});

describe('after the copy', () => {
  it('scenario 16: the approved admin list is granted; a legacy admin left off it is not', async () => {
    await seed(app, [
      { id: id(1), email: 'kept-admin@example.com', admin: true },
      { id: id(2), email: 'dropped-admin@example.com', admin: true },
      { id: id(3), email: 'new-admin@example.com' },
    ]);
    const preflight = await runPsqlFile(app, script('00-preflight-app.sql'));
    expect(preflight.stdout).toEqual(
      expect.arrayContaining([`${id(2)}|dropped-admin@example.com`, `${id(1)}|kept-admin@example.com`])
    );
    await copy(app, auth);
    const db = drizzleFor(auth);
    for (const email of ['kept-admin@example.com', 'new-admin@example.com']) {
      await users.setRoleByEmail(db, email, 'admin');
    }
    const admins = (await runPsqlFile(auth, script('05-audit-admins-auth.sql'))).stdout;
    expect(admins).toEqual(['kept-admin@example.com', 'new-admin@example.com']);
  });

  it('amendment C: completing a pending tombstone leaves no orphan session or account', async () => {
    await seed(app, [
      { id: id(1), email: 'gone@example.com' },
      { id: id(2), email: 'stays@example.com' },
    ]);
    await copy(app, auth);
    setAuthEnv('http://localhost:3100');
    const service = createAuth(drizzleFor(auth));
    await service.api.signInEmail({ body: { email: 'gone@example.com', password: PASSWORD } });
    await service.api.signInEmail({ body: { email: 'stays@example.com', password: PASSWORD } });
    // DELETE me ran on apps/api, but its apps/auth step failed: the row is
    // gone from the app database and its tombstone is pending.
    await app.exec(`DELETE FROM users WHERE id = '${id(1)}'; INSERT INTO deleted_users (id) VALUES ('${id(1)}')`);

    const pending = (await runPsqlFile(app, script('04-tombstones-pending-app.sql'))).stdout;
    expect(pending).toEqual([`{${id(1)}}`]);
    await runPsqlFile(auth, script('04-tombstones-delete-auth.sql'), { vars: { ids: pending[0] as string } });
    await runPsqlFile(app, script('04-tombstones-mark-app.sql'), { vars: { ids: pending[0] as string } });

    expect(await count(auth, `auth.users WHERE id = '${id(1)}'`)).toBe(0);
    expect(await count(auth, `auth.session WHERE user_id = '${id(1)}'`)).toBe(0);
    expect(await count(auth, `auth.account WHERE user_id = '${id(1)}'`)).toBe(0);
    expect(await count(auth, `auth.session WHERE user_id = '${id(2)}'`)).toBe(1);
    expect(await count(app, `deleted_users WHERE id = '${id(1)}' AND auth_deleted_at IS NOT NULL`)).toBe(1);
    expect((await runPsqlFile(app, script('04-tombstones-pending-app.sql'))).stdout).toEqual(['{}']);
  });
});

describe('rollback: remove post-cutover users (docs/cutover/rollback.md)', () => {
  const CUTOVER = '2026-10-20 03:00:00+00';

  async function seeded() {
    await seed(app, [
      { id: id(1), email: 'before@example.com', created: '2026-10-19 12:00:00+00' },
      { id: id(2), email: 'after@example.com', created: '2026-10-20 03:00:00+00' },
      { id: id(3), email: 'later@example.com', created: '2026-10-20 09:30:00+00' },
      { id: id(4), email: 'ai-skill@system.ansari.chat', hash: 'nologin', systemKey: 'ai-skill', created: '2026-10-21 00:00:00+00' },
    ]);
    await app.exec(`INSERT INTO threads (id, user_id, name) VALUES ('${id(9)}', '${id(3)}', 'post-cutover thread')`);
  }

  it('the dry run counts post-cutover users and deletes nothing', async () => {
    await seeded();
    const run = await runPsqlFile(app, script('rollback-remove-post-cutover-users.sql'), { vars: { cutover_at: CUTOVER } });
    expect(run.stdout).toEqual(['2']);
    expect(run.echo.at(-1)).toMatch(/dry run only/);
    expect(await count(app, 'users')).toBe(4);
  });

  it.each(['no', 'off', 'false'])('confirm=%s is still a dry run', async (confirm) => {
    await seeded();
    await runPsqlFile(app, script('rollback-remove-post-cutover-users.sql'), { vars: { cutover_at: CUTOVER, confirm } });
    expect(await count(app, 'users')).toBe(4);
  });

  it('confirm=yes removes users created at or after cutover_at, with their threads; system rows stay', async () => {
    await seeded();
    await runPsqlFile(app, script('rollback-remove-post-cutover-users.sql'), {
      vars: { cutover_at: CUTOVER, confirm: 'yes' },
    });
    const left = (await app.query<{ id: string }>('SELECT id FROM users ORDER BY id')).rows.map((r) => r.id);
    expect(left).toEqual([id(1), id(4)]);
    expect(await count(app, 'threads')).toBe(0);
  });

  it('without cutover_at it refuses', async () => {
    await seeded();
    await expect(runPsqlFile(app, script('rollback-remove-post-cutover-users.sql'))).rejects.toThrow(/set -v cutover_at/);
    expect(await count(app, 'users')).toBe(4);
  });
});

describe('copy.sh and complete-tombstones.sh: the operator-environment check (spec 300 H-8)', () => {
  // Each script runs from a throwaway copy of the cutover directory with a
  // fake psql on PATH. The check exits before
  // any real database call; the fake psql logs every call that is not
  // --version, so a run that passed the check shows up in the log.
  let repo: string;
  let bin: string;
  let log: string;
  const SCRIPTS = resolve(here, '../../scripts/cutover');

  beforeEach(() => {
    repo = mkdtempSync(resolve(tmpdir(), 'cutover-checkout-'));
    bin = mkdtempSync(resolve(tmpdir(), 'cutover-bin-'));
    log = resolve(bin, 'psql.log');
    cpSync(SCRIPTS, resolve(repo, 'cutover'), { recursive: true });
    writeFileSync(
      resolve(bin, 'psql'),
      `#!/usr/bin/env bash\nif [ "$1" = "--version" ]; then echo "psql (PostgreSQL) \${FAKE_PSQL_MAJOR:-18}.0"; exit 0; fi\necho "called $#" >> "${log}"\nexit 3\n`
    );
    chmodSync(resolve(bin, 'psql'), 0o755);
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
    rmSync(bin, { recursive: true, force: true });
  });

  const good = () => ({
    // One forwarder, two mappings: 5432 → the app database, 5433 → the auth database.
    APP_DATABASE_URL: 'postgresql://u:p@ansari-production-tailscale-forwarder:5432/railway?sslmode=require',
    AUTH_DATABASE_URL: 'postgresql://u:p@ansari-production-tailscale-forwarder:5433/railway?sslmode=require',
    CUTOVER_ENV: 'production',
  });
  const staging = () => ({
    ...good(),
    APP_DATABASE_URL: 'postgresql://u:p@ansari-staging-tailscale-forwarder:5432/railway?sslmode=require',
    AUTH_DATABASE_URL: 'postgresql://u:p@ansari-staging-tailscale-forwarder:5433/railway?sslmode=require',
    CUTOVER_ENV: 'staging',
  });

  const run = (name: string, env: Record<string, string | undefined>, args: string[] = []) =>
    spawnSync('bash', [resolve(repo, 'cutover', name), ...args], {
      env: { PATH: `${bin}:${process.env.PATH ?? ''}`, HOME: process.env.HOME ?? '', ...env } as NodeJS.ProcessEnv,
      encoding: 'utf8',
    });

  const psqlCalls = () => {
    try {
      return readFileSync(log, 'utf8');
    } catch {
      return '';
    }
  };

  it.each(['copy.sh', 'complete-tombstones.sh'])('%s: refuses each condition, before any database call', (name) => {
    const cases: [string, Record<string, string | undefined>, RegExp][] = [
      ['no APP_DATABASE_URL', { ...good(), APP_DATABASE_URL: undefined }, /APP_DATABASE_URL is unset/],
      ['no AUTH_DATABASE_URL', { ...good(), AUTH_DATABASE_URL: '' }, /AUTH_DATABASE_URL is unset/],
      ['the same database', { ...good(), AUTH_DATABASE_URL: good().APP_DATABASE_URL }, /same database/],
      ['the public TCP proxy', { ...good(), APP_DATABASE_URL: 'postgresql://u:p@roundhouse.proxy.rlwy.net:41234/railway' }, /public TCP proxy/],
      ['a public host', { ...good(), AUTH_DATABASE_URL: 'postgresql://u:p@db.example.com/railway' }, /not the production Tailscale forwarder/],
      ['a near-miss host', { ...good(), APP_DATABASE_URL: 'postgresql://u:p@ansari-production-tailscale-forwarder.evil.com/railway' }, /not the production Tailscale forwarder/],
      ['a railway.internal host (it resolves only inside Railway)', { ...good(), APP_DATABASE_URL: 'postgresql://u:p@postgres.railway.internal:5432/railway' }, /not the production Tailscale forwarder/],
      ['a bare IP', { ...good(), APP_DATABASE_URL: 'postgresql://u:p@100.64.0.7:5432/railway' }, /not the production Tailscale forwarder/],
      ['localhost without --allow-local', { ...good(), APP_DATABASE_URL: 'postgresql://u:p@localhost:5432/app' }, /not the production Tailscale forwarder/],
      // The environment binding (main, security): CUTOVER_ENV is required, and every host must be its forwarder.
      ['CUTOVER_ENV unset', { ...good(), CUTOVER_ENV: undefined }, /CUTOVER_ENV must be production or staging/],
      ['CUTOVER_ENV empty', { ...good(), CUTOVER_ENV: '' }, /CUTOVER_ENV must be production or staging/],
      ['CUTOVER_ENV another word', { ...good(), CUTOVER_ENV: 'prod' }, /CUTOVER_ENV must be production or staging/],
      ['CUTOVER_ENV not lower-case', { ...good(), CUTOVER_ENV: 'Production' }, /CUTOVER_ENV must be production or staging/],
      ['a staging AUTH URL in the production window', { ...good(), AUTH_DATABASE_URL: staging().AUTH_DATABASE_URL }, /AUTH_DATABASE_URL's host is not the production Tailscale forwarder/],
      ['a staging APP URL in the production window', { ...good(), APP_DATABASE_URL: staging().APP_DATABASE_URL }, /APP_DATABASE_URL's host is not the production Tailscale forwarder/],
      ['production URLs under CUTOVER_ENV=staging', { ...good(), CUTOVER_ENV: 'staging' }, /not the staging Tailscale forwarder/],
      ['a production AUTH URL in the staging rehearsal', { ...staging(), AUTH_DATABASE_URL: good().AUTH_DATABASE_URL }, /AUTH_DATABASE_URL's host is not the staging Tailscale forwarder/],
      ['two forwarders of the same environment (mixed hosts)', { ...good(), AUTH_DATABASE_URL: 'postgresql://u:p@other-production-tailscale-forwarder:5433/railway?sslmode=require' }, /name different hosts/],
      ['the same forwarder, short and full name (still two host names)', { ...good(), AUTH_DATABASE_URL: 'postgresql://u:p@ansari-production-tailscale-forwarder.tail1234.ts.net:5433/railway' }, /name different hosts/],
      ['identical staging URLs', { ...staging(), AUTH_DATABASE_URL: staging().APP_DATABASE_URL }, /same database/],
      ['psql 17', { ...good(), FAKE_PSQL_MAJOR: '17' }, /psql must be major 18 .*17/],
      ['stdout not a terminal', good(), /stdout redirected/],
    ];
    for (const [label, env, message] of cases) {
      const result = run(name, env);
      expect({ label, status: result.status }).toEqual({ label, status: 2 });
      expect(result.stderr, label).toMatch(message);
      expect(result.stderr, label).not.toMatch(/u:p@/);
    }
    expect(psqlCalls()).toBe('');
  });

  const local = () => ({
    APP_DATABASE_URL: 'postgresql://u:p@localhost:5432/copy_app',
    AUTH_DATABASE_URL: 'postgresql://u:p@127.0.0.1:5432/copy_auth',
  });

  it.each(['copy.sh', 'complete-tombstones.sh'])('%s --allow-local: loopback only, every other check still runs', (name) => {
    const cases: [string, Record<string, string | undefined>, string[], RegExp][] = [
      ['a forwarder host', { ...local(), AUTH_DATABASE_URL: good().AUTH_DATABASE_URL }, ['--allow-local'], /not loopback/],
      ['a public host', { ...local(), APP_DATABASE_URL: 'postgresql://u:p@db.example.com/app' }, ['--allow-local'], /not loopback/],
      ['the public TCP proxy', { ...local(), APP_DATABASE_URL: 'postgresql://u:p@roundhouse.proxy.rlwy.net:41234/railway' }, ['--allow-local'], /not loopback/],
      ['a near-miss host', { ...local(), APP_DATABASE_URL: 'postgresql://u:p@localhost.evil.com/app' }, ['--allow-local'], /not loopback/],
      ['the same database', { ...local(), AUTH_DATABASE_URL: local().APP_DATABASE_URL }, ['--allow-local'], /same database/],
      ['psql 17', { ...local(), FAKE_PSQL_MAJOR: '17' }, ['--allow-local'], /psql must be major 18/],
      ['stdout not a terminal', local(), ['--allow-local'], /stdout redirected/],
      ['an unknown argument', local(), ['--allow-anything'], /unknown argument/],
      ['a second argument', local(), ['--allow-local', '--allow-local'], /unknown argument/],
    ];
    for (const [label, env, args, message] of cases) {
      const result = run(name, env, args);
      expect({ label, status: result.status }).toEqual({ label, status: 2 });
      expect(result.stderr, label).toMatch(message);
      expect(result.stderr, label).not.toMatch(/u:p@/);
    }
    expect(psqlCalls()).toBe('');
  });

  it('copy.sh --dry-run: accepted alone or with --allow-local, in either order; every check still runs', () => {
    const cases: [string, Record<string, string | undefined>, string[], RegExp][] = [
      ['--dry-run, production', good(), ['--dry-run'], /stdout redirected/],
      ['--dry-run still needs CUTOVER_ENV', { ...good(), CUTOVER_ENV: undefined }, ['--dry-run'], /CUTOVER_ENV must be production or staging/],
      ['--dry-run still needs the forwarder', { ...good(), APP_DATABASE_URL: 'postgresql://u:p@db.example.com/railway' }, ['--dry-run'], /not the production Tailscale forwarder/],
      ['--dry-run --allow-local', local(), ['--dry-run', '--allow-local'], /stdout redirected/],
      ['--allow-local --dry-run', local(), ['--allow-local', '--dry-run'], /stdout redirected/],
      ['--dry-run with a non-loopback host under --allow-local', { ...local(), APP_DATABASE_URL: good().APP_DATABASE_URL }, ['--dry-run', '--allow-local'], /not loopback/],
      ['--dry-run with an unknown argument', good(), ['--dry-run', '--bogus'], /unknown argument/],
    ];
    for (const [label, env, args, message] of cases) {
      const result = run('copy.sh', env, args);
      expect({ label, status: result.status }).toEqual({ label, status: 2 });
      expect(result.stderr, label).toMatch(message);
    }
    expect(psqlCalls()).toBe('');
  });

  it('copy.sh --dry-run, in a terminal: 02 gets dry_run, the committing audit never runs', () => {
    // A fake psql that answers the row count and the schema probe and logs every
    // call's arguments; the pipe into 02 is where it stops (exit 3).
    writeFileSync(
      resolve(bin, 'psql'),
      [
        '#!/usr/bin/env bash',
        'if [ "$1" = "--version" ]; then echo "psql (PostgreSQL) 18.0"; exit 0; fi',
        `echo "$*" >> "${log}"`,
        'case "$*" in',
        '  *01-count-app.sql*) echo 2; exit 0 ;;',
        "  *to_regclass*) echo f; exit 0 ;;",
        'esac',
        'cat >/dev/null; exit 3',
        '',
      ].join('\n')
    );
    const target = resolve(repo, 'cutover', 'copy.sh');
    const [cmd, args] =
      process.platform === 'darwin'
        ? ['script', ['-q', '/dev/null', 'bash', target, '--dry-run', '--allow-local']]
        : ['script', ['-qec', `bash ${target} --dry-run --allow-local`, '/dev/null']];
    const result = spawnSync(cmd, args, {
      env: { PATH: `${bin}:${process.env.PATH ?? ''}`, HOME: process.env.HOME ?? '', ...local() } as NodeJS.ProcessEnv,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const calls = psqlCalls();
    expect(`${result.stdout}${result.stderr}`).toMatch(/DRY RUN: the copy runs in one transaction and is rolled back/);
    expect(calls).toMatch(/-v dry_run=1 .*02-import-auth\.sql/);
    expect(calls).not.toMatch(/dry_run_baseline/); // the probe said the schema exists
    expect(calls).not.toMatch(/03-audit-auth\.sql/);
    expect(`${result.stdout}${result.stderr}`).not.toMatch(/audit OK/);
  });

  it('complete-tombstones.sh has no --dry-run: it is refused as an unknown argument', () => {
    const result = run('complete-tombstones.sh', good(), ['--dry-run']);
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/unknown argument/);
    expect(psqlCalls()).toBe('');
  });

  it.each(['copy.sh', 'complete-tombstones.sh'])('%s --allow-local: in a terminal, loopback hosts pass the check, with a warning', (name) => {
    const target = resolve(repo, 'cutover', name);
    const [cmd, args] =
      process.platform === 'darwin'
        ? ['script', ['-q', '/dev/null', 'bash', target, '--allow-local']]
        : ['script', ['-qec', `bash ${target} --allow-local`, '/dev/null']];
    const result = spawnSync(cmd, args, {
      env: { PATH: `${bin}:${process.env.PATH ?? ''}`, HOME: process.env.HOME ?? '', ...local(), APP_DATABASE_URL: 'postgresql://u:p@[::1]:5432/copy_app' } as NodeJS.ProcessEnv,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    expect(psqlCalls()).toMatch(/^called /);
    const out = `${result.stdout}${result.stderr}`;
    expect(out).toMatch(/LOCAL TEST RUN \(--allow-local\)/);
    expect(out).not.toMatch(/refusing|not loopback|PROMOTED_COMMIT|uncommitted|u:p@/);
  });

  it.each([
    ['copy.sh', 'production'],
    ['complete-tombstones.sh', 'production'],
    ['copy.sh', 'staging'],
    ['complete-tombstones.sh', 'staging'],
  ])('%s: in a terminal, with everything right (%s), it passes the check', (name, env) => {
    // Not a git checkout, with an untracked file: the checkout is not checked
    // (owner, 2026-10-19), so this still passes.
    writeFileSync(resolve(repo, 'cutover', 'untracked-notes.md'), 'notes\n');
    const target = resolve(repo, 'cutover', name);
    const [cmd, args] =
      process.platform === 'darwin'
        ? ['script', ['-q', '/dev/null', 'bash', target]]
        : ['script', ['-qec', `bash ${target}`, '/dev/null']];
    const result = spawnSync(cmd, args, {
      env: {
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        HOME: process.env.HOME ?? '',
        ...(env === 'staging' ? staging() : good()),
      } as NodeJS.ProcessEnv,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    // Past the check, the fake psql is called (and fails, so nothing else runs).
    expect(psqlCalls()).toMatch(/^called /);
    expect(`${result.stdout}${result.stderr}`).not.toMatch(/refusing|Tailscale forwarder|different hosts|CUTOVER_ENV|PROMOTED_COMMIT|uncommitted/);
  });

  it.each(['copy.sh', 'complete-tombstones.sh'])('%s: no image marker or railway ssh is left in it', (name) => {
    const source = readFileSync(script(name), 'utf8');
    expect(source).toMatch(/operator_check /);
    expect(source).not.toMatch(/ansari-auth-image|railway ssh/);
  });

  it('copy.sh prints counts and checksums only: no echo of a URL or row data', () => {
    const source = readFileSync(script('copy.sh'), 'utf8');
    expect(source).not.toMatch(/echo .*\$(APP|AUTH)_DATABASE_URL/);
    expect(source).toMatch(/set -euo pipefail/);
    expect(source).not.toMatch(/mktemp|> *\/tmp|tee /);
  });
});
