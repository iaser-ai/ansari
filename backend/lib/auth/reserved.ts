import { config } from '@/lib/config';

/**
 * Addresses that public registration must refuse (spec 4). Refusing them — with
 * the SAME response as an existing-account conflict (see the register route) —
 * keeps registration from becoming an oracle for which addresses are privileged.
 *
 * Phase 4 reserves the configured admin addresses; Phase 5 extends this to the
 * system addresses / domain.
 *
 * @param normalizedEmail the caller's email, already lowercased. `config.admin.emails`
 *   is stored lowercased, so the comparison must be against the normalized value.
 */
export function isReservedAddress(normalizedEmail: string): boolean {
  return config.admin.emails.includes(normalizedEmail);
}
