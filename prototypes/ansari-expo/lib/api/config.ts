/**
 * API base URL resolution for the prototype.
 *
 * The prototype talks DIRECTLY to the deployed staging backend
 * (`https://api-staging.askansari.ai`); frontend developers run nothing
 * locally. Override with `EXPO_PUBLIC_API_URL` (a full URL, scheme included) —
 * e.g. to point at a personal tunnel — but staging is the default so a fresh
 * checkout boots without any `.env.local`.
 *
 * `EXPO_PUBLIC_*` vars are inlined at bundle time, so a change here requires an
 * `expo start` restart to take effect.
 */
export const DEFAULT_API_URL = 'https://api-staging.askansari.ai';

/** Resolve the API base URL, trimming any trailing slash. */
export function resolveBaseUrl(): string {
  const configured = process.env.EXPO_PUBLIC_API_URL?.trim();
  const url = configured && configured.length > 0 ? configured : DEFAULT_API_URL;
  return url.replace(/\/+$/, '');
}
