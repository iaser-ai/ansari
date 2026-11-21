/**
 * Build guard for the web image (#317), run by `Dockerfile.web` before
 * `build:web`:
 *
 *   node scripts/check-web-env.mjs
 *
 * `EXPO_PUBLIC_API_URL` and `EXPO_PUBLIC_AUTH_URL` are baked into the bundle
 * at export time. Unset, `lib/api/config.ts` falls back to the STAGING hosts,
 * so a production image built without them would build, deploy green, and
 * sign real users in against staging. This turns that into a build failure.
 *
 *   - Both are required in EVERY environment (no production flag: a flag is a
 *     check that passes by never being set). Staging sets its staging values.
 *   - Each must be an http(s) URL with a host. (`new URL` alone is not
 *     enough: `api.askansari.ai:443` parses, as scheme `api.askansari.ai:`
 *     with an empty host, and would slip past the pair check.)
 *   - A production api host and the production auth host only come as a
 *     pair: one without the other fails, showing both values.
 *
 * Plain Node, no dependencies: the image installs with
 * `--filter ansari-frontend`, so root devDependencies are absent.
 */
import { fileURLToPath } from 'node:url';

/** Both domains of the production `backend` service (docs/cutover/deploy-guide.md). */
export const PRODUCTION_API_HOSTS = ['api.askansari.ai', 'api-35.ansari.chat'];
export const PRODUCTION_AUTH_HOST = 'auth.askansari.ai';

const REQUIRED = ['EXPO_PUBLIC_API_URL', 'EXPO_PUBLIC_AUTH_URL'];

/** The URL's hostname, or null unless it is an http(s) URL with a host. */
function hostOf(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  return url.hostname || null;
}

/**
 * Check the web build environment. Returns the list of problems; empty means
 * the build may proceed.
 *
 * @param {Record<string, string | undefined>} env
 * @returns {string[]}
 */
export function checkWebEnv(env) {
  const errors = [];
  const values = {};
  for (const name of REQUIRED) {
    const value = env[name]?.trim();
    if (!value) {
      errors.push(
        `${name} is unset or empty. Set it as a build variable on the web service ` +
          `(it is baked into the bundle; the staging default is never used in an image).`,
      );
    } else if (hostOf(value) === null) {
      errors.push(`${name} is not an http(s) URL with a host: ${JSON.stringify(value)}`);
    } else {
      values[name] = value;
    }
  }
  if (errors.length > 0) return errors;

  const api = values.EXPO_PUBLIC_API_URL;
  const auth = values.EXPO_PUBLIC_AUTH_URL;
  const apiIsProd = PRODUCTION_API_HOSTS.includes(hostOf(api));
  const authIsProd = hostOf(auth) === PRODUCTION_AUTH_HOST;
  if (apiIsProd !== authIsProd) {
    errors.push(
      `EXPO_PUBLIC_API_URL and EXPO_PUBLIC_AUTH_URL name different environments: ` +
        `a production api host (${PRODUCTION_API_HOSTS.join(', ')}) and ${PRODUCTION_AUTH_HOST} ` +
        `must be set together.\n` +
        `  EXPO_PUBLIC_API_URL=${api}\n` +
        `  EXPO_PUBLIC_AUTH_URL=${auth}`,
    );
  }
  return errors;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const errors = checkWebEnv(process.env);
  if (errors.length > 0) {
    for (const error of errors) console.error(`check-web-env: ${error}`);
    process.exit(1);
  }
  console.log(
    `check-web-env: ok — EXPO_PUBLIC_API_URL=${process.env.EXPO_PUBLIC_API_URL.trim()} ` +
      `EXPO_PUBLIC_AUTH_URL=${process.env.EXPO_PUBLIC_AUTH_URL.trim()}`,
  );
}
