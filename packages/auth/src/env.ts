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

/** Exported for the env-template test (apps/auth/tests/env-templates.test.ts). */
export const envSchema = z.object({
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  BETTER_AUTH_SECRET: z
    .string()
    .min(32, 'BETTER_AUTH_SECRET must be at least 32 characters'),
  BETTER_AUTH_URL: z.string().url('BETTER_AUTH_URL must be a valid URL'),
  // Comma-separated exact web origins (apps/frontend's), for CORS and
  // trustedOrigins. One origin is a list of one.
  CORS_ORIGIN: z
    .string()
    .transform((raw) =>
      raw
        .split(',')
        .map((o) => o.trim())
        .filter((o) => o.length > 0)
    )
    .pipe(z.array(z.url('CORS_ORIGIN must be a comma list of URLs')).min(1)),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  // apps/api's own origin, sent as `Origin` by its /v2/users/* layer, whose
  // server-side fetch carries Sec-Fetch-Mode and so meets better-auth's CSRF
  // check. It joins trustedOrigins ONLY, never the CORS allowlist, so a
  // browser on that origin gets no CORS allow headers (spec 300 phase 8).
  AUTH_LAYER_ORIGIN: z.url('AUTH_LAYER_ORIGIN must be a valid URL'),

  // JWT claims (spec 300). `iss` is this service's public origin
  // (https://auth.askansari.ai, or auth-staging in staging); `aud` names
  // apps/api. Both are set explicitly so they never silently follow baseURL.
  AUTH_JWT_ISSUER: z.string().url('AUTH_JWT_ISSUER must be a valid URL'),
  AUTH_JWT_AUDIENCE: z.string().min(1, 'AUTH_JWT_AUDIENCE is required'),
  // Reset emails are sent from here after cutover. Never logged.
  RESEND_API_KEY: z.string().min(20, 'RESEND_API_KEY must be at least 20 characters'),
  // Base of the emailed reset link: `${FRONTEND_URL}/reset-password?token=…`.
  FRONTEND_URL: z.string().url('FRONTEND_URL must be a valid URL'),
  // Optional newsletter integration; unset disables the opt-in subscribe.
  MARKETMAKER_URL: z.string().url('MARKETMAKER_URL must be a valid URL').optional(),
  // apps/auth's one listener, behind the public domain. There is no internal
  // listener and no shared credential (owner amendment, 2026-10-17).
  PORT: z.coerce.number().int().min(1).max(65535).default(3100),
  // apps/auth's Sentry project (the list-walk alert). Unset disables sending.
  SENTRY_DSN: z.string().url('SENTRY_DSN must be a valid URL').optional(),
});

export type AuthEnv = z.output<typeof envSchema>;

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
        `(BETTER_AUTH_SECRET must be >= 32 chars, RESEND_API_KEY >= 20; ` +
        `BETTER_AUTH_URL, AUTH_JWT_ISSUER and FRONTEND_URL must be URLs; CORS_ORIGIN a comma list of URLs).`
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
