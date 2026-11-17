import type { RegisterInput } from './api';

/**
 * Guest sessions: register a throwaway account with random credentials, matching
 * the main app's "Continue as guest" behaviour, e.g.
 *   { email: "guest_12nWBkHpsf@ansari.chat", password: "…", first_name: "Welcome",
 *     last_name: "Guest", register_to_mail_list: false }
 *
 * `@ansari.chat` is a normal (non-reserved) domain on the backend, so these
 * register like any other account. The password is built to clear the backend's
 * strength check (score ≥ 3) with room to spare — length ≥ 12 plus one each of
 * lower/upper/digit/symbol, and never one of the patterns the check penalises.
 *
 * NOTE ON PERSISTENCE: each registration creates a REAL, PERSISTENT staging
 * account. To avoid minting a new one on every tap, the credentials are stored
 * on-device and reused (see `store.ts` + `context.ts` `loginAsGuest`).
 *
 * Randomness uses `crypto.getRandomValues` when present (web, and native with a
 * polyfill) and falls back to `Math.random` — adequate for a disposable guest
 * account in a prototype; not something to reuse for real credential generation.
 */

export const LOWER = 'abcdefghijklmnopqrstuvwxyz';
export const UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
export const DIGITS = '0123456789';
export const SYMBOLS = '!@#$%^&*-_=+';
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

function randomFromCharset(length: number, charset: string): string {
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

export interface GuestPasswordOptions {
  length?: number;
  charset?: string;
  /**
   * When true (the default, and what production uses), guarantee one lower, one
   * upper, one digit, and one symbol so the backend strength check always
   * passes. Tests pass `false` with a restricted charset to build a deliberately
   * WEAK password and prove the strength assertion actually fails for it — a
   * check that cannot fail is not evidence (lessons-critical).
   */
  guaranteeVariety?: boolean;
  /**
   * Replaces the random draw of one candidate password. Tests pass it to force
   * a candidate the backend would penalise and prove it is drawn again.
   */
  draw?: () => string;
}

/**
 * The backend's strength check takes 2 points off a password that matches one
 * of these (`checkPasswordStrength`, packages/auth/src/password.ts). A random
 * password starts with "123" about twice in a million draws (24 of 10,000,000
 * measured, issue #403), so a candidate that matches is drawn again.
 */
const PENALISED_PATTERNS = [/^123/, /password/i, /qwerty/i, /abc123/i];
const MAX_DRAWS = 100;

function drawVaried(length: number, charset: string): string {
  const required = [
    LOWER[randomInt(LOWER.length)],
    UPPER[randomInt(UPPER.length)],
    DIGITS[randomInt(DIGITS.length)],
    SYMBOLS[randomInt(SYMBOLS.length)],
  ];
  const fill = randomFromCharset(
    Math.max(0, length - required.length),
    charset,
  ).split('');
  return shuffle([...required, ...fill]);
}

export function makeGuestPassword(options: GuestPasswordOptions = {}): string {
  const length = options.length ?? 14;
  const charset = options.charset ?? ALNUM + SYMBOLS;
  const guaranteeVariety = options.guaranteeVariety ?? true;

  if (!guaranteeVariety) {
    return randomFromCharset(length, charset);
  }

  const draw = options.draw ?? (() => drawVaried(length, charset));
  for (let attempt = 0; attempt < MAX_DRAWS; attempt++) {
    const password = draw();
    if (!PENALISED_PATTERNS.some((pattern) => pattern.test(password))) {
      return password;
    }
  }
  throw new Error(
    `makeGuestPassword: ${MAX_DRAWS} draws in a row matched a penalised pattern`,
  );
}

/**
 * The display name every guest account is registered with. `store.ts` also keys
 * on it to classify session blobs written before `isGuest` was persisted.
 */
export const GUEST_FIRST_NAME = 'Welcome';
export const GUEST_LAST_NAME = 'Guest';

function guestEmail(): string {
  return `guest_${randomFromCharset(10, ALNUM)}@ansari.chat`;
}

export function generateGuestCredentials(): RegisterInput {
  return {
    email: guestEmail(),
    password: makeGuestPassword(),
    firstName: GUEST_FIRST_NAME,
    lastName: GUEST_LAST_NAME,
    registerToMailList: false,
  };
}
