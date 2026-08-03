import { describe, it, expect, vi } from 'vitest';

// Spec 4: isReservedAddress refuses (a) configured admin addresses (Phase 4) and
// (b) any address under the system domain (Phase 5). It normalizes internally.

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
  it('is true for a configured admin address', () => {
    expect(isReservedAddress('admin@ansari.chat')).toBe(true);
    expect(isReservedAddress('boss@ansari.chat')).toBe(true);
  });

  it('is true for any address under the system domain', () => {
    expect(isReservedAddress('ai-skill@system.ansari.chat')).toBe(true);
    expect(isReservedAddress('leaderboard@system.ansari.chat')).toBe(true);
    expect(isReservedAddress('anything@system.ansari.chat')).toBe(true);
  });

  it('normalizes internally (matches mixed-case / padded input)', () => {
    expect(isReservedAddress('Admin@Ansari.Chat')).toBe(true);
    expect(isReservedAddress('  AI-Skill@System.Ansari.Chat  ')).toBe(true);
  });

  it('is false for a non-reserved address', () => {
    expect(isReservedAddress('someone@example.com')).toBe(false);
    expect(isReservedAddress('user@ansari.chat')).toBe(false); // not admin, not system domain
  });
});
