import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Issue #260: `next build` imports route modules to collect page data. When
// lib/db/index.ts created its pool at import, that import read
// config.database.url, Zod-validated the whole env, and failed the build on a
// machine with no runtime secrets. The handle must be created on first use,
// and that first use must still fail loudly on a bad env.

const REQUIRED_ENV: Record<string, string> = {
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
  KALEMAT_API_KEY: 'placeholder-key',
  USUL_API_TOKEN: 'placeholder-token',
};

let savedEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  savedEnv = { ...process.env };
  vi.resetModules();
});

afterEach(async () => {
  process.env = savedEnv;
  const { resetEnvCache } = await import('@/lib/config');
  resetEnvCache();
});

describe('lib/db/index lazy initialisation', () => {
  it('imports without reading the env, then throws the validation error on first access', async () => {
    for (const k of Object.keys(REQUIRED_ENV)) delete process.env[k];

    const mod = await import('@/lib/db/index');

    expect(() => mod.db.select).toThrow(/Environment validation failed/);
    expect(() => mod.db.select).toThrow(/DATABASE_URL/);
  });

  it('creates the drizzle handle on first access with a valid env', async () => {
    for (const [k, v] of Object.entries(REQUIRED_ENV)) process.env[k] = v;

    const { db, closeDb } = await import('@/lib/db/index');

    expect(typeof db.select).toBe('function');
    expect(typeof db.transaction).toBe('function');
    expect('query' in db).toBe(true);
    // No connection is opened until a query runs, so this needs no database.
    expect(db.select().from).toBeTypeOf('function');
    await closeDb();
  });

  it('rejects writes instead of silently dropping them on the facade', async () => {
    const { db } = await import('@/lib/db/index');

    expect(() => {
      (db as unknown as Record<string, unknown>).select = () => null;
    }).toThrow(/read-only facade/);
  });
});
