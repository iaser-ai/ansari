/**
 * Shared ESLint flat-config base.
 *
 * Deliberately minimal. The two apps' configs have almost nothing in common —
 * apps/api bridges eslint-config-next through FlatCompat and adds a bespoke
 * config-bypass guard; apps/frontend spreads eslint-config-expo. Forcing more
 * than they genuinely share into here would make this a worse abstraction than
 * no abstraction.
 *
 * What belongs here: things BOTH apps already agree on. Anything one app needs
 * and the other does not stays in that app.
 *
 * NOT here, on purpose: apps/api's `no-restricted-properties` guard that forbids
 * reading JWT_SECRET / DATABASE_URL / token expiries off process.env. It is
 * load-bearing security, and its allowlist is expressed in backend-relative paths
 * (lib/config.ts, drizzle.config.ts) which are meaningless in a package shared
 * with an Expo app. It stays in apps/api/eslint.config.mjs.
 */

/** Build output, dependencies and coverage — ignored by both apps. */
export const ignores = [
  '**/node_modules/**',
  '**/coverage/**',
  // api (Next)
  '**/.next/**',
  // frontend (Expo)
  '**/dist/**',
  '**/.expo/**',
  // turbo task cache
  '**/.turbo/**',
];

/**
 * The shared base, as a flat-config array. Spread it first, then layer the
 * app's own framework config and rules on top.
 */
const base = [{ ignores }];

export default base;
