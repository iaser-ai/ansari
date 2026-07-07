import { describe, it, expect, beforeEach, vi } from 'vitest';
import { checkRateLimit, resetRateLimitStore, getClientIp } from '../lib/rate-limit';
import { NextRequest } from 'next/server';

describe('Rate limiter', () => {
  beforeEach(() => {
    resetRateLimitStore();
  });

  describe('checkRateLimit', () => {
    it('allows requests under the limit', () => {
      const result = checkRateLimit('1.2.3.4', 5);
      expect(result.allowed).toBe(true);
      expect(result.retryAfter).toBe(0);
    });

    it('blocks requests over the limit', () => {
      for (let i = 0; i < 5; i++) {
        checkRateLimit('1.2.3.4', 5);
      }
      const result = checkRateLimit('1.2.3.4', 5);
      expect(result.allowed).toBe(false);
      expect(result.retryAfter).toBeGreaterThan(0);
    });

    it('tracks IPs independently', () => {
      for (let i = 0; i < 5; i++) {
        checkRateLimit('1.2.3.4', 5);
      }
      const blocked = checkRateLimit('1.2.3.4', 5);
      expect(blocked.allowed).toBe(false);

      const allowed = checkRateLimit('5.6.7.8', 5);
      expect(allowed.allowed).toBe(true);
    });

    it('resets after window expires', () => {
      vi.useFakeTimers();

      for (let i = 0; i < 5; i++) {
        checkRateLimit('1.2.3.4', 5, 1000);
      }
      expect(checkRateLimit('1.2.3.4', 5, 1000).allowed).toBe(false);

      vi.advanceTimersByTime(1001);
      expect(checkRateLimit('1.2.3.4', 5, 1000).allowed).toBe(true);

      vi.useRealTimers();
    });

    it('clears store when exceeding max size', () => {
      // Fill store with 10001 IPs
      for (let i = 0; i <= 10_000; i++) {
        checkRateLimit(`ip-${i}`, 1);
      }
      // After exceeding 10000, store should have been cleared
      // and the next request should be allowed even for a previously-blocked IP
      const result = checkRateLimit('ip-0', 1);
      expect(result.allowed).toBe(true);
    });

    it('returns retryAfter in seconds', () => {
      vi.useFakeTimers();

      for (let i = 0; i < 5; i++) {
        checkRateLimit('1.2.3.4', 5, 60_000);
      }
      const result = checkRateLimit('1.2.3.4', 5, 60_000);
      expect(result.allowed).toBe(false);
      expect(result.retryAfter).toBe(60);

      vi.useRealTimers();
    });
  });

  describe('getClientIp', () => {
    it('extracts IP from x-forwarded-for (first IP)', () => {
      const request = new NextRequest('http://localhost', {
        headers: { 'x-forwarded-for': '1.2.3.4, 5.6.7.8' },
      });
      expect(getClientIp(request)).toBe('1.2.3.4');
    });

    it('extracts IP from x-real-ip', () => {
      const request = new NextRequest('http://localhost', {
        headers: { 'x-real-ip': '1.2.3.4' },
      });
      expect(getClientIp(request)).toBe('1.2.3.4');
    });

    it('falls back to 127.0.0.1', () => {
      const request = new NextRequest('http://localhost');
      expect(getClientIp(request)).toBe('127.0.0.1');
    });

    it('prefers x-forwarded-for over x-real-ip', () => {
      const request = new NextRequest('http://localhost', {
        headers: {
          'x-forwarded-for': '1.1.1.1',
          'x-real-ip': '2.2.2.2',
        },
      });
      expect(getClientIp(request)).toBe('1.1.1.1');
    });
  });
});
