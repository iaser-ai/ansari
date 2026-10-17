import { getEnv } from '@/lib/config';

/**
 * True only in a running production Node server: never during `next build`
 * (whose worker sets NEXT_PHASE), never in dev/test/CI, never on edge.
 */
export function shouldValidateEnvAtBoot(env: NodeJS.ProcessEnv = process.env): boolean {
  return (
    env.NODE_ENV === 'production' &&
    env.NEXT_RUNTIME === 'nodejs' &&
    env.NEXT_PHASE !== 'phase-production-build'
  );
}

/**
 * Fail fast at production boot: parse the whole env (which, in production,
 * requires the apps/auth settings) so a misconfigured server refuses to start
 * rather than failing its first authenticated request. Throws the validation
 * error, which names variables and never their values.
 */
export function validateEnvAtBoot(env: NodeJS.ProcessEnv = process.env): void {
  if (shouldValidateEnvAtBoot(env)) getEnv();
}
