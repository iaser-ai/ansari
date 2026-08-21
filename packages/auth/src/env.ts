// Self-contained env contract for the Better Auth stack.
//
// Design decision #2 (see codev/plans/59-*): validate with a small zod schema
// that mirrors apps/api's lib/config.ts (lazy, memoized, fail-fast on first
// ACCESS) rather than pulling in @t3-oss/env-core. This keeps the auth stack
// self-contained, consistent with the rest of the repo, and free of a dep that
// would otherwise need pinning (the workspace catalog is not extended for #59).
//
// Validation is lazy so that merely IMPORTING @ansari/auth does not throw when
// env is absent (e.g. `tsc`/`tsdown` never execute the module; tests set env
// explicitly). It runs the first time `getEnv()` is called — which is inside
// `createAuth()`/`createDb()`.
import { z } from 'zod';

const envSchema = z.object({
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  BETTER_AUTH_SECRET: z
    .string()
    .min(32, 'BETTER_AUTH_SECRET must be at least 32 characters'),
  BETTER_AUTH_URL: z.string().url('BETTER_AUTH_URL must be a valid URL'),
  CORS_ORIGIN: z.string().url('CORS_ORIGIN must be a valid URL'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
});

export type AuthEnv = z.infer<typeof envSchema>;

let cachedEnv: AuthEnv | null = null;

export function getEnv(): AuthEnv {
  if (cachedEnv) {
    return cachedEnv;
  }

  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    // Name the offending vars and point at the template — this fires when the
    // auth service is started without its env (e.g. `pnpm auth dev` before
    // copying apps/auth/.env.example → .env). apps/auth is deliberately NOT in
    // the default `pnpm dev` graph, so this never breaks a fresh contributor's
    // `pnpm dev`; it only surfaces when someone runs auth on purpose.
    const vars = [...new Set(result.error.issues.map((i) => String(i.path[0])))].join(', ');
    throw new Error(
      `@ansari/auth env validation failed for: ${vars}. ` +
        `Set these before running the auth service — see apps/auth/.env.example ` +
        `(BETTER_AUTH_SECRET must be >= 32 chars; BETTER_AUTH_URL and CORS_ORIGIN must be URLs).`
    );
  }

  cachedEnv = result.data;
  return cachedEnv;
}

/**
 * Test-only: clear the memoized env so a subsequent `getEnv()` re-parses
 * `process.env`. Mirrors apps/api's `resetEnvCache`.
 */
export function resetEnvCache(): void {
  cachedEnv = null;
}
