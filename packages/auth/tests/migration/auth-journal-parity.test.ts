// Code-vs-migration drift guard for the AUTH database (spec 300; the apps/api
// counterpart is apps/api/tests/migration/migration-schema-parity.test.ts,
// issue #165).
//
// The database is built ONLY from this package's journal, in `_journal.json`
// order, and every column the Drizzle schema declares must exist in it, so the
// schema can never run ahead of its migrations.
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { is } from 'drizzle-orm';
import { getTableConfig, PgTable, pgTable, text } from 'drizzle-orm/pg-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createAuth } from '../../src/index';
import * as schema from '../../src/schema';
import { DRIZZLE_DIR, drizzleFor, journal, migrate, setAuthEnv } from '../helpers/auth-db';

// Last auth-journal migration applied to the production auth database. Owner:
// the main architect. It stays `null` until the cutover window applies the
// journal: nothing is deployed yet, so the deployed-state test below is
// skipped, loudly. Setting it is a DECLARATION that the migration is applied
// in production; it is not evidence that anyone applied it.
const AUTH_DEPLOYED_THROUGH: string | null = null;

// The cutover's record of the apply. Once a release note in RELEASE.md or a
// docs/ page carries this line, a `null` AUTH_DEPLOYED_THROUGH fails.
const APPLY_RECORD = /^auth-journal-applied:\s*(\d{4}_[a-z0-9_]+)\s*$/m;

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

function recordedApplies(): string[] {
  const files = [`${REPO_ROOT}RELEASE.md`];
  const docs = `${REPO_ROOT}docs/`;
  for (const entry of readdirSync(docs, { recursive: true, encoding: 'utf8' })) {
    if (entry.endsWith('.md')) files.push(`${docs}${entry}`);
  }
  const tags: string[] = [];
  for (const file of files) {
    const match = readFileSync(file, 'utf8').match(new RegExp(APPLY_RECORD.source, 'gm'));
    for (const line of match ?? []) tags.push(APPLY_RECORD.exec(line)![1]);
  }
  return tags;
}

type Columns = Map<string, Set<string>>;

async function journalColumns(): Promise<Columns> {
  const client = await migrate();
  try {
    const { rows } = await client.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'auth'`
    );
    const columns: Columns = new Map();
    for (const r of rows) {
      if (!columns.has(r.table_name)) columns.set(r.table_name, new Set());
      columns.get(r.table_name)!.add(r.column_name);
    }
    return columns;
  } finally {
    await client.close();
  }
}

function declaredTables(source: Record<string, unknown>): PgTable[] {
  return Object.values(source).filter((v): v is PgTable => is(v, PgTable));
}

/** `schema.table.column` for every declared column the journal does not create. */
function missingFromJournal(tables: PgTable[], columns: Columns): string[] {
  const missing: string[] = [];
  for (const table of tables) {
    const { schema: pgSchemaName, name, columns: declared } = getTableConfig(table);
    for (const col of declared) {
      if (pgSchemaName !== 'auth' || !columns.get(name)?.has(col.name)) {
        missing.push(`${pgSchemaName ?? 'public'}.${name}.${col.name}`);
      }
    }
  }
  return missing;
}

describe('auth migration files', () => {
  it('journal and .sql files agree one-to-one', () => {
    const files = readdirSync(DRIZZLE_DIR)
      .filter((f) => f.endsWith('.sql'))
      .map((f) => f.replace(/\.sql$/, ''))
      .sort();
    expect(files).toEqual(journal.map((e) => e.tag).sort());
  });

  it('the journal is the single fresh 0000 (the #59 scaffold 0000 is gone)', () => {
    expect(journal.map((e) => e.idx)).toEqual([0]);
    expect(journal[0].tag).not.toBe('0000_better_auth_init');
  });
});

describe('Drizzle schema vs the auth journal', () => {
  let columns: Columns;

  beforeAll(async () => {
    columns = await journalColumns();
  });

  it('every column the schema declares is created by the journal, in the auth schema', () => {
    const tables = declaredTables(schema);
    expect(tables.map((t) => getTableConfig(t).name).sort()).toEqual([
      'account',
      'jwks',
      'rate_limit',
      'session',
      'users',
      'verification',
    ]);
    expect(missingFromJournal(tables, columns)).toEqual([]);
  });

  it('the journal creates no auth column the schema does not declare', () => {
    const declared = new Map(
      declaredTables(schema).map((t) => {
        const { name, columns: cols } = getTableConfig(t);
        return [name, new Set(cols.map((c) => c.name))] as const;
      })
    );
    const extra: string[] = [];
    for (const [table, cols] of columns) {
      for (const col of cols) if (!declared.get(table)?.has(col)) extra.push(`${table}.${col}`);
    }
    expect(extra).toEqual([]);
  });

  // The guard's negative test: a column added to the schema but not to the
  // journal must be reported, or the check above could pass by not checking.
  it('reports a column declared in the schema but absent from the journal', () => {
    const drifted = schema.authSchema.table('users', {
      id: text('id'),
      notInJournal: text('not_in_journal'),
    });
    expect(missingFromJournal([drifted], columns)).toEqual(['auth.users.not_in_journal']);
  });

  it('reports a table declared outside the auth schema', () => {
    const misplaced = pgTable('users', { id: text('id') });
    expect(missingFromJournal([misplaced], columns)).toEqual(['public.users.id']);
  });
});

describe('the cutover apply record', () => {
  it('the record pattern matches a canonical line and rejects near-misses', () => {
    expect(APPLY_RECORD.exec('auth-journal-applied: 0000_auth_schema')?.[1]).toBe('0000_auth_schema');
    expect(APPLY_RECORD.exec('notes\nauth-journal-applied: 0001_x\n')?.[1]).toBe('0001_x');
    expect(APPLY_RECORD.test('auth-journal-applied:')).toBe(false);
    expect(APPLY_RECORD.test('auth-journal-applied: TBD')).toBe(false);
    expect(APPLY_RECORD.test('Record `auth-journal-applied: 0000_auth_schema` here')).toBe(false);
  });

  it('AUTH_DEPLOYED_THROUGH is set once the cutover records the auth journal apply', () => {
    const recorded = recordedApplies();
    if (AUTH_DEPLOYED_THROUGH === null) {
      expect(
        recorded,
        'the cutover recorded an auth journal apply; set AUTH_DEPLOYED_THROUGH to it'
      ).toEqual([]);
    } else {
      expect(recorded).toContain(AUTH_DEPLOYED_THROUGH);
      expect(journal.map((e) => e.tag)).toContain(AUTH_DEPLOYED_THROUGH);
    }
  });
});

describe('better-auth on the deployed auth journal', () => {
  const deployed = AUTH_DEPLOYED_THROUGH;

  afterAll(() => {
    if (deployed === null) {
      console.warn(
        '[auth-journal-parity] SKIPPED the deployed-state test: AUTH_DEPLOYED_THROUGH is null ' +
          '(the auth database is not deployed yet; it is set at the cutover window).'
      );
    }
  });

  it.skipIf(deployed === null)(
    'SKIPPED until the cutover: signs up and in against the migrations deployed in production',
    async () => {
      const client = await migrate(deployed!);
      try {
        setAuthEnv('http://localhost:3100');
        const auth = createAuth(drizzleFor(client));
        const body = { name: 'Parity', email: 'parity@example.com', password: 'correct-horse-battery' };
        await auth.api.signUpEmail({ body });
        const signIn = await auth.api.signInEmail({ body });
        expect(signIn.user.email).toBe(body.email);
      } finally {
        await client.close();
      }
    }
  );
});
