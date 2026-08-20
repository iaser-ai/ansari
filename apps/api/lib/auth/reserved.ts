import { config } from '@/lib/config';
import { isSystemAddress } from '@/lib/auth/system-accounts';

/**
 * Addresses that public registration must refuse (spec 4). Refusing them — with
 * the SAME response as an existing-account conflict (see the register route) —
 * keeps registration from becoming an oracle for which addresses are privileged.
 *
 * Reserved = the configured admin addresses (Phase 4) OR any address under the
 * system domain `@system.ansari.chat` (Phase 5).
 *
 * The email is normalized (trim + lowercase) inside the helper so no caller can
 * accidentally bypass the check by passing a mixed-case address.
 */
export function isReservedAddress(email: string): boolean {
  const normalized = email.trim().toLowerCase();
  if (config.admin.emails.includes(normalized)) return true;
  if (isSystemAddress(normalized)) return true;
  return false;
}
