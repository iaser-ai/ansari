/**
 * The `X-Ansari-Client` ids this app sends to `apps/auth`, one per platform.
 * apps/auth stores the id as the account's `registered_via` (through the
 * shared parser in `packages/types/src/attribution.ts`), so each value must
 * match that parser's pattern, or the account is recorded as `invalid`.
 * Pinned on both sides: `client-id.test.ts` (the parser) and
 * apps/auth/tests/frontend-client.test.ts (stored verbatim).
 *
 * No React Native import here: apps/auth's suite imports this file.
 */
export const CLIENT_IDS = {
  web: 'askansari-web',
  ios: 'askansari-ios',
  android: 'askansari-android',
} as const;
