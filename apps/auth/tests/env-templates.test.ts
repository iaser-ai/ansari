// The env templates against the schema that validates them
// (packages/auth/src/env.ts). Names only: no value is printed. A schema key
// missing from .env.example means a contributor's copied .env cannot boot the
// service; a required key missing from .env.ci means CI runs without it.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { envSchema } from '@ansari/auth/env';
import { describe, expect, it } from 'vitest';

const read = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../${name}`, import.meta.url)), 'utf8');

/** `KEY=value` lines, as dotenv reads them (comments and blanks skipped). */
function assignments(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split('\n')) {
    const m = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line.trim());
    if (m) out.set(m[1] as string, (m[2] as string).trim());
  }
  return out;
}

/** Keys documented but commented out (`# KEY=…`): optional values left unset. */
function commentedKeys(text: string): Set<string> {
  return new Set(
    [...text.matchAll(/^#\s*([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1] as string)
  );
}

const SCHEMA_KEYS = Object.keys(envSchema.shape).sort();
const REQUIRED_KEYS = SCHEMA_KEYS.filter(
  (key) => !envSchema.shape[key as keyof typeof envSchema.shape].safeParse(undefined).success
);

/** The issues' variable names only; values never leave the parser. */
function failingKeys(env: Map<string, string>): string[] {
  const result = envSchema.safeParse(Object.fromEntries(env));
  return result.success ? [] : [...new Set(result.error.issues.map((i) => String(i.path[0])))];
}

describe('apps/auth/.env.example', () => {
  const text = read('.env.example');
  const set = assignments(text);
  const documented = new Set([...set.keys(), ...commentedKeys(text)]);

  it('names every variable the schema declares, and nothing else', () => {
    expect(SCHEMA_KEYS.length).toBeGreaterThanOrEqual(13);
    expect(SCHEMA_KEYS.filter((key) => !documented.has(key))).toEqual([]);
    expect([...documented].filter((key) => !SCHEMA_KEYS.includes(key))).toEqual([]);
  });

  it('as copied, passes the schema (the service can boot from it)', () => {
    expect(failingKeys(set)).toEqual([]);
  });

  it("allows the Metro web origin in development", () => {
    expect(set.get('CORS_ORIGIN')?.split(',').map((o) => o.trim())).toContain('http://localhost:8081');
  });
});

describe('apps/auth/.env.ci', () => {
  const set = assignments(read('.env.ci'));

  it('sets every variable the schema requires', () => {
    expect(REQUIRED_KEYS.length).toBeGreaterThanOrEqual(9);
    expect(REQUIRED_KEYS.filter((key) => !set.has(key))).toEqual([]);
  });

  it('passes the schema', () => {
    expect(failingKeys(set)).toEqual([]);
  });
});
