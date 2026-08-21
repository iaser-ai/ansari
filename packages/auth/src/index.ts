// Better Auth configuration — the whole auth "brain" for the Ansari monorepo.
//
// Adapted from the Better-T-Stack scaffold's packages/auth/src/index.ts, with
// the db client and env contract folded in (design decisions #1/#2) so this
// package is self-contained. apps/auth is the runnable service that mounts it.
import { expo } from '@better-auth/expo';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';

import { createDb, type Db } from './db';
import { getEnv } from './env';
import * as schema from './schema';

export * as schema from './schema';
export { createDb, type Db } from './db';
export { getEnv, resetEnvCache, type AuthEnv } from './env';

/**
 * Build a configured Better Auth instance.
 *
 * @param db - optional Drizzle client. Defaults to the package's own
 *   node-postgres client. Injectable so tests can pass a throwaway database.
 */
export function createAuth(db: Db = createDb()) {
  const env = getEnv();

  return betterAuth({
    database: drizzleAdapter(db, {
      provider: 'pg',
      schema,
    }),
    // Kept from the scaffold — directly relevant to apps/frontend (Expo).
    // CORS_ORIGIN is the web origin; the custom schemes + :8081 are Expo's.
    trustedOrigins: [env.CORS_ORIGIN, 'ansari://', 'exp://', 'http://localhost:8081'],
    emailAndPassword: {
      enabled: true,
    },
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL,
    advanced: {
      defaultCookieAttributes: {
        sameSite: 'none',
        secure: true,
        httpOnly: true,
      },
    },
    plugins: [expo()],
  });
}

export type Auth = ReturnType<typeof createAuth>;
