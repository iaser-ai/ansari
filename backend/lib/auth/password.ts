import bcrypt from 'bcrypt';

const SALT_ROUNDS = 12;

/**
 * Hash a password using bcrypt
 */
export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, SALT_ROUNDS);
}

/**
 * Verify a password against a hash
 */
export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

/**
 * Check password strength
 * Returns { valid: boolean, suggestions?: string[] }
 */
export function checkPasswordStrength(password: string): {
  valid: boolean;
  score: number;
  suggestions: string[];
} {
  const suggestions: string[] = [];
  let score = 0;

  // Length check
  if (password.length >= 8) score++;
  else suggestions.push('Use at least 8 characters');

  if (password.length >= 12) score++;

  // Character variety checks
  if (/[a-z]/.test(password)) score++;
  else suggestions.push('Add lowercase letters');

  if (/[A-Z]/.test(password)) score++;
  else suggestions.push('Add uppercase letters');

  if (/[0-9]/.test(password)) score++;
  else suggestions.push('Add numbers');

  if (/[^a-zA-Z0-9]/.test(password)) score++;
  else suggestions.push('Add special characters');

  // Common patterns to avoid
  const commonPatterns = [
    /^123/,
    /password/i,
    /qwerty/i,
    /abc123/i,
  ];
  if (commonPatterns.some(pattern => pattern.test(password))) {
    score = Math.max(0, score - 2);
    suggestions.push('Avoid common patterns');
  }

  // Score ranges: 0-2 = weak, 3-4 = medium, 5+ = strong
  // We require at least score 2 (matching Ansari's zxcvbn score < 2 check)
  return {
    valid: score >= 2,
    score,
    suggestions,
  };
}
