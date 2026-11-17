import { describe, expect, it, vi } from 'vitest';
import {
  generateGuestCredentials,
  makeGuestPassword,
  LOWER,
} from '@/lib/auth/guest';

/**
 * Mirrors apps/api's `checkPasswordStrength` (register/route.ts → password.ts):
 * length≥8, length≥12, and each of lower/upper/digit/symbol add a point; a few
 * common patterns subtract 2. The route rejects anything scoring below 3.
 *
 * A test that only asserts "generated passwords score high" is not evidence: if
 * `passwordScore` were a tautology (always high), it would pass for weak inputs
 * too. So we first PROVE the scorer discriminates, then prove that a WEAKENED
 * generator (lowercase-only, 8 chars) fails the ≥3 bar — i.e. the assertion the
 * production generator passes would genuinely fail if the generator regressed.
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

describe('passwordScore (the scorer itself is proven)', () => {
  it('scores a lowercase-only 8-char password below the backend minimum of 3', () => {
    expect(passwordScore('abcdefgh')).toBe(2);
    expect(passwordScore('abcdefgh')).toBeLessThan(3);
  });

  it('penalises a common pattern', () => {
    // 'password' has lowercase (+1) and length≥8 (+1) but loses 2 for the pattern.
    expect(passwordScore('password')).toBeLessThan(3);
  });

  it('scores a varied 12+ char password strong (≥5)', () => {
    expect(passwordScore('Abcdef1!wxyz')).toBeGreaterThanOrEqual(5);
  });
});

describe('makeGuestPassword — weakened generator fails, production passes', () => {
  it('a weakened variant (lowercase-only, 8 chars) would fail the ≥3 bar', () => {
    // This is the "prove it fails when the guard is removed" case: if the
    // production generator ever regressed to this, the assertion below would fail.
    const weak = makeGuestPassword({
      length: 8,
      charset: LOWER,
      guaranteeVariety: false,
    });
    expect(weak).toHaveLength(8);
    expect(passwordScore(weak)).toBeLessThan(3);
  });

  it('the production generator always clears the bar with room to spare', () => {
    for (let i = 0; i < 500; i++) {
      const password = makeGuestPassword();
      expect(password.length).toBeGreaterThanOrEqual(12);
      expect(password.length).toBeLessThanOrEqual(128);
      expect(passwordScore(password)).toBeGreaterThanOrEqual(5);
    }
  });
});

// Issue #403: the 500-draw test above failed about once in 800 runs. A random
// password that starts with "123" matches a common pattern, loses 2 points and
// scores 4 (24 of 10,000,000 draws, measured; no other pattern ever matched).
// The generator now draws again, so the property holds by construction. These
// force the draw, since waiting for chance to produce one proves nothing.
describe('makeGuestPassword: a penalised draw is drawn again', () => {
  // A real generator output from the measurement, and a draw that is clean.
  const PENALISED = '123!vpA^HZ@_kM';
  const CLEAN = 'k7!vpA^HZ@_kM2';

  it('the forced draw really is below the bar the production test asserts', () => {
    expect(passwordScore(PENALISED)).toBe(4);
    expect(passwordScore(CLEAN)).toBe(6);
  });

  it('skips a draw that starts with "123" and returns the next one', () => {
    const draws = [PENALISED, PENALISED, CLEAN];
    const draw = vi.fn(() => draws.shift() as string);

    const password = makeGuestPassword({ draw });

    expect(password).toBe(CLEAN);
    expect(passwordScore(password)).toBeGreaterThanOrEqual(5);
    expect(draw).toHaveBeenCalledTimes(3);
  });

  it.each(['xPassWord9!kQzR', 'aQWERTY7!bcdEf', 'zAbC123!kQmRtY'])(
    'skips every pattern the backend penalises: %s',
    (penalised) => {
      expect(passwordScore(penalised)).toBeLessThan(5);
      const draws = [penalised, CLEAN];
      expect(makeGuestPassword({ draw: () => draws.shift() as string })).toBe(CLEAN);
    },
  );

  it('fails loudly instead of looping forever when every draw is penalised', () => {
    const draw = vi.fn(() => PENALISED);
    expect(() => makeGuestPassword({ draw })).toThrow(/100 draws in a row/);
    expect(draw).toHaveBeenCalledTimes(100);
  });
});

describe('generateGuestCredentials', () => {
  it('produces the fixed guest identity fields', () => {
    const creds = generateGuestCredentials();
    expect(creds.firstName).toBe('Welcome');
    expect(creds.lastName).toBe('Guest');
    expect(creds.registerToMailList).toBe(false);
  });

  it('always yields a valid, unique guest email and a strong password', () => {
    const emails = new Set<string>();
    for (let i = 0; i < 500; i++) {
      const { email, password } = generateGuestCredentials();
      expect(email).toMatch(/^guest_[A-Za-z0-9]{10}@ansari\.chat$/);
      expect(passwordScore(password)).toBeGreaterThanOrEqual(5);
      emails.add(email);
    }
    // Randomised — collisions across 500 draws would signal a broken generator.
    expect(emails.size).toBeGreaterThan(490);
  });
});
