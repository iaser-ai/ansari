import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from '@/db/schema';
import { config } from '@/lib/config';

// Create a singleton pool
let pool: Pool | null = null;

function getPool(): Pool {
  if (!pool) {
    // Sourced through validated config (not raw process.env) so the schema's
    // DATABASE_URL validation always runs before a connection is attempted.
    const connectionString = config.database.url;
    pool = new Pool({
      connectionString,
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });
  }
  return pool;
}

type Database = NodePgDatabase<typeof schema> & { $client: Pool };

let instance: Database | null = null;

function getDb(): Database {
  if (!instance) {
    instance = drizzle(getPool(), { schema });
  }
  return instance;
}

// Drizzle instance with schema, created on first use rather than at import
// (issue #260). `next build` imports route modules to collect page data; an
// eager pool here read `config.database.url` at load, which Zod-validates the
// whole env, so the build demanded every runtime secret. Validation is not
// weakened: the first real access still runs getEnv() and throws on a bad env,
// and src/instrumentation.ts validates the env at production server boot
// (lib/boot-check.ts). The facade is read-only: writes throw
// rather than landing on the empty target and vanishing.
export const db: Database = new Proxy({} as Database, {
  get(_target, prop) {
    const real = getDb();
    const value = Reflect.get(real, prop, real);
    return typeof value === 'function' ? value.bind(real) : value;
  },
  has(_target, prop) {
    return Reflect.has(getDb(), prop);
  },
  set(_target, prop) {
    throw new TypeError(`db is a lazy read-only facade; cannot set ${String(prop)}`);
  },
});

// A database executor: either the module-level `db` or a transaction handle
// passed to `db.transaction(async (tx) => ...)`. DB helpers accept this so a
// caller can compose multi-step writes into one transaction. Shared by
// users.ts, threads.ts, and feedback.ts (issue #20).
export type Executor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

// Export schema for convenience
export { schema };

// Close pool (for graceful shutdown)
export async function closeDb() {
  if (pool) {
    await pool.end();
    pool = null;
    instance = null;
  }
}
