// auth-journal.mjs (main architect, 2026-10-28): the cutover applies and checks the WHOLE auth
// journal, in _journal.json order, with a per-migration check derived from the SQL, so a later
// migration needs no runbook edit. The check runs here against pglite built from the journal.
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { journal, migrate } from '../../../../packages/auth/tests/helpers/auth-db';
// @ts-expect-error: a plain .mjs operator script, no type declarations
import { checkSql, migrations, objectChecks } from '../../scripts/cutover/auth-journal.mjs';

type Migration = { tag: string; file: string };
const all = () => migrations() as Migration[];

describe('auth-journal.mjs', () => {
  it('lists every journal entry, in idx order, each file on disk', () => {
    const tags = [...journal].sort((a, b) => a.idx - b.idx).map((e) => e.tag);
    expect(all().map((m) => m.tag)).toEqual(tags);
    expect(tags.length).toBeGreaterThanOrEqual(2);
  });

  it('derives a check for every object each migration creates', () => {
    const [m0000, m0001] = all();
    const created = (file: string) => objectChecks(readFileSync(file, 'utf8')) as string[];
    // 0000: the schema, 7 tables... counted from the SQL, never hardcoded in a runbook.
    expect(created(m0000!.file).length).toBe(readFileSync(m0000!.file, 'utf8').split('--> statement-breakpoint').filter((s) => s.trim()).length);
    const c0001 = created(m0001!.file).join('\n');
    expect(c0001).toContain(`to_regclass('"auth"."apikey"')`);
    expect(c0001).not.toContain('phone_number');
    expect(c0001).toContain("c.conname = 'account_provider_id_account_id_unique'");
  });

  // No current migration adds a column, so this keeps the ADD COLUMN branch covered for the next one.
  it('derives a column check from an ADD COLUMN statement', () => {
    const checks = objectChecks('ALTER TABLE "auth"."users" ADD COLUMN "x" text;', '0002_add') as string[];
    expect(checks).toHaveLength(1);
    expect(checks[0]).toContain("table_schema = 'auth' and table_name = 'users' and column_name = 'x'");
  });

  it('refuses a statement kind it cannot check, naming the migration', () => {
    expect(() => objectChecks('ALTER TABLE "auth"."users" DROP COLUMN "x";', '0002_drop')).toThrow(
      /0002_drop: a statement the journal check does not know/
    );
  });

  it('the check passes on the whole journal, one <tag>|t per migration in order', async () => {
    const client = await migrate();
    try {
      const results = await client.exec(checkSql() as string);
      const rows = results.flatMap((r) => r.rows.map((row) => Object.values(row as object).map(String).join('|')));
      expect(rows).toEqual(all().map((m) => `${m.tag}|true`));
    } finally {
      await client.close();
    }
  });

  it('the check fails, naming the migration, on a database migrated only through 0000', async () => {
    const client = await migrate('0000_auth_schema');
    try {
      await expect(client.exec(checkSql() as string)).rejects.toThrow(/auth journal check: not applied: 0001_api_key/);
    } finally {
      await client.close();
    }
  });

  it('a check that only knew 0000 would pass there: the journal-derived check is what catches 0001', async () => {
    const client = await migrate('0000_auth_schema');
    try {
      await expect(client.exec(checkSql(all().slice(0, 1)) as string)).resolves.toBeDefined();
    } finally {
      await client.close();
    }
  });
});
