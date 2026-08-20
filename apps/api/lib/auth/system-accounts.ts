/**
 * System-account registry (spec 4) — the single source of truth for the
 * non-registerable internal identities used by the unauthenticated endpoints
 * (`v2/mcp-complete`, `v1/chat/completions`).
 *
 * These accounts are resolved by the durable `users.system_key` column, NOT by
 * email, so a look-alike that a user pre-registers (which has no `system_key`)
 * can never receive system-attributed threads/messages. The `@system.ansari.chat`
 * domain is reserved at registration (see `isReservedAddress`).
 */

export const SYSTEM_EMAIL_DOMAIN = '@system.ansari.chat';

export const SYSTEM_ACCOUNTS = {
  'ai-skill': {
    email: 'ai-skill@system.ansari.chat',
    firstName: 'AI Skill',
    lastName: 'System User',
  },
  leaderboard: {
    email: 'leaderboard@system.ansari.chat',
    firstName: 'Leaderboard',
    lastName: 'System User',
  },
} as const;

export type SystemKey = keyof typeof SYSTEM_ACCOUNTS;

/** True when `normalizedEmail` is under the reserved system domain. */
export function isSystemAddress(normalizedEmail: string): boolean {
  return normalizedEmail.endsWith(SYSTEM_EMAIL_DOMAIN);
}
