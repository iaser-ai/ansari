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

  // A browser SILENTLY DISCARDS a `Secure` cookie sent over plain HTTP, so
  // hardcoding secure:true breaks local web login (http://localhost:8081) with
  // no visible error. Tie cookie security to the actual transport: Secure iff
  // the service is served over HTTPS (its baseURL is https).
  const secureCookies = env.BETTER_AUTH_URL.startsWith('https://');

  return betterAuth({
    database: drizzleAdapter(db, {
      provider: 'pg',
      schema,
    }),
    // CORS_ORIGIN is the web origin; the rest are the Expo app's origins. The
    // custom scheme MUST match apps/frontend/app.json (`"scheme": "askansari"`)
    // — a native request carries `expo-origin: askansari://…`, and a mismatch
    // fails origin validation in production. `exp://` is Expo Go; the
    // `http://localhost:8081` is Metro's web/dev origin.
    trustedOrigins: [env.CORS_ORIGIN, 'askansari://', 'exp://', 'http://localhost:8081'],
    emailAndPassword: {
      enabled: true,
    },
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL,
    advanced: {
      defaultCookieAttributes: {
        // sameSite:'none' lets the session cookie ride cross-origin requests
        // from the Expo app / a web client on a different origin. But the cookie
        // spec REQUIRES Secure alongside SameSite=None, and Secure needs HTTPS —
        // so over plain HTTP (local dev) we must drop to 'lax' + non-Secure or
        // the browser discards the cookie. Both attributes track the transport
        // together via `secureCookies`.
        sameSite: secureCookies ? 'none' : 'lax',
        secure: secureCookies,
        httpOnly: true,
      },
    },
    plugins: [expo()],
  });
}

export type Auth = ReturnType<typeof createAuth>;
