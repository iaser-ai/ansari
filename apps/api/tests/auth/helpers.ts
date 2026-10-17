import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import * as schema from '@/db/schema';
import { resetEnvCache } from '@/lib/config';
import { resetJwksCache } from '@/lib/auth/verify-jwt';
import { startService, type Service, type ServiceOptions } from '../../../auth/tests/helpers/service';

/**
 * Shared plumbing for the spec 300 phase 7 suites.
 *
 * - `startJwksServer`: a local JWKS handler with real key pairs, standing in
 *   for apps/auth's public JWKS in the rejection matrix. It counts every
 *   request and keeps the headers of the last one.
 * - `startAuth`: the real apps/auth (its one listener over pglite), with
 *   apps/api's env pointed at it.
 * - `migrateAppDb`: the app database from the real journal, as at the window
 *   (through 0011, so `password_hash` is nullable).
 */

export const TEST_ISSUER = 'https://auth.test.example';
export const TEST_AUDIENCE = 'ansari-api-test';
/** apps/api's origin: packages/auth's TEST_LAYER_ORIGIN, which apps/auth trusts. */
export const TEST_LAYER_ORIGIN = 'https://api.test.example';
export const LEGACY_JWT_SECRET = 'phase-7-legacy-jwt-secret-at-least-32-chars';

/**
 * A token as the retired legacy auth (apps/api/lib/auth/jwt.ts, removed in
 * phase 9) minted it: HS256 over `{user_id, type, session_version}` with an
 * expiry. Built here with jose, so the refusal tests keep a real legacy token
 * after the code that signed them is gone.
 */
export async function legacyAccessToken(userId: string = randomUUID()): Promise<string> {
  return new SignJWT({ user_id: userId, type: 'access', session_version: 0 })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuedAt()
    .setExpirationTime('2h')
    .sign(new TextEncoder().encode(LEGACY_JWT_SECRET));
}

/** apps/api's own required env, plus apps/auth's coordinates. */
export function setApiEnv(authUrl: string): void {
  process.env.DATABASE_URL = 'postgres://test:test@localhost:5432/test';
  process.env.KALEMAT_API_KEY = 'placeholder';
  process.env.USUL_API_TOKEN = 'placeholder';
  process.env.AUTH_URL = authUrl;
  process.env.AUTH_JWT_ISSUER = TEST_ISSUER;
  process.env.AUTH_JWT_AUDIENCE = TEST_AUDIENCE;
  process.env.AUTH_LAYER_ORIGIN = TEST_LAYER_ORIGIN;
  resetEnvCache();
  resetJwksCache();
}

// ---------------------------------------------------------------------------
// Local JWKS server

export interface SigningKey {
  kid: string;
  alg: 'EdDSA' | 'RS256';
  privateKey: Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];
  publicJwk: JWK;
}

export async function newKey(alg: 'EdDSA' | 'RS256' = 'EdDSA'): Promise<SigningKey> {
  const { privateKey, publicKey } = await generateKeyPair(alg, { extractable: true });
  const kid = randomUUID();
  return { kid, alg, privateKey, publicJwk: { ...(await exportJWK(publicKey)), kid, alg } };
}

export interface JwksServer {
  url: string;
  /** Every request that reached the handler. */
  requests: number;
  /** The headers of the last request. */
  lastHeaders: IncomingMessage['headers'] | null;
  /** The keys served, in order. */
  keys: SigningKey[];
  /** Answer 500 (with the key set as its body). */
  failing: boolean;
  /** Answer 200 with this body instead of the key set. */
  malformedBody: string | null;
  stop(): Promise<void>;
}

export async function startJwksServer(initial: SigningKey[]): Promise<JwksServer> {
  const state = {
    requests: 0,
    lastHeaders: null as IncomingMessage['headers'] | null,
    keys: [...initial],
    failing: false,
    malformedBody: null as string | null,
  };
  const handler = (req: IncomingMessage, res: ServerResponse) => {
    state.requests += 1;
    state.lastHeaders = req.headers;
    const keySet = JSON.stringify({ keys: state.keys.map((k) => k.publicJwk) });
    if (state.failing) {
      // A valid key set under a 500: only the status says the refresh failed.
      res.writeHead(500, { 'content-type': 'application/json' }).end(keySet);
      return;
    }
    if (req.url !== '/api/auth/jwks') {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(state.malformedBody ?? keySet);
  };
  const server: Server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url,
    get requests() {
      return state.requests;
    },
    get lastHeaders() {
      return state.lastHeaders;
    },
    get keys() {
      return state.keys;
    },
    get failing() {
      return state.failing;
    },
    set failing(value: boolean) {
      state.failing = value;
    },
    get malformedBody() {
      return state.malformedBody;
    },
    set malformedBody(value: string | null) {
      state.malformedBody = value;
    },
    async stop() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

export interface TokenOptions {
  key: SigningKey;
  sub?: string | null;
  sid?: string | null;
  issuer?: string;
  audience?: string;
  /** Seconds from now; negative for an expired token; null for no `exp`. */
  expiresIn?: number | null;
  kid?: string;
}

/** A token as apps/auth would mint it, with any claim overridable or omitted. */
export async function signToken(opts: TokenOptions): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const payload: Record<string, unknown> = {};
  const sub = opts.sub === undefined ? randomUUID() : opts.sub;
  const sid = opts.sid === undefined ? randomUUID() : opts.sid;
  if (sub !== null) payload.sub = sub;
  if (sid !== null) payload.sid = sid;
  const jwt = new SignJWT(payload)
    .setProtectedHeader({ alg: opts.key.alg, kid: opts.kid ?? opts.key.kid })
    .setIssuedAt(now - 60)
    .setIssuer(opts.issuer ?? TEST_ISSUER)
    .setAudience(opts.audience ?? TEST_AUDIENCE);
  const expiresIn = opts.expiresIn === undefined ? 900 : opts.expiresIn;
  if (expiresIn !== null) jwt.setExpirationTime(now + expiresIn);
  return jwt.sign(opts.key.privateKey);
}

// ---------------------------------------------------------------------------
// Real apps/auth

export type AuthService = Service;

export async function startAuth(options: ServiceOptions = {}): Promise<Service> {
  const service = await startService(options);
  setApiEnv(service.publicUrl);
  return service;
}

/** apps/api's egress IP, as Railway's edge stamps it on every call apps/api makes to apps/auth. */
export const API_EGRESS_IP = '192.0.2.250';

export interface Edge {
  url: string;
  /** Every X-Real-IP the edge stamped, in order. */
  stamped: string[];
  stop(): Promise<void>;
}

/**
 * A stand-in for Railway's edge in front of apps/auth's public domain: it
 * overwrites X-Real-IP with the caller's address (here always apps/api's
 * egress IP) and passes the request through. apps/auth in production mode
 * refuses router requests without one.
 */
export async function startEdge(target: string): Promise<Edge> {
  const stamped: string[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
      if (typeof value === 'string' && name !== 'host' && name !== 'connection') headers.set(name, value);
    }
    headers.set('x-real-ip', API_EGRESS_IP);
    stamped.push(API_EGRESS_IP);
    const upstream = await fetch(new URL(req.url ?? '/', target), {
      method: req.method,
      headers,
      body: chunks.length ? Buffer.concat(chunks) : undefined,
      redirect: 'manual',
    });
    const out: Record<string, string> = {};
    upstream.headers.forEach((value, name) => {
      if (name !== 'content-encoding' && name !== 'content-length' && name !== 'transfer-encoding') out[name] = value;
    });
    res.writeHead(upstream.status, out);
    res.end(Buffer.from(await upstream.arrayBuffer()));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    stamped,
    async stop() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/** An address with nothing listening, for "apps/auth is unreachable". */
export async function deadUrl(): Promise<string> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await new Promise((resolve) => server.close(resolve));
  return url;
}

// ---------------------------------------------------------------------------
// App database

const DRIZZLE_DIR = path.resolve(__dirname, '../../drizzle');

/**
 * A legacy app row: one the copy carried over, holding a password hash, under
 * its own id. Raw SQL, because apps/api no longer writes credentials.
 */
export async function insertLegacyUserRow(app: PGlite, email: string): Promise<{ id: string }> {
  const { rows } = await app.query<{ id: string }>(
    "INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id",
    [email]
  );
  return rows[0]!;
}

export async function migrateAppDb(): Promise<PGlite> {
  const client = new PGlite();
  const journal: { tag: string }[] = JSON.parse(
    readFileSync(path.join(DRIZZLE_DIR, 'meta/_journal.json'), 'utf8')
  ).entries;
  for (const { tag } of journal) {
    const sql = readFileSync(path.join(DRIZZLE_DIR, `${tag}.sql`), 'utf8');
    for (const stmt of sql.split('--> statement-breakpoint')) {
      if (stmt.trim()) await client.exec(stmt);
    }
  }
  return client;
}

export function appDrizzle(client: PGlite) {
  return drizzle(client, { schema });
}
