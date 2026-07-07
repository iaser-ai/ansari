import { NextRequest } from 'next/server';

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

const store = new Map<string, RateLimitEntry>();
const MAX_STORE_SIZE = 10_000;

/**
 * Extract client IP from request headers.
 * Checks x-forwarded-for (first IP), x-real-ip, then falls back to 127.0.0.1.
 */
export function getClientIp(request: NextRequest): string {
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) {
    const firstIp = forwarded.split(',')[0].trim();
    if (firstIp) return firstIp;
  }

  const realIp = request.headers.get('x-real-ip');
  if (realIp) return realIp.trim();

  // NextRequest.ip is not available in all environments
  return (request as unknown as { ip?: string }).ip ?? '127.0.0.1';
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
