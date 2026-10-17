import { isIP } from 'node:net';
import { NextRequest } from 'next/server';

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

const store = new Map<string, RateLimitEntry>();
const MAX_STORE_SIZE = 10_000;

/**
 * The client IP Railway's edge stamped in `X-Real-IP`, or null when there is
 * no single valid address there (spec 300, Client IP). `X-Forwarded-For` is
 * never read: the edge does not sanitize a caller's own entries, so its first
 * entry is whatever the caller chose.
 */
export function getRealIp(request: NextRequest): string | null {
  const realIp = request.headers.get('x-real-ip')?.trim();
  if (!realIp || realIp.includes('%') || !isIP(realIp)) return null;
  return realIp;
}

/**
 * The rate-limit key for a request: its `X-Real-IP`, or 127.0.0.1 when there
 * is none (local development). Exact addresses, with no IPv6 /64 grouping
 * (spec 300 N-2, decided no).
 */
export function getClientIp(request: NextRequest): string {
  return getRealIp(request) ?? '127.0.0.1';
}

/**
 * Check if a request from the given IP is allowed under the rate limit.
 *
 * Uses a fixed-window counter. Returns whether the request is allowed
 * and how many seconds until the window resets.
 */
export function checkRateLimit(
  ip: string,
  limit: number = 30,
  windowMs: number = 60_000
): { allowed: boolean; retryAfter: number } {
  const now = Date.now();

  // Prevent unbounded memory growth from IP rotation attacks
  if (store.size > MAX_STORE_SIZE) {
    store.clear();
  }

  const entry = store.get(ip);

  // No entry or expired window — start fresh
  if (!entry || now >= entry.resetAt) {
    store.set(ip, { count: 1, resetAt: now + windowMs });
    return { allowed: true, retryAfter: 0 };
  }

  // Within window — check count
  const retryAfter = Math.ceil((entry.resetAt - now) / 1000);

  if (entry.count >= limit) {
    return { allowed: false, retryAfter };
  }

  entry.count++;
  return { allowed: true, retryAfter: 0 };
}

/**
 * Reset the rate limit store. Used in tests.
 */
export function resetRateLimitStore(): void {
  store.clear();
}
