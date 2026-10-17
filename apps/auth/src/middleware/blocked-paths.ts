// Refuses the admin plugin's HTTP surface, the two profile-changing routes and
// change-password before Better Auth sees the request (spec 300, Hosting and token model).
//
// `disabledPaths` in createAuth() covers the same routes, but better-auth
// matches it against the exact normalized path only (dist/api/index.mjs:166-168).
// This middleware canonicalizes first, so case, trailing-slash, percent-encoded,
// backslash, doubled-slash and dot-segment variants all get the one block
// response: 404 with an empty body.
import { posix } from 'node:path';

import { ADMIN_PATHS, BLOCKED_AUTH_PATHS } from '@ansari/auth';
import type { NextFunction, Request, Response } from 'express';

const ADMIN_PREFIX = '/api/auth/admin';
// Every blocked route that is not an admin path, from the one list createAuth()
// also passes to `disabledPaths`, so the two cannot drift apart.
const BLOCKED_EXACT = new Set(
  BLOCKED_AUTH_PATHS.filter((path) => !ADMIN_PATHS.includes(path)).map((path) => `/api/auth${path}`)
);

/** An absolute-form request target (`GET http://host/api/auth/...`). */
const ABSOLUTE_FORM = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i;

/** Decode repeatedly so `%2561dmin` cannot survive as `%61dmin`. */
const MAX_DECODE_PASSES = 4;

/**
 * The path as a request router could end up seeing it: any `scheme://authority`
 * of an absolute-form target removed, decoded, backslashes as
 * slashes (the WHATWG URL parser does that), doubled slashes collapsed, dot
 * segments resolved, lowercased, no trailing slash. `null` when the encoding is
 * malformed.
 */
export function canonicalPath(rawUrl: string): string | null {
  // An absolute-form target names the path after its authority; keep only that.
  let path = rawUrl.replace(ABSOLUTE_FORM, '').split(/[?#]/, 1)[0] ?? '';
  for (let pass = 0; pass < MAX_DECODE_PASSES; pass++) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(path);
    } catch {
      return null;
    }
    if (decoded === path) break;
    path = decoded;
  }
  path = path.replace(/\\/g, '/').replace(/\/{2,}/g, '/');
  path = posix.normalize(path.startsWith('/') ? path : `/${path}`).toLowerCase();
  return path.length > 1 ? path.replace(/\/+$/, '') : path;
}

export function isBlockedPath(rawUrl: string): boolean {
  const path = canonicalPath(rawUrl);
  // Malformed encoding is refused rather than passed through undecided.
  if (path === null) return true;
  return path === ADMIN_PREFIX || path.startsWith(`${ADMIN_PREFIX}/`) || BLOCKED_EXACT.has(path);
}

export function blockedPaths(req: Request, res: Response, next: NextFunction): void {
  if (isBlockedPath(req.originalUrl)) {
    res.status(404).end();
    return;
  }
  next();
}
