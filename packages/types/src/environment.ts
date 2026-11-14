/**
 * The deployment label (#314 Amendment 3, owner 2026-11-12): `ENVIRONMENT`,
 * named after the legacy frontend's `EXPO_PUBLIC_ENVIRONMENT` (apps/frontend has no such variable; parity there is a separate follow-up), in apps/api and
 * apps/auth. It is the Sentry environment of both services and the
 * environment segment of every service-key prefix (`ansari_<service>_<environment>_`).
 * NODE_ENV keeps its own jobs (test detection, production hardening);
 * ENVIRONMENT says which deployment this is. It has NO default (owner,
 * 2026-11-12): every process sets it, as it sets its secrets; local and CI
 * processes say `development` (the .env.example and .env.ci files do).
 */
export const ENVIRONMENTS = ['development', 'staging', 'production'] as const;

export type Environment = (typeof ENVIRONMENTS)[number];

/**
 * Why `environment` is not acceptable for a process running with `nodeEnv`,
 * or null when it is. Under NODE_ENV=production it is required and must be
 * `staging` or `production`: a deployed service labelled `development` is a
 * misconfiguration, so both services refuse to boot (names only, no values).
 */
export function environmentIssue(nodeEnv: string | undefined, environment: string | undefined): string | null {
  if (nodeEnv !== 'production') return null;
  if (environment === 'staging' || environment === 'production') return null;
  return 'ENVIRONMENT must be set to staging or production when NODE_ENV=production';
}
