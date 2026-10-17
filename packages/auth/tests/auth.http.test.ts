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

import type { PGlite } from '@electric-sql/pglite';
import { betterAuth } from 'better-auth';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';

import {
  createAuth,
  DEV_TRUSTED_ORIGINS,
  trustedOriginsFor,
  type Auth,
  type Db,
} from '../src/index';
import { drizzleFor, migrate, setAuthEnv } from './helpers/auth-db';

const BASE = 'http://localhost:3100';
const user = { name: 'HTTP User', email: 'http@example.com', password: 'correct-horse-battery-staple' };

let client: PGlite;
let db: Db;
let auth: Auth;

const setEnv = setAuthEnv;

function signInReq(baseUrl: string, origin: string): Request {
  return new Request(`${baseUrl}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin },
    body: JSON.stringify({ email: user.email, password: user.password }),
  });
}

beforeAll(async () => {
  setEnv(BASE); // http baseURL → dev cookie mode
  client = await migrate();
  db = drizzleFor(client);
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
  // `ansarichat` is apps/frontend/app.json's scheme (the legacy store app's,
  // #262). The rejected ones are the prototype default `ansari://` and the
  // scaffold's former `askansari://`, so reverting the scheme here fails.
  it('trusts ansarichat:// (apps/frontend/app.json), not ansari:// or askansari://', () => {
    const origins = auth.options.trustedOrigins as string[];
    expect(origins).toContain('ansarichat://');
    expect(origins).not.toContain('ansari://');
    expect(origins).not.toContain('askansari://');
  });

  // Cross-config guard: whatever scheme apps/frontend/app.json declares must be
  // trusted here, so changing the app's scheme without this package fails CI.
  // Read by path (not imported) so tsconfig stays package-local; the manifest is
  // a declared input of this package's turbo `test` task (packages/auth/turbo.json),
  // or a warm cache would replay this test when only the manifest changes.
  it("trusts apps/frontend/app.json's expo.scheme", () => {
    const manifest = JSON.parse(
      readFileSync(
        fileURLToPath(new URL('../../../apps/frontend/app.json', import.meta.url)),
        'utf8'
      )
    ) as { expo: { scheme: string } };
    const origins = auth.options.trustedOrigins as string[];
    expect(origins).toContain(`${manifest.expo.scheme}://`);
  });

  it('accepts a sign-in bearing the ansarichat:// origin over HTTP', async () => {
    const res = await auth.handler(signInReq(BASE, 'ansarichat://'));
    expect(res.status).toBe(200);
  });
});

describe('development origins are never trusted in production', () => {
  const base = {
    CORS_ORIGIN: ['https://ansari.chat'],
    AUTH_LAYER_ORIGIN: 'https://api.ansari.chat',
  };

  it('production trusts the web origins, the layer and the app scheme only', () => {
    const origins = trustedOriginsFor({ ...base, NODE_ENV: 'production' });
    expect(origins).toEqual(['https://ansari.chat', 'https://api.ansari.chat', 'ansarichat://']);
    for (const dev of DEV_TRUSTED_ORIGINS) expect(origins).not.toContain(dev);
    expect(origins).not.toContain('exp://');
    expect(origins).not.toContain('http://localhost:8081');
  });

  it.each(['development', 'test'] as const)('%s also trusts Expo Go and Metro web', (NODE_ENV) => {
    const origins = trustedOriginsFor({ ...base, NODE_ENV });
    expect(origins).toContain('exp://');
    expect(origins).toContain('http://localhost:8081');
  });

  it('createAuth() uses the environment-gated list', () => {
    expect(auth.options.trustedOrigins).toEqual(
      trustedOriginsFor({
        CORS_ORIGIN: ['http://localhost:3100'],
        AUTH_LAYER_ORIGIN: process.env.AUTH_LAYER_ORIGIN as string,
        NODE_ENV: 'test',
      })
    );
  });
});

// #266: better-auth skips the origin check under NODE_ENV=test unless
// `advanced.disableOriginCheck` is set (dist/context/create-context.mjs:211),
// so an origin test passed whatever the config said. createAuth() now sets it to
// false explicitly, and these requests are rejected for real.
describe('a cookie-bearing request from an untrusted origin is rejected (#266)', () => {
  function signOutReq(origin: string): Request {
    return new Request(`${BASE}/api/auth/sign-out`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin,
        cookie: 'better-auth.session_token=anything',
      },
      body: '{}',
    });
  }

  it('rejects a wrong origin with 403 INVALID_ORIGIN', async () => {
    const res = await auth.handler(signOutReq('https://evil.example'));
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code?: string }).code).toBe('INVALID_ORIGIN');
  });

  it('accepts the configured web origin', async () => {
    expect((await auth.handler(signOutReq(BASE))).status).not.toBe(403);
  });

  it('negative control: with the check bypassed, the same wrong origin passes', async () => {
    const bypassed = betterAuth({
      ...auth.options,
      advanced: { ...auth.options.advanced, disableOriginCheck: true },
    });
    expect((await bypassed.handler(signOutReq('https://evil.example'))).status).not.toBe(403);
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
