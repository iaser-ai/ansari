// Shared test plumbing: a pglite database built ONLY from this package's
// migration journal (never hand-written DDL), and the env createAuth() needs.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';

import { resetEnvCache, type Db } from '../../src/index';
import * as schema from '../../src/schema';

export const DRIZZLE_DIR = fileURLToPath(new URL('../../drizzle/', import.meta.url));

export type JournalEntry = { idx: number; tag: string };

export const journal: JournalEntry[] = (
  JSON.parse(readFileSync(`${DRIZZLE_DIR}meta/_journal.json`, 'utf8')) as {
    entries: JournalEntry[];
  }
).entries;

/**
 * A fresh pglite database with the journal applied in `_journal.json` order,
 * statement by statement, stopping after `through` when it is given.
 */
export async function migrate(through?: string): Promise<PGlite> {
  const client = new PGlite();
  const ordered = [...journal].sort((a, b) => a.idx - b.idx);
  for (const { tag } of ordered) {
    const sql = readFileSync(`${DRIZZLE_DIR}${tag}.sql`, 'utf8');
    for (const stmt of sql.split('--> statement-breakpoint')) {
      if (stmt.trim()) await client.exec(stmt);
    }
    if (tag === through) return client;
  }
  if (through) {
    await client.close();
    throw new Error(`migration ${through} is not in the auth journal`);
  }
  return client;
}

/**
 * A fresh, empty pglite database (no journal). apps/auth's cutover suite
 * builds the APP database in one from apps/api's journal.
 */
export function emptyDatabase(): PGlite {
  return new PGlite();
}

export function drizzleFor(client: PGlite): Db {
  return drizzle(client, { schema }) as unknown as Db;
}

export const TEST_JWT_ISSUER = 'https://auth.test.example';
export const TEST_JWT_AUDIENCE = 'ansari-api-test';
/** An ordinary address; it was the configured-admin address before the list was removed. */
export const TEST_ADMIN_EMAIL = 'admin@ansari.test';
/** apps/api's origin in tests: the Origin its layer sends. */
export const TEST_LAYER_ORIGIN = 'https://api.test.example';

export function setAuthEnv(baseUrl: string): void {
  process.env.DATABASE_URL = 'postgres://test:test@localhost:5432/test';
  process.env.BETTER_AUTH_SECRET = 'test-secret-at-least-32-characters-long-000';
  process.env.BETTER_AUTH_URL = baseUrl;
  process.env.CORS_ORIGIN = 'http://localhost:3100';
  process.env.AUTH_LAYER_ORIGIN = TEST_LAYER_ORIGIN;
  process.env.NODE_ENV = 'test';
  process.env.AUTH_JWT_ISSUER = TEST_JWT_ISSUER;
  process.env.AUTH_JWT_AUDIENCE = TEST_JWT_AUDIENCE;
  process.env.RESEND_API_KEY = 're_test_key_at_least_20_chars';
  process.env.FRONTEND_URL = 'http://localhost:8081';
  delete process.env.MARKETMAKER_URL;
  resetEnvCache();
}
