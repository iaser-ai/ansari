// A small interpreter for the subset of psql the cutover scripts use, so the
// suite runs the REAL files (apps/auth/scripts/cutover/*.sql) against pglite,
// unmodified. The real psql pipe is exercised in the phase 13 rehearsal.
//
// Supported: `\set NAME value`, `\echo`, `\pset` (output is always
// tuples-only, unaligned, '|'-separated), `\if :{?NAME}` / `\if :NAME` /
// `\else` / `\endif`, `\copy (…) TO pstdout` and `\copy table FROM pstdin`
// (through pglite's /dev/blob device), and `:'NAME'` / `:NAME` interpolation.
// ON_ERROR_STOP is always on: the first error throws. psql would then end the
// session, rolling back an open transaction and dropping TEMP tables; the
// harness does the same to the pglite instance (`ROLLBACK`, `DISCARD TEMP`),
// so a failed run leaves exactly what a failed psql session leaves.
import { readFileSync } from 'node:fs';

import type { PGlite, Results } from '@electric-sql/pglite';

export type PsqlRun = { stdout: string[]; echo: string[] };

const TRUE = new Set(['on', 'true', 'yes', '1']);

function interpolate(sql: string, vars: Record<string, string>): string {
  return sql
    .replace(/:'([A-Za-z_]\w*)'/g, (match, name: string) =>
      name in vars ? `'${(vars[name] ?? '').replace(/'/g, "''")}'` : match
    )
    .replace(/(?<![:\w]):([A-Za-z_]\w*)/g, (match, name: string) =>
      name in vars ? (vars[name] ?? '') : match
    );
}

function rowsOf(results: Results[]): string[] {
  return results.flatMap((r) =>
    r.fields.length === 0 ? [] : r.rows.map((row) => Object.values(row as object).map(String).join('|'))
  );
}

export async function runPsqlFile(
  client: PGlite,
  file: string,
  options: { vars?: Record<string, string>; stdin?: string } = {}
): Promise<PsqlRun> {
  const vars: Record<string, string> = { ...options.vars };
  const out: PsqlRun = { stdout: [], echo: [] };
  // Each entry: is this branch active, and has any branch of the \if run.
  const branches: { active: boolean; taken: boolean }[] = [];
  const active = () => branches.every((b) => b.active);
  let buffer = '';

  const flush = async () => {
    const sql = buffer.trim();
    buffer = '';
    if (!sql) return;
    out.stdout.push(...rowsOf(await client.exec(interpolate(sql, vars))));
  };

  const condition = (expr: string): boolean => {
    const defined = /^:\{\?([A-Za-z_]\w*)\}$/.exec(expr);
    if (defined) return (defined[1] as string) in vars;
    const value = /^:([A-Za-z_]\w*)$/.exec(expr);
    if (value) return TRUE.has((vars[value[1] as string] ?? '').toLowerCase());
    throw new Error(`psql harness: unsupported \\if ${expr}`);
  };

  try {
    for (const raw of readFileSync(file, 'utf8').split('\n')) {
      const line = raw.trim();
      if (!line.startsWith('\\')) {
        if (active()) buffer += `${raw}\n`;
        continue;
      }
      await flush();
      const [command = '', ...rest] = line.split(/\s+/);
      const arg = rest.join(' ');
      if (command === '\\if') {
        const take = active() && condition(arg);
        branches.push({ active: take, taken: take });
      } else if (command === '\\else') {
        const top = branches.at(-1);
        if (!top) throw new Error('psql harness: \\else without \\if');
        top.active = !top.taken && branches.slice(0, -1).every((b) => b.active);
        top.taken = top.taken || top.active;
      } else if (command === '\\endif') {
        branches.pop();
      } else if (!active()) {
        continue;
      } else if (command === '\\set') {
        const [name = '', ...value] = rest;
        vars[name] = value.join(' ');
      } else if (command === '\\echo') {
        out.echo.push(arg.replace(/^'|'$/g, ''));
      } else if (command === '\\pset') {
        // Output is always tuples-only and unaligned.
      } else if (command === '\\copy') {
        const to = /^(.*)\s+TO\s+pstdout$/i.exec(arg);
        const from = /^(\S+)\s+FROM\s+pstdin$/i.exec(arg);
        if (to) {
          const result = await client.query(`COPY ${interpolate(to[1] as string, vars)} TO '/dev/blob'`);
          out.stdout.push(result.blob ? await result.blob.text() : '');
        } else if (from) {
          await client.query(`COPY ${from[1]} FROM '/dev/blob'`, [], {
            blob: new Blob([options.stdin ?? '']),
          });
        } else {
          throw new Error(`psql harness: unsupported \\copy ${arg}`);
        }
      } else {
        throw new Error(`psql harness: unsupported meta-command ${command}`);
      }
    }
    await flush();
  } catch (error) {
    // The session ends: an open transaction rolls back, TEMP tables go.
    await client.exec('ROLLBACK').catch(() => undefined);
    await client.exec('DISCARD TEMP').catch(() => undefined);
    throw error;
  }
  // A psql session that ends normally also drops its TEMP tables.
  await client.exec('DISCARD TEMP');
  return out;
}
