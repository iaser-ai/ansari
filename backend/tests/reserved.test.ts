import { describe, it, expect, vi } from 'vitest';

// Spec 4: isReservedAddress consults the configured admin allowlist (Phase 4).
// config.admin.emails is stored lowercased, so the helper compares against the
// normalized value the caller passes.

const mockEmails: string[] = ['admin@ansari.chat', 'boss@ansari.chat'];
vi.mock('@/lib/config', () => ({
  config: {
    get admin() {
      return { emails: mockEmails };
    },
  },
}));

import { isReservedAddress } from '@/lib/auth/reserved';

describe('isReservedAddress', () => {
  it('is true for a configured admin address (normalized)', () => {
    expect(isReservedAddress('admin@ansari.chat')).toBe(true);
    expect(isReservedAddress('boss@ansari.chat')).toBe(true);
  });

  it('is false for a non-reserved address', () => {
    expect(isReservedAddress('someone@example.com')).toBe(false);
  });

  it('does not match a non-normalized (mixed-case) input (callers must lowercase first)', () => {
    // The register route lowercases before calling; this documents the contract.
    expect(isReservedAddress('Admin@Ansari.Chat')).toBe(false);
  });
});
