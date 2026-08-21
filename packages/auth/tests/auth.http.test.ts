// HTTP-level tests for the two things the API-level integration test cannot see
// (it calls `auth.api.*` directly): the trusted-origin config for the Expo
// scheme, and the `Set-Cookie` attributes a browser would actually receive.
// These are the two things that regressed (wrong Expo scheme; Secure-over-HTTP),
// so this file is the coverage that catches them.
//
// NOTE on the scheme test being config-level, not an HTTP rejection: better-auth
// 1.6.27 does not emit a discriminating 4xx for an untrusted *custom scheme* in
// process (probed: sign-in/out with an untrusted `askbad://` / `expo-origin`
// still return 200), so an "expect 403 for the wrong scheme" test would have no
// teeth. Asserting the resolved `trustedOrigins` is the deterministic,
// negative-testable guard — flip the scheme back to `ansari://` and it fails.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';

import { createAuth, resetEnvCache, type Auth, type Db } from '../src/index';

const migrationSql = readFileSync(
  fileURLToPath(new URL('../drizzle/0000_better_auth_init.sql', import.meta.url)),
  'utf8'
);

const BASE = 'http://localhost:3100';
const user = { name: 'HTTP User', email: 'http@example.com', password: 'correct-horse-battery-staple' };

let client: PGlite;
let db: Db;
let auth: Auth;

function setEnv(baseUrl: string) {
  process.env.DATABASE_URL = 'postgres://test:test@localhost:5432/test';
  process.env.BETTER_AUTH_SECRET = 'test-secret-at-least-32-characters-long-000';
  process.env.BETTER_AUTH_URL = baseUrl;
  process.env.CORS_ORIGIN = 'http://localhost:3100';
  process.env.NODE_ENV = 'test';
  resetEnvCache();
}

function signInReq(baseUrl: string, origin: string): Request {
  return new Request(`${baseUrl}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin },
    body: JSON.stringify({ email: user.email, password: user.password }),
  });
}

beforeAll(async () => {
  setEnv(BASE); // http baseURL → dev cookie mode
  client = new PGlite();
  await client.exec(migrationSql);
  db = drizzle(client, { schema: {} }) as unknown as Db;
  auth = createAuth(db);

  const signUp = await auth.handler(
    new Request(`${BASE}/api/auth/sign-up/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: BASE },
      body: JSON.stringify(user),
    })
  );
  expect(signUp.status).toBe(200);
});

afterAll(async () => {
  await client?.close();
});

describe('trusted origins carry the frontend Expo scheme', () => {
  it('trusts askansari:// (apps/frontend/app.json) and not the scaffold default ansari://', () => {
    const origins = auth.options.trustedOrigins as string[];
    expect(origins).toContain('askansari://');
    expect(origins).not.toContain('ansari://');
  });

  it('accepts a sign-in bearing the askansari:// origin over HTTP', async () => {
    const res = await auth.handler(signInReq(BASE, 'askansari://'));
    expect(res.status).toBe(200);
  });
});

describe('cookie attributes track the transport (catches Secure-over-HTTP)', () => {
  it('over an http baseURL, issues a non-Secure SameSite=Lax cookie so local login works', async () => {
    const res = await auth.handler(signInReq(BASE, BASE));
    expect(res.status).toBe(200);
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('better-auth.session_token');
    expect(setCookie).not.toMatch(/;\s*Secure/i);
    expect(setCookie).toMatch(/SameSite=Lax/i);
  });

  it('over an https baseURL, issues a Secure SameSite=None cookie for cross-origin clients', async () => {
    setEnv('https://auth.example.com');
    const httpsAuth = createAuth(db);
    const res = await httpsAuth.handler(signInReq('https://auth.example.com', 'https://auth.example.com'));
    expect(res.status).toBe(200);
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toMatch(/;\s*Secure/i);
    expect(setCookie).toMatch(/SameSite=None/i);
    setEnv(BASE); // restore for any later work
  });
});
