import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from '@/db/schema';

// Create a singleton pool
let pool: Pool | null = null;

function getPool(): Pool {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error('DATABASE_URL environment variable is not set');
    }
    pool = new Pool({
      connectionString,
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });
  }
  return pool;
}

// Create drizzle instance with schema
export const db = drizzle(getPool(), { schema });

// Export schema for convenience
export { schema };

// Close pool (for graceful shutdown)
export async function closeDb() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
