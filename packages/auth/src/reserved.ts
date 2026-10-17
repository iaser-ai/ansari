// Addresses that public sign-up must refuse (spec 4, carried into spec 300).
// Ported from apps/api/lib/auth/reserved.ts and system-accounts.ts.
//
// Reserved = any address under the system domain. The configured-admin
// reservation was removed (owner amendment 2026-10-17): the role in auth.users
// is the only admin truth, and grant-admin.ts confirms the account by id.
// Refusing them with the SAME response as an existing
// account keeps sign-up from becoming an oracle for which addresses are
// privileged. System accounts live only in the app database (spec 300, Desired
// State item 9), so the auth database must never hold one of these addresses.

export const SYSTEM_EMAIL_DOMAIN = '@system.ansari.chat';

/** The same normalisation better-auth applies on lookup, plus the legacy trim. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** True when the address is under the reserved system domain. */
export function isSystemAddress(email: string): boolean {
  return normalizeEmail(email).endsWith(SYSTEM_EMAIL_DOMAIN);
}

/**
 * True when public sign-up must refuse this address. The email is normalized
 * here, so no caller can bypass the check with a mixed-case address.
 */
export function isReservedAddress(email: string): boolean {
  return isSystemAddress(normalizeEmail(email));
}
