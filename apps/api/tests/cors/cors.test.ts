// CORS on apps/api (spec 300, scenario 28, the apps/api half as amended).
// apps/api is bearer-only, so it never does credentialed CORS: no response
// carries Access-Control-Allow-Credentials, the origin is the wildcard, and a
// browser therefore refuses any credentialed cross-origin request while a
// bearer request from any origin goes through.
//
// The headers come from next.config.ts, which only a running Next server
// applies, so this suite boots one (tests/cors/next-server.ts) and sweeps
// every route file × every exported method, preflight and actual request.
// Each response is judged by the browser's CORS check (Fetch standard), not
// only by header presence.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startNextServer, type NextTestServer } from './next-server';

const API_DIR = path.resolve(__dirname, '../../src/app/api');
const ANY_ORIGIN = 'https://not-an-ansari-origin.example';
const ID = '11111111-1111-4111-8111-111111111111';
// What the web app and the mobile apps send.
const REQUEST_HEADERS = ['authorization', 'content-type', 'x-ansari-client'];
const SAFELISTED_METHODS = new Set(['GET', 'HEAD', 'POST']);
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

interface Route {
  url: string;
  methods: string[];
}

function routeFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return routeFiles(full);
    return entry.name === 'route.ts' ? [full] : [];
  });
}

function routes(): Route[] {
  return routeFiles(API_DIR).map((file) => {
    const segments = path
      .relative(API_DIR, path.dirname(file))
      .split(path.sep)
      .map((s) => (s.startsWith('[') ? ID : decodeURIComponent(s)));
    const source = readFileSync(file, 'utf8');
    const methods = METHODS.filter((m) =>
      new RegExp(`export\\s+(async\\s+function|function|const)\\s+${m}\\b`).test(source)
    );
    return { url: `/api/${segments.join('/')}`, methods };
  });
}

function listed(value: string | null): string[] {
  return (value ?? '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
}

/** The browser's CORS check on a response (Fetch standard, "CORS check"). */
function corsCheck(res: Response, origin: string, credentials: boolean): boolean {
  const allowOrigin = res.headers.get('access-control-allow-origin');
  if (credentials) {
    return allowOrigin === origin && res.headers.get('access-control-allow-credentials') === 'true';
  }
  return allowOrigin === '*' || allowOrigin === origin;
}

/** The browser's verdict on a preflight (Fetch standard, "CORS-preflight fetch"). */
function preflightAllows(
  res: Response,
  request: { origin: string; method: string; headers: string[]; credentials: boolean }
): boolean {
  if (res.status < 200 || res.status > 299) return false;
  if (!corsCheck(res, request.origin, request.credentials)) return false;
  const methods = listed(res.headers.get('access-control-allow-methods'));
  const methodOk =
    SAFELISTED_METHODS.has(request.method) ||
    methods.includes(request.method) ||
    (!request.credentials && methods.includes('*'));
  if (!methodOk) return false;
  const allowed = listed(res.headers.get('access-control-allow-headers')).map((h) => h.toLowerCase());
  return request.headers.every(
    (h) =>
      allowed.includes(h) ||
      // A wildcard never covers Authorization, and never applies with credentials.
      (!request.credentials && h !== 'authorization' && allowed.includes('*'))
  );
}

let server: NextTestServer;

beforeAll(async () => {
  server = await startNextServer();
}, 120_000);

afterAll(async () => {
  await server?.close();
});

const ROUTES = routes();

describe('CORS on apps/api (scenario 28, apps/api half)', () => {
  it('sweeps every route file and finds methods in each', () => {
    // Not vacuous: a broken walk or method scan would sweep nothing.
    expect(ROUTES.length).toBeGreaterThanOrEqual(23);
    for (const route of ROUTES) expect(route.methods.length, route.url).toBeGreaterThan(0);
    expect(ROUTES.map((r) => r.url)).toContain('/api/v2/_diag/client-ip');
    expect(ROUTES.map((r) => r.url)).toContain(`/api/v2/threads/${ID}/chat`);
  });

  for (const route of ROUTES) {
    for (const method of route.methods) {
      it(`${method} ${route.url}: preflight grants a bearer request from any origin, never credentials`, async () => {
        const res = await fetch(server.url + route.url, {
          method: 'OPTIONS',
          headers: {
            Origin: ANY_ORIGIN,
            'Access-Control-Request-Method': method,
            'Access-Control-Request-Headers': REQUEST_HEADERS.join(', '),
          },
        });
        expect(res.headers.has('access-control-allow-credentials')).toBe(false);
        expect(res.headers.get('access-control-allow-origin')).toBe('*');
        const request = { origin: ANY_ORIGIN, method, headers: REQUEST_HEADERS };
        expect(preflightAllows(res, { ...request, credentials: false })).toBe(true);
        expect(preflightAllows(res, { ...request, credentials: true })).toBe(false);
      }, 60_000);

      it(`${method} ${route.url}: the actual response is readable without credentials, never with them`, async () => {
        const res = await fetch(server.url + route.url, {
          method,
          headers: {
            Origin: ANY_ORIGIN,
            Authorization: 'Bearer not-a-real-token',
            'Content-Type': 'application/json',
            'X-Ansari-Client': 'web',
          },
          body: method === 'GET' ? undefined : '{}',
        });
        await res.arrayBuffer();
        expect(res.headers.has('access-control-allow-credentials')).toBe(false);
        expect(res.headers.get('access-control-allow-origin')).toBe('*');
        expect(corsCheck(res, ANY_ORIGIN, false)).toBe(true);
        expect(corsCheck(res, ANY_ORIGIN, true)).toBe(false);
      }, 60_000);
    }
  }
});

describe('the browser check this suite relies on', () => {
  // Negative tests of corsCheck / preflightAllows, so a check that always
  // passes cannot pass the sweep.
  const res = (headers: Record<string, string>, status = 204) => new Response(null, { status, headers });
  const bearer = { origin: ANY_ORIGIN, method: 'DELETE', headers: REQUEST_HEADERS, credentials: false };

  it('accepts the shape apps/api sends', () => {
    const ok = res({
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET,DELETE',
      'access-control-allow-headers': 'Authorization, Content-Type, X-Ansari-Client',
    });
    expect(preflightAllows(ok, bearer)).toBe(true);
  });

  it('refuses the legacy wildcard-with-credentials shape for a credentialed request', () => {
    const legacy = res({
      'access-control-allow-origin': '*',
      'access-control-allow-credentials': 'true',
      'access-control-allow-methods': 'GET,DELETE',
      'access-control-allow-headers': 'Authorization, Content-Type, X-Ansari-Client',
    });
    expect(preflightAllows(legacy, { ...bearer, credentials: true })).toBe(false);
  });

  it('refuses a missing origin, a missing method, a missing header, a wildcard for Authorization, a failed status', () => {
    const base = {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET,DELETE',
      'access-control-allow-headers': 'Authorization, Content-Type, X-Ansari-Client',
    };
    expect(preflightAllows(res({ ...base, 'access-control-allow-origin': '' }), bearer)).toBe(false);
    expect(preflightAllows(res({ ...base, 'access-control-allow-methods': 'GET' }), bearer)).toBe(false);
    expect(preflightAllows(res({ ...base, 'access-control-allow-headers': 'Authorization, Content-Type' }), bearer)).toBe(false);
    expect(preflightAllows(res({ ...base, 'access-control-allow-headers': '*' }), bearer)).toBe(false);
    expect(preflightAllows(res(base, 500), bearer)).toBe(false);
  });

  it('a credentialed request passes only an exact origin with Allow-Credentials', () => {
    expect(corsCheck(res({ 'access-control-allow-origin': '*' }), ANY_ORIGIN, true)).toBe(false);
    expect(
      corsCheck(
        res({ 'access-control-allow-origin': ANY_ORIGIN, 'access-control-allow-credentials': 'true' }),
        ANY_ORIGIN,
        true
      )
    ).toBe(true);
  });
});
