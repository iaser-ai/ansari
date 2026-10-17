import { describe, it, expect, beforeEach, vi } from 'vitest';
import { checkRateLimit, resetRateLimitStore, getClientIp, getRealIp } from '../lib/rate-limit';
import { NextRequest } from 'next/server';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

type EdgeShape = { name: string; headers: Record<string, string>; probe?: { x_real_ip: string } };
/** Header shapes behind Railway's edge, per path (docs/cutover/edge-check.md); shared with apps/auth's tests. */
const EDGE = JSON.parse(
  readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../../docs/cutover/edge-header-shapes.json'), 'utf8')
) as { shapes: EdgeShape[]; withoutTheEdge: EdgeShape[] };

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

    it('at the mcp-complete limit (120, #87): 120th request allowed, 121st blocked in one window', () => {
      for (let i = 0; i < 119; i++) {
        expect(checkRateLimit('1.2.3.4', 120).allowed).toBe(true);
      }
      expect(checkRateLimit('1.2.3.4', 120).allowed).toBe(true); // 120th
      const blocked = checkRateLimit('1.2.3.4', 120); // 121st
      expect(blocked.allowed).toBe(false);
      expect(blocked.retryAfter).toBeGreaterThan(0);
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

  // Spec 300 (Client IP): X-Real-IP only. Railway's edge stamps it; the first
  // X-Forwarded-For entry is whatever the caller sent, so reading it let any
  // client pick its own bucket. Exact addresses, no IPv6 /64 grouping (N-2).
  describe('getClientIp', () => {
    const req = (headers: Record<string, string> = {}) =>
      new NextRequest('http://localhost', { headers });

    it('reads x-real-ip', () => {
      expect(getClientIp(req({ 'x-real-ip': '1.2.3.4' }))).toBe('1.2.3.4');
      expect(getClientIp(req({ 'x-real-ip': ' 2001:db8::1 ' }))).toBe('2001:db8::1');
    });

    it('ignores x-forwarded-for, alone or alongside x-real-ip', () => {
      expect(getClientIp(req({ 'x-forwarded-for': '1.2.3.4' }))).toBe('127.0.0.1');
      expect(
        getClientIp(req({ 'x-forwarded-for': '1.1.1.1, 3.3.3.3', 'x-real-ip': '2.2.2.2' }))
      ).toBe('2.2.2.2');
    });

    it('a forged x-forwarded-for does not switch buckets', () => {
      const a = getClientIp(req({ 'x-forwarded-for': '9.9.9.9', 'x-real-ip': '2.2.2.2' }));
      const b = getClientIp(req({ 'x-forwarded-for': '8.8.8.8', 'x-real-ip': '2.2.2.2' }));
      expect(a).toBe(b);
    });

    it('keeps IPv6 addresses exact (no /64 grouping)', () => {
      const a = getClientIp(req({ 'x-real-ip': '2001:db8::1' }));
      const b = getClientIp(req({ 'x-real-ip': '2001:db8::2' }));
      expect(a).not.toBe(b);
    });

    it('falls back to 127.0.0.1 without a single valid x-real-ip', () => {
      for (const value of ['', '1.2.3.4, 5.6.7.8', 'example.com', 'fe80::1%eth0', 'unknown']) {
        expect(getClientIp(req(value ? { 'x-real-ip': value } : {}))).toBe('127.0.0.1');
      }
    });

    it('getRealIp is null where getClientIp falls back', () => {
      expect(getRealIp(req())).toBeNull();
      expect(getRealIp(req({ 'x-forwarded-for': '1.2.3.4' }))).toBeNull();
      expect(getRealIp(req({ 'x-real-ip': '1.2.3.4' }))).toBe('1.2.3.4');
    });

    it.each(EDGE.shapes.map((s) => [s.name, s] as const))(
      'edge shape %s: the X-Real-IP client, never cf-connecting-ip or x-forwarded-for',
      (_name, shape) => {
        const client = shape.probe?.x_real_ip;
        expect(client).toBeTruthy();
        expect(getRealIp(req(shape.headers))).toBe(client);
        expect(getClientIp(req(shape.headers))).toBe(client);
      }
    );

    it.each(EDGE.withoutTheEdge.map((s) => [s.name, s] as const))(
      'no edge, %s: no client IP (the layer forwards none)',
      (_name, shape) => {
        expect(getRealIp(req(shape.headers))).toBeNull();
      }
    );
  });
});
