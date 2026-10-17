/**
 * Service base URL resolution.
 *
 * The app talks DIRECTLY to the deployed staging services by default
 * (`https://api-staging.askansari.ai` and `https://auth-staging.askansari.ai`);
 * frontend developers run nothing locally. Override with `EXPO_PUBLIC_API_URL`
 * and `EXPO_PUBLIC_AUTH_URL` (full URLs, scheme included) — e.g. to point at
 * local `apps/api` and `apps/auth` — but staging is the default so a fresh
 * checkout boots without any `.env.local`. The two defaults name the SAME
 * environment, so an env-less build never signs in at one environment and
 * calls the API of another.
 *
 * `EXPO_PUBLIC_*` vars are inlined at bundle time, so a change here requires an
 * `expo start` restart to take effect. Each `process.env.EXPO_PUBLIC_*` access
 * must stay a static member expression, or the bundler cannot inline it.
 */
export const DEFAULT_API_URL = 'https://api-staging.askansari.ai';
export const DEFAULT_AUTH_URL = 'https://auth-staging.askansari.ai';

function pick(configured: string | undefined, fallback: string): string {
  const trimmed = configured?.trim();
  const url = trimmed && trimmed.length > 0 ? trimmed : fallback;
  return url.replace(/\/+$/, '');
}

/** Resolve the `apps/api` base URL, trimming any trailing slash. */
export function resolveBaseUrl(): string {
  return pick(process.env.EXPO_PUBLIC_API_URL, DEFAULT_API_URL);
}

/** Resolve the `apps/auth` base URL, trimming any trailing slash. */
export function resolveAuthUrl(): string {
  return pick(process.env.EXPO_PUBLIC_AUTH_URL, DEFAULT_AUTH_URL);
}
