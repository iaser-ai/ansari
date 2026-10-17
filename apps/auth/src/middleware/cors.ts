// CORS for the public listener (plan phase 4; scenario 28). Exact origins only,
// no credentials (bearer transport on every platform), and the headers a
// browser client must read.
import { CLIENT_HEADER } from '@ansari/auth';
import cors from 'cors';
import type { NextFunction, Request, RequestHandler, Response } from 'express';

/**
 * The headers a browser may read: the session token, the JWT, and how long a
 * 429 asks it to wait (`tooManyRequests` sets `X-Retry-After`; unexposed, a
 * browser client could never honour it).
 */
export const EXPOSED_HEADERS = ['set-auth-token', 'set-auth-jwt', 'X-Retry-After'];
/** `X-Ansari-Client` must pass the preflight, or browser sign-ups lose attribution. */
export const ALLOWED_HEADERS = ['Content-Type', 'Authorization', CLIENT_HEADER];

const EXPOSE = 'access-control-expose-headers';

/**
 * Exact-match origins. A function origin that answers `false` makes the cors
 * package skip EVERY CORS header, so a disallowed origin gets no allow response
 * at all (an array origin would still send the allow-headers list).
 */
export function corsFor(origins: readonly string[]): RequestHandler {
  const allowed = new Set(origins);
  return cors({
    origin: (origin, callback) => callback(null, origin !== undefined && allowed.has(origin) ? origin : false),
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ALLOWED_HEADERS,
    exposedHeaders: EXPOSED_HEADERS,
    credentials: false,
  });
}

/**
 * better-auth's bearer and jwt plugins set `Access-Control-Expose-Headers` on
 * their own responses, which replaces the list cors set (better-call writes
 * each header with `res.setHeader`). Merge instead, so an allowed origin can
 * always read both tokens.
 */
export function mergeExposedHeaders(_req: Request, res: Response, next: NextFunction): void {
  const setHeader = res.setHeader.bind(res);
  res.setHeader = ((name: string, value: number | string | readonly string[]) => {
    if (name.toLowerCase() !== EXPOSE) return setHeader(name, value);
    const current = res.getHeader(EXPOSE);
    if (current === undefined) return setHeader(name, value);
    const merged = new Map<string, string>();
    for (const part of [current, value].flat().join(',').split(',')) {
      const header = part.trim();
      if (header) merged.set(header.toLowerCase(), header);
    }
    return setHeader(name, [...merged.values()].join(', '));
  }) as Response['setHeader'];
  next();
}
