/**
 * Shared setup for the spec 329 operator-run probes against a throwaway local
 * Postgres container: the URL guard, a fresh auth schema from the journal, and
 * the env createAuth() needs. Never pointed at a real database.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { Client } from 'pg';

import { resetEnvCache } from '../../src/index';
import { setAuthEnv } from '../../tests/helpers/auth-db';

const DRIZZLE_DIR = fileURLToPath(new URL('../../drizzle/', import.meta.url));

/**
 * The probe's URL argument, refused unless it names 127.0.0.1 or localhost.
 * The URL is an argument, never read from the environment, so an inherited
 * variable can never point a probe at a real database.
 */
export function localUrlFromArgs(usage: string): { url: string; host: string } {
  const url = process.argv[2];
  if (!url) {
    console.error(`Usage: ${usage} <postgres URL of a throwaway local container>`);
    process.exit(2);
  }
  const host = new URL(url).hostname;
  if (host !== '127.0.0.1' && host !== 'localhost') {
    console.error(`Refusing to run against ${host}: this probe drops the auth schema. Local containers only.`);
    process.exit(2);
  }
  return { url, host };
}

export async function connect(url: string): Promise<Client> {
  const client = new Client({ connectionString: url });
  await client.connect();
  return client;
}

export async function serverVersion(url: string): Promise<string> {
  const server = await connect(url);
  try {
    const { rows } = await server.query<{ server_version: string }>('SHOW server_version');
    return rows[0]!.server_version;
  } finally {
    await server.end();
  }
}

/** Drop the auth schema and rebuild it from the journal, in order. */
export async function resetSchema(url: string): Promise<void> {
  const client = await connect(url);
  try {
    await client.query('DROP SCHEMA IF EXISTS auth CASCADE');
    const journal = JSON.parse(readFileSync(`${DRIZZLE_DIR}meta/_journal.json`, 'utf8')) as {
      entries: { idx: number; tag: string }[];
    };
    for (const { tag } of [...journal.entries].sort((a, b) => a.idx - b.idx)) {
      const text = readFileSync(`${DRIZZLE_DIR}${tag}.sql`, 'utf8');
      for (const stmt of text.split('--> statement-breakpoint')) if (stmt.trim()) await client.query(stmt);
    }
  } finally {
    await client.end();
  }
}

/**
 * The tests' own env (`setAuthEnv`, the adjudicated placeholders in
 * .gitleaks.toml), with only the database URL pointed at the probe's container.
 * Never invent new placeholder secrets here: each one is a gitleaks finding.
 */
export function setProbeEnv(url: string): void {
  setAuthEnv('http://localhost:3100');
  process.env.DATABASE_URL = url;
  resetEnvCache();
}
