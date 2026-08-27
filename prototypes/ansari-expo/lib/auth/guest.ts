import type { RegisterInput } from '@/lib/auth/api';

/**
 * Guest sessions: register a throwaway account with random credentials, matching
 * the main app's "Continue as guest" behaviour, e.g.
 *   { email: "guest_12nWBkHpsf@ansari.chat", password: "…", first_name: "Welcome",
 *     last_name: "Guest", register_to_mail_list: false }
 *
 * `@ansari.chat` is a normal (non-reserved) domain on the backend, so these
 * register like any other account. The password is built to clear the backend's
 * strength check with room to spare (length ≥ 12 plus lower/upper/digit/symbol).
 *
 * Randomness uses `crypto.getRandomValues` when present (web, and native with a
 * polyfill) and falls back to `Math.random` — adequate for a disposable guest
 * account in a prototype; not something to reuse for real credential generation.
 */

const LOWER = 'abcdefghijklmnopqrstuvwxyz';
const UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const DIGITS = '0123456789';
const SYMBOLS = '!@#$%^&*-_=+';
const ALNUM = LOWER + UPPER + DIGITS;

function randomInt(maxExclusive: number): number {
  const cryptoObj = globalThis.crypto;
  if (cryptoObj?.getRandomValues) {
    const buf = new Uint32Array(1);
    cryptoObj.getRandomValues(buf);
    return buf[0] % maxExclusive;
  }
  return Math.floor(Math.random() * maxExclusive);
}

function randomString(length: number, charset: string): string {
  let out = '';
  for (let i = 0; i < length; i++) out += charset[randomInt(charset.length)];
  return out;
}

function shuffle(chars: string[]): string {
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

function guestEmail(): string {
  return `guest_${randomString(10, ALNUM)}@ansari.chat`;
}

function guestPassword(): string {
  // Guarantee one of each class, then fill to 14 chars, then shuffle so the
  // required classes aren't in fixed positions.
  const required = [
    LOWER[randomInt(LOWER.length)],
    UPPER[randomInt(UPPER.length)],
    DIGITS[randomInt(DIGITS.length)],
    SYMBOLS[randomInt(SYMBOLS.length)],
  ];
  const fill = randomString(10, ALNUM + SYMBOLS).split('');
  return shuffle([...required, ...fill]);
}

export function generateGuestCredentials(): RegisterInput {
  return {
    email: guestEmail(),
    password: guestPassword(),
    firstName: 'Welcome',
    lastName: 'Guest',
    registerToMailList: false,
  };
}
