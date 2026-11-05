// Addresses that public sign-up must refuse (spec 4, carried into spec 300).
// Ported from apps/api/lib/auth/reserved.ts and system-accounts.ts.
//
// Reserved = any address under the system domain or, since spec 329, the
// non-interactive domain. The configured-admin
// reservation was removed (owner amendment 2026-10-17): the role in auth.users
// is the only admin truth, and grant-admin.ts confirms the account by id.
// Refusing them with the SAME response as an existing
// account keeps sign-up from becoming an oracle for which addresses are
// privileged. System accounts live only in the app database (spec 300, Desired
// State item 9), so the auth database must never hold a system address. It does
// hold non-interactive addresses, written only by the token exchange and the
// service-user script, never by a Better Auth path.

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
 * The non-interactive domain (spec 329, owner decision 1): service users and
 * WhatsApp users, who have no password and never sign in. Unlike the system
 * domain, the auth database does hold these addresses, but only the token
 * exchange and the service-user script create them, never a Better Auth path.
 */
export const NOREPLY_EMAIL_DOMAIN = '@noreply.askansari.ai';

/** True when the address is under the non-interactive domain. */
export function isNoreplyAddress(email: string): boolean {
  return normalizeEmail(email).endsWith(NOREPLY_EMAIL_DOMAIN);
}

/** The address of a WhatsApp user: its own user id, never the BSUID or a phone number. */
export function whatsappAddress(userId: string): string {
  return `whatsapp-${userId}${NOREPLY_EMAIL_DOMAIN}`;
}

/** The address of a service user, by its service name (e.g. `whatsapp`, `ansari-mcp`). */
export function serviceAddress(serviceName: string): string {
  return `service-${serviceName}${NOREPLY_EMAIL_DOMAIN}`;
}

/**
 * True when public sign-up must refuse this address: the system domain or the
 * non-interactive domain. The email is normalized here, so no caller can
 * bypass the check with a mixed-case address.
 */
export function isReservedAddress(email: string): boolean {
  const normalized = normalizeEmail(email);
  return isSystemAddress(normalized) || isNoreplyAddress(normalized);
}
