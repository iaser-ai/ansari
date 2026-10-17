// The client IP on apps/auth's one listener (spec 300 Client IP). Better Auth
// keys its router rate limits by `x-real-ip` alone, which Railway's edge stamps.
// No path apps/api's layer calls has a per-IP rule (packages/auth `limits.ts`),
// because those calls arrive with apps/api's IP; the rule here protects the
// router's remaining per-IP default.
//
// In production, a request to Better Auth's router with no usable IP is
// refused with 400, so nothing reaches its shared `no-trusted-ip|<path>` bucket.
import { isIP, isIPv4, isIPv6 } from 'node:net';

import type { NextFunction, Request, Response } from 'express';

/**
 * A single IP address, or null. Rejects lists, hostnames, empty values, zone
 * ids and anything a duplicated header joined together.
 */
export function singleIp(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const ip = value.trim();
  if (ip.length === 0 || ip.length > 45 || ip.includes('%')) return null;
  return isIP(ip) ? ip : null;
}

/** Production only: Better Auth's router needs one usable client IP. */
export function requireClientIp(production: boolean) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (production && !singleIp(req.headers['x-real-ip'])) {
      res.status(400).json({ message: 'Client IP unavailable' });
      return;
    }
    next();
  };
}

/** `2001:db8::1` → the eight 4-digit groups (better-auth's `expandIPv6`). */
function expandIPv6(ip: string): string[] {
  if (!ip.includes('::')) return ip.split(':').map((g) => g.padStart(4, '0'));
  const [head = '', tail = ''] = ip.split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  return [
    ...left.map((g) => g.padStart(4, '0')),
    ...Array<string>(8 - left.length - right.length).fill('0000'),
    ...right.map((g) => g.padStart(4, '0')),
  ];
}

/** An IPv4-mapped IPv6 address as its IPv4, dotted or hex form (better-auth's rules). */
function mappedIPv4(ip: string): string | null {
  const lower = ip.toLowerCase();
  if (lower.startsWith('::ffff:') && isIPv4(lower.slice(7))) return lower.slice(7);
  const parts = lower.split(':');
  if (parts.length === 7 && parts[5] === 'ffff' && parts[6] && isIPv4(parts[6])) return parts[6];
  if (!lower.includes(':ffff:')) return null;
  const groups = expandIPv6(lower);
  if (groups.length !== 8 || groups.slice(0, 5).some((g) => g !== '0000') || groups[5] !== 'ffff') {
    return null;
  }
  const [g6 = '', g7 = ''] = [groups[6], groups[7]];
  return [g6.slice(0, 2), g6.slice(2, 4), g7.slice(0, 2), g7.slice(2, 4)]
    .map((byte) => Number.parseInt(byte, 16))
    .join('.');
}

/**
 * The rate-limit bucket for an IP, grouped exactly as better-auth's
 * `normalizeIP` groups it (`@better-auth/core` `dist/utils/ip.mjs`): IPv4 as
 * is; an IPv4-mapped IPv6 address, dotted or hex, as its IPv4; any other IPv6
 * address by its /64, so one host cannot rotate through its own prefix.
 */
export function ipBucket(ip: string): string {
  if (isIPv4(ip)) return ip;
  if (!isIPv6(ip)) return ip.toLowerCase();
  const v4 = mappedIPv4(ip);
  if (v4) return v4;
  return [...expandIPv6(ip.toLowerCase()).slice(0, 4), '0000', '0000', '0000', '0000'].join(':');
}
