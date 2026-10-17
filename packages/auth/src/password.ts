// Password hashing for the auth service (spec 300): a PERMANENT bcrypt + scrypt
// dual verify, so every migrated user signs in with their existing password.
//
// - Legacy hashes (`$2a$` / `$2b$`, bcrypt cost 12, from apps/api) verify with
//   bcrypt. bcrypt reads at most 72 bytes of the password and ignores the rest,
//   exactly as apps/api/lib/auth/password.ts behaved, so a legacy password
//   longer than 72 bytes still verifies (scenario 8).
// - Everything else verifies with better-auth's scrypt.
// - New hashes are always scrypt. A legacy hash is never rewritten here; it
//   stays valid for as long as the user keeps that password.
import bcrypt from 'bcrypt';
import {
  hashPassword as scryptHash,
  verifyPassword as scryptVerify,
} from 'better-auth/crypto';

const BCRYPT_HASH = /^\$2[ab]\$/;

/** bcrypt's input limit: bytes past this are ignored when hashing and comparing. */
export const BCRYPT_MAX_BYTES = 72;

export function isBcryptHash(hash: string): boolean {
  return BCRYPT_HASH.test(hash);
}

/** Hash a new password. Always scrypt. */
export async function hashPassword(password: string): Promise<string> {
  return scryptHash(password);
}

/** Verify against either hash format; the format is read from the hash itself. */
export async function verifyPassword({
  hash,
  password,
}: {
  hash: string;
  password: string;
}): Promise<boolean> {
  if (isBcryptHash(hash)) return bcrypt.compare(password, hash);
  // better-auth's scrypt hash is `salt:key`, and its verifier throws on a hash
  // without the separator, which would make sign-in answer 500 rather than the
  // same 401 as a wrong password. The copy refuses such rows; this is the
  // second line.
  if (!hash.includes(':')) return false;
  return scryptVerify({ hash, password });
}

/**
 * Password strength, ported unchanged from apps/api/lib/auth/password.ts
 * (spec 4): a score from length, character variety and common patterns, valid
 * at 3 or more. Better-auth itself enforces only length, so createAuth() runs
 * this in `hooks.before` on sign-up and on reset.
 */
export function checkPasswordStrength(password: string): {
  valid: boolean;
  score: number;
  suggestions: string[];
} {
  const suggestions: string[] = [];
  let score = 0;

  if (password.length >= 8) score++;
  else suggestions.push('Use at least 8 characters');

  if (password.length >= 12) score++;

  if (/[a-z]/.test(password)) score++;
  else suggestions.push('Add lowercase letters');

  if (/[A-Z]/.test(password)) score++;
  else suggestions.push('Add uppercase letters');

  if (/[0-9]/.test(password)) score++;
  else suggestions.push('Add numbers');

  if (/[^a-zA-Z0-9]/.test(password)) score++;
  else suggestions.push('Add special characters');

  const commonPatterns = [/^123/, /password/i, /qwerty/i, /abc123/i];
  if (commonPatterns.some((pattern) => pattern.test(password))) {
    score = Math.max(0, score - 2);
    suggestions.push('Avoid common patterns');
  }

  return { valid: score >= 3, score, suggestions };
}

/** The legacy 400 `detail` for a weak password, byte for byte. */
export function weakPasswordMessage(suggestions: string[]): string {
  return `Password is too weak. ${suggestions.join(' ')}`;
}
