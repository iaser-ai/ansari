// Drive a createAuth() instance through its real HTTP handler, so the router,
// its rate limiter and every hook run exactly as they would behind apps/auth.
import bcrypt from 'bcrypt';
import { eq } from 'drizzle-orm';

import { schema, type Auth, type Db } from '../../src/index';

export const BASE = 'http://localhost:3100';

let ipCounter = 0;

/**
 * A fresh client IP per call, so tests that are not about rate limiting never
 * share a bucket. Tests about limits pass their own `ip`.
 */
export function freshIp(): string {
  ipCounter += 1;
  return `198.51.${Math.floor(ipCounter / 250) % 250}.${(ipCounter % 250) + 1}`;
}

export type CallOptions = {
  method?: 'GET' | 'POST';
  body?: unknown;
  bearer?: string;
  ip?: string | null;
  headers?: Record<string, string>;
};

export async function call(auth: Auth, path: string, opts: CallOptions = {}): Promise<Response> {
  const headers = new Headers({ origin: BASE, ...opts.headers });
  if (opts.body !== undefined) headers.set('content-type', 'application/json');
  if (opts.bearer) headers.set('authorization', `Bearer ${opts.bearer}`);
  const ip = opts.ip === undefined ? freshIp() : opts.ip;
  if (ip !== null) headers.set('x-real-ip', ip);
  return auth.handler(
    new Request(`${BASE}/api/auth${path}`, {
      method: opts.method ?? (opts.body === undefined ? 'GET' : 'POST'),
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    })
  );
}

export async function json<T = Record<string, unknown>>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

/** Sign in; returns the raw session token (the body's `token`) and the response. */
export async function signIn(
  auth: Auth,
  email: string,
  password: string,
  opts: Omit<CallOptions, 'body'> = {}
): Promise<{ res: Response; token: string | undefined }> {
  const res = await call(auth, '/sign-in/email', { ...opts, body: { email, password } });
  const token = res.ok ? (await json<{ token: string }>(res.clone())).token : undefined;
  return { res, token };
}

/** Exchange a session token for a JWT at /token. */
export async function mintJwt(auth: Auth, sessionToken: string): Promise<Response> {
  return call(auth, '/token', { bearer: sessionToken });
}

/**
 * A user exactly as the cutover copy writes one: an auth.users row under a
 * given id plus one `credential` account holding the given hash.
 */
export async function insertLegacyUser(
  db: Db,
  user: { id: string; email: string; passwordHash: string; name?: string }
): Promise<void> {
  await db.insert(schema.users).values({
    id: user.id,
    email: user.email,
    name: user.name ?? 'Legacy User',
    emailVerified: true,
  });
  await db.insert(schema.account).values({
    accountId: user.id,
    providerId: 'credential',
    userId: user.id,
    password: user.passwordHash,
    updatedAt: new Date(),
  });
}

/** A bcrypt hash in apps/api's legacy format (`$2b$`, cost 12). */
export async function legacyBcryptHash(password: string): Promise<string> {
  return bcrypt.hash(password, 12);
}

export async function sessionByToken(db: Db, token: string) {
  const [row] = await db.select().from(schema.session).where(eq(schema.session.token, token));
  return row;
}

/** Decode a JWT's header and payload without verifying (verification is separate). */
export function decodeJwt(token: string): {
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
} {
  const [header, payload] = token.split('.');
  const decode = (part: string | undefined) =>
    JSON.parse(Buffer.from(part ?? '', 'base64url').toString('utf8')) as Record<string, unknown>;
  return { header: decode(header), payload: decode(payload) };
}
