import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  hashPassword,
  verifyPassword,
  checkPasswordStrength,
} from '../lib/auth/password';
import {
  generateToken,
  verifyToken,
  hashToken,
  extractBearerToken,
} from '../lib/auth/jwt';

describe('Password utilities', () => {
  describe('hashPassword', () => {
    it('creates a hash that differs from the password', async () => {
      const password = 'securePassword123!';
      const hash = await hashPassword(password);
      expect(hash).not.toBe(password);
      expect(hash).toMatch(/^\$2[aby]\$/);
    });

    it('creates different hashes for the same password', async () => {
      const password = 'securePassword123!';
      const hash1 = await hashPassword(password);
      const hash2 = await hashPassword(password);
      expect(hash1).not.toBe(hash2);
    });
  });

  describe('verifyPassword', () => {
    it('verifies a correct password', async () => {
      const password = 'securePassword123!';
      const hash = await hashPassword(password);
      const isValid = await verifyPassword(password, hash);
      expect(isValid).toBe(true);
    });

    it('rejects an incorrect password', async () => {
      const password = 'securePassword123!';
      const wrongPassword = 'wrongPassword123!';
      const hash = await hashPassword(password);
      const isValid = await verifyPassword(wrongPassword, hash);
      expect(isValid).toBe(false);
    });
  });

  describe('checkPasswordStrength', () => {
    it('rejects weak passwords', () => {
      const result = checkPasswordStrength('abc');
      expect(result.valid).toBe(false);
      expect(result.suggestions.length).toBeGreaterThan(0);
    });

    it('accepts strong passwords', () => {
      const result = checkPasswordStrength('SecureP@ssw0rd123');
      expect(result.valid).toBe(true);
      expect(result.score).toBeGreaterThanOrEqual(4);
    });

    it('rejects common patterns', () => {
      const result = checkPasswordStrength('password123');
      expect(result.valid).toBe(false);
    });
  });
});

describe('JWT utilities', () => {
  const testSecret = 'test-secret-key-for-testing-purposes-only-32chars';

  describe('generateToken', () => {
    it('generates a valid JWT', () => {
      const token = generateToken('user-123', 'access', 2, testSecret);
      expect(token).toBeDefined();
      expect(token.split('.')).toHaveLength(3);
    });
  });

  describe('verifyToken', () => {
    it('verifies a valid token', () => {
      const token = generateToken('user-123', 'access', 2, testSecret);
      const payload = verifyToken(token, testSecret);
      expect(payload).toBeDefined();
      expect(payload?.user_id).toBe('user-123');
      expect(payload?.type).toBe('access');
    });

    it('returns null for invalid token', () => {
      const payload = verifyToken('invalid.token.here', testSecret);
      expect(payload).toBeNull();
    });

    it('returns null for wrong secret', () => {
      const token = generateToken('user-123', 'access', 2, testSecret);
      const payload = verifyToken(token, 'wrong-secret-key-32-characters-long');
      expect(payload).toBeNull();
    });
  });

  describe('hashToken', () => {
    it('creates a consistent hash', () => {
      const token = 'some-token';
      const hash1 = hashToken(token);
      const hash2 = hashToken(token);
      expect(hash1).toBe(hash2);
    });

    it('creates different hashes for different tokens', () => {
      const hash1 = hashToken('token1');
      const hash2 = hashToken('token2');
      expect(hash1).not.toBe(hash2);
    });
  });

  describe('extractBearerToken', () => {
    it('extracts token from valid header', () => {
      const token = extractBearerToken('Bearer abc123');
      expect(token).toBe('abc123');
    });

    it('returns null for missing header', () => {
      const token = extractBearerToken(null);
      expect(token).toBeNull();
    });

    it('returns null for invalid format', () => {
      expect(extractBearerToken('Basic abc123')).toBeNull();
      expect(extractBearerToken('Bearer')).toBeNull();
      expect(extractBearerToken('abc123')).toBeNull();
    });
  });
});
