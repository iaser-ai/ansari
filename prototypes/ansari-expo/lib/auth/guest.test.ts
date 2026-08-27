import { describe, expect, it } from 'vitest';
import { generateGuestCredentials } from '@/lib/auth/guest';

/**
 * Mirrors apps/api's `checkPasswordStrength`: it requires a score of at least 3,
 * where length≥8, length≥12, and each of lower/upper/digit/symbol add a point,
 * and a few common patterns subtract. Guest passwords must clear that every time.
 */
function passwordScore(password: string): number {
  let score = 0;
  if (password.length >= 8) score++;
  if (password.length >= 12) score++;
  if (/[a-z]/.test(password)) score++;
  if (/[A-Z]/.test(password)) score++;
  if (/[0-9]/.test(password)) score++;
  if (/[^a-zA-Z0-9]/.test(password)) score++;
  const common = [/^123/, /password/i, /qwerty/i, /abc123/i];
  if (common.some((p) => p.test(password))) score = Math.max(0, score - 2);
  return score;
}

describe('generateGuestCredentials', () => {
  it('produces the fixed guest identity fields', () => {
    const creds = generateGuestCredentials();
    expect(creds.firstName).toBe('Welcome');
    expect(creds.lastName).toBe('Guest');
    expect(creds.registerToMailList).toBe(false);
  });

  it('always yields a valid guest email and a strong-enough password', () => {
    const emails = new Set<string>();
    for (let i = 0; i < 500; i++) {
      const { email, password } = generateGuestCredentials();
      expect(email).toMatch(/^guest_[A-Za-z0-9]{10}@ansari\.chat$/);
      expect(password.length).toBeGreaterThanOrEqual(12);
      expect(password.length).toBeLessThanOrEqual(128);
      // Comfortably above the backend's minimum score of 3.
      expect(passwordScore(password)).toBeGreaterThanOrEqual(5);
      emails.add(email);
    }
    // Randomised — collisions across 500 draws would signal a broken generator.
    expect(emails.size).toBeGreaterThan(490);
  });
});
