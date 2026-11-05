#!/usr/bin/env node
// The auth database's migration journal, as the cutover applies and checks it
// (spec 329, main architect 2026-10-28): every migration in
// packages/auth/drizzle/meta/_journal.json, in `idx` order, so a later
// migration needs no runbook edit.
//
//   node apps/auth/scripts/cutover/auth-journal.mjs files   the SQL files, one per line, in order (relative to the cwd)
//   node apps/auth/scripts/cutover/auth-journal.mjs check   SQL that prints `<tag>|t` per migration
//                                                            and fails unless every one is applied
//   node apps/auth/scripts/cutover/auth-journal.mjs sql     every file in order, then the check as
//                                                            one assertion (copy.sh --dry-run's baseline)
//
// The check is derived from the SQL itself: each migration is applied when
// every schema, table, column, constraint and index it creates exists. A
// statement of any other kind is refused here, loudly, rather than left
// unchecked. Plain Node, no dependencies: it runs in the operator environment.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DRIZZLE = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../packages/auth/drizzle');

const die = (message) => {
  process.stderr.write(`auth-journal: ${message}\n`);
  process.exit(2);
};

/** The journal's migrations, in `idx` order, each with its file. */
export function migrations(drizzle = DRIZZLE) {
  const { entries } = JSON.parse(readFileSync(resolve(drizzle, 'meta/_journal.json'), 'utf8'));
  if (!Array.isArray(entries) || entries.length === 0) throw new Error('the journal has no entries');
  return [...entries]
    .sort((a, b) => a.idx - b.idx)
    .map(({ idx, tag }, i) => {
      if (idx !== i) throw new Error(`journal idx ${idx} out of sequence (expected ${i})`);
      const file = resolve(drizzle, `${tag}.sql`);
      if (!existsSync(file)) throw new Error(`${tag}.sql is in the journal but not on disk`);
      return { tag, file };
    });
}

const literal = (value) => `'${value.replace(/'/g, "''")}'`;

/** One SQL boolean per object a statement creates; throws on a statement it does not know. */
export function objectChecks(sql, tag = 'migration') {
  return sql
    .split('--> statement-breakpoint')
    .map((statement) => statement.replace(/^\s*--.*$/gm, '').trim())
    .filter(Boolean)
    .flatMap((statement) => {
      let m;
      if ((m = /^CREATE SCHEMA "([^"]+)"/.exec(statement))) {
        return [`exists (select 1 from pg_catalog.pg_namespace where nspname = ${literal(m[1])})`];
      }
      if ((m = /^CREATE TABLE "([^"]+)"\."([^"]+)"/.exec(statement))) {
        return [`to_regclass(${literal(`"${m[1]}"."${m[2]}"`)}) is not null`];
      }
      if ((m = /^CREATE (?:UNIQUE )?INDEX "([^"]+)" ON "([^"]+)"\./.exec(statement))) {
        return [`to_regclass(${literal(`"${m[2]}"."${m[1]}"`)}) is not null`];
      }
      if ((m = /^ALTER TABLE "([^"]+)"\."([^"]+)" ADD COLUMN "([^"]+)"/.exec(statement))) {
        return [
          `exists (select 1 from information_schema.columns where table_schema = ${literal(m[1])} and table_name = ${literal(m[2])} and column_name = ${literal(m[3])})`,
        ];
      }
      if ((m = /^ALTER TABLE "([^"]+)"\."([^"]+)" ADD CONSTRAINT "([^"]+)"/.exec(statement))) {
        return [
          `exists (select 1 from pg_catalog.pg_constraint c join pg_catalog.pg_class r on r.oid = c.conrelid join pg_catalog.pg_namespace n on n.oid = r.relnamespace where n.nspname = ${literal(m[1])} and r.relname = ${literal(m[2])} and c.conname = ${literal(m[3])})`,
        ];
      }
      throw new Error(`${tag}: a statement the journal check does not know: ${statement.split('\n')[0].slice(0, 80)}`);
    });
}

/** `(tag, applied)` rows for the whole journal, as a VALUES list. */
function appliedRows(list) {
  return list
    .map(({ tag, file }) => {
      const checks = objectChecks(readFileSync(file, 'utf8'), tag);
      if (checks.length === 0) throw new Error(`${tag}: creates nothing the check can see`);
      return `(${literal(tag)}, ${checks.map((c) => `(${c})`).join('\n    and ')})`;
    })
    .join(',\n  ');
}

/** Prints `<tag>|t` (or `|f`) per migration in order, then fails unless every one is applied. */
export function checkSql(list = migrations()) {
  const rows = appliedRows(list);
  return `select tag, applied from (values\n  ${rows}\n) as journal(tag, applied) order by tag;
do $check$
declare missing text;
begin
  select string_agg(tag, ', ' order by tag) into missing from (values\n  ${rows}\n) as journal(tag, applied) where not applied;
  if missing is not null then
    raise exception 'auth journal check: not applied: %', missing;
  end if;
end $check$;
`;
}

/** Every migration in order, then the same assertion, with a notice naming what is present. */
export function baselineSql(list = migrations()) {
  const rows = appliedRows(list);
  const files = list.map(({ tag, file }) => `-- ${tag}\n${readFileSync(file, 'utf8').trim()}\n`).join('\n');
  return `${files}
do $check$
declare missing text; present text;
begin
  select string_agg(tag, ', ' order by tag) filter (where not applied),
         string_agg(tag, ', ' order by tag) filter (where applied)
    into missing, present
    from (values\n  ${rows}\n) as journal(tag, applied);
  if missing is not null then
    raise exception 'auth journal check: not applied: %', missing;
  end if;
  raise notice 'auth journal check: applied inside this transaction: %', present;
end $check$;
`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const command = process.argv[2];
    if (command === 'files') process.stdout.write(`${migrations().map((m) => relative(process.cwd(), m.file)).join('\n')}\n`);
    else if (command === 'check') process.stdout.write(checkSql());
    else if (command === 'sql') process.stdout.write(baselineSql());
    else die('usage: auth-journal.mjs files | check | sql');
  } catch (err) {
    die(err instanceof Error ? err.message : String(err));
  }
}
