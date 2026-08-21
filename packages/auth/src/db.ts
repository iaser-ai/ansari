// Drizzle client for the Better Auth stack.
//
// Design decision #1 (see codev/plans/59-*): the db client and schema live
// INSIDE packages/auth rather than a separate packages/db, so the whole auth
// stack is one self-contained unit that #60 can relocate or merge wholesale.
// It shares the physical database with apps/api via the same DATABASE_URL, but
// only through Better Auth's NEW tables — no shared Drizzle code.
//
// node-postgres' `drizzle(connectionString)` creates the pool lazily, so this
// module can be constructed without opening a connection; the first query is
// what connects.
import { drizzle } from 'drizzle-orm/node-postgres';

import { getEnv } from './env';
import * as schema from './schema';

export function createDb() {
  return drizzle(getEnv().DATABASE_URL, { schema });
}

export type Db = ReturnType<typeof createDb>;
