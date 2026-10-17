import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const BDD_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const envFile = path.join(BDD_DIR, '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

const value = (name: string): string | undefined => {
  const v = process.env[name]?.trim();
  return v ? v : undefined;
};

/**
 * Fail loudly, naming every missing setting, instead of letting a scenario run
 * half-configured and report something misleading.
 */
export function requireSettings(names: string[], why: string): void {
  const missing = names.filter((n) => !value(n));
  if (missing.length > 0) {
    throw new Error(`${why}: set ${missing.join(', ')} in bdd/.env (see bdd/.env.example)`);
  }
}

export function hasRealGemini(): boolean {
  return !!(value('GOOGLE_CLOUD_PROJECT') || value('GEMINI_API_KEY'));
}

/** The local test database, as your own Postgres user. */
export const DEFAULT_DATABASE_URL = `postgresql://${os.userInfo().username}@localhost:5432/ansari_bdd`;

export const settings = {
  databaseUrl: value('DATABASE_URL') ?? DEFAULT_DATABASE_URL,
  apiDir: path.resolve(BDD_DIR, value('API_DIR') ?? '../apps/api'),
  apiNode: value('API_NODE') ?? process.execPath,
  value,
};
