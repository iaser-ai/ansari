// The rest of the public face: CORS (scenario 28), the edge-check diag route
// (plan P-4) and the health probe.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { TEST_LAYER_ORIGIN } from '../../../packages/auth/tests/helpers/auth-db';
import {
  BASE,
  freshIp,
  send,
  signUp,
  startService,
  STRONG_PASSWORD,
  type Service,
} from './helpers/service';

let service: Service;

beforeAll(async () => {
  service = await startService();
  expect((await signUp(service, 'cors@example.com')).status).toBe(200);
});

afterAll(async () => {
  await service?.close();
});

const preflight = (origin: string, requestHeaders = 'content-type,authorization,x-ansari-client') =>
  fetch(`${service.publicUrl}/api/auth/sign-in/email`, {
    method: 'OPTIONS',
    headers: {
      origin,
      'access-control-request-method': 'POST',
      'access-control-request-headers': requestHeaders,
    },
  });

describe('CORS (scenario 28)', () => {
  it('a preflight from the allowed origin passes, X-Ansari-Client included, without credentials', async () => {
    const res = await preflight(BASE);
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe(BASE);
    const allowed = (res.headers.get('access-control-allow-headers') ?? '').toLowerCase();
    for (const header of ['content-type', 'authorization', 'x-ansari-client']) {
      expect(allowed).toContain(header);
    }
    expect(res.headers.get('access-control-allow-credentials')).toBeNull();
  });

  it('an allowed origin can read set-auth-token and set-auth-jwt', async () => {
    const res = await send(service.publicUrl, '/api/auth/sign-in/email', {
      body: { email: 'cors@example.com', password: STRONG_PASSWORD },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe(BASE);
    const exposed = (res.headers.get('access-control-expose-headers') ?? '').toLowerCase();
    expect(exposed).toContain('set-auth-token');
    expect(exposed).toContain('set-auth-jwt');
    expect(res.headers.get('set-auth-token')).toBeTruthy();

    // get-session is where the jwt plugin hands out set-auth-jwt.
    const session = await send(service.publicUrl, '/api/auth/get-session', {
      bearer: res.headers.get('set-auth-token') ?? '',
    });
    expect(session.status).toBe(200);
    expect(session.headers.get('set-auth-jwt')).toBeTruthy();
    const sessionExposed = (session.headers.get('access-control-expose-headers') ?? '').toLowerCase();
    expect(sessionExposed).toContain('set-auth-token');
    expect(sessionExposed).toContain('set-auth-jwt');
  });

  it('an allowed origin can read X-Retry-After on a 429', async () => {
    const email = 'cors-retry@example.com';
    const ip = freshIp();
    let res: Response | undefined;
    for (let i = 0; i < 6; i++) {
      res = await send(service.publicUrl, '/api/auth/request-password-reset', { ip, body: { email } });
      if (res.status === 429) break;
    }
    expect(res?.status).toBe(429);
    expect(res?.headers.get('access-control-allow-origin')).toBe(BASE);
    expect(Number(res?.headers.get('x-retry-after'))).toBeGreaterThan(0);
    const exposed = (res?.headers.get('access-control-expose-headers') ?? '').toLowerCase();
    expect(exposed).toContain('x-retry-after');
  });

  it.each(['https://evil.example', `${BASE}.evil.example`, 'http://localhost:31000', 'null'])(
    'a disallowed origin (%s) gets no allow headers, on the preflight or the request',
    async (origin) => {
      const pre = await preflight(origin);
      expect(pre.headers.get('access-control-allow-origin')).toBeNull();
      expect(pre.headers.get('access-control-allow-headers')).toBeNull();
      const res = await send(service.publicUrl, '/api/auth/get-session', {
        headers: { origin, cookie: 'better-auth.session_token=anything' },
      });
      expect(res.headers.get('access-control-allow-origin')).toBeNull();
      expect(res.headers.get('access-control-allow-credentials')).toBeNull();
      expect(res.headers.get('access-control-expose-headers')).toBeNull();
    }
  );

  it('a credentialed request from a disallowed origin is refused by the origin check', async () => {
    const res = await send(service.publicUrl, '/api/auth/sign-out', {
      headers: { origin: 'https://evil.example', cookie: 'better-auth.session_token=anything' },
      body: {},
    });
    expect(res.status).toBe(403);
  });

  // apps/api's origin is trusted for the layer's server-side calls, and only
  // that: it is not a CORS origin, so a browser page on apps/api's domain can
  // read nothing back from apps/auth (security, phase 8).
  describe('the layer origin (AUTH_LAYER_ORIGIN)', () => {
    it("passes the CSRF check for the layer's anonymous server-side call", async () => {
      const trusted = await send(service.publicUrl, '/api/auth/sign-in/email', {
        headers: { origin: TEST_LAYER_ORIGIN },
        body: { email: 'cors@example.com', password: STRONG_PASSWORD },
      });
      expect(trusted.status).toBe(200);
      const untrusted = await send(service.publicUrl, '/api/auth/sign-in/email', {
        headers: { origin: 'https://evil.example' },
        body: { email: 'cors@example.com', password: STRONG_PASSWORD },
      });
      expect(untrusted.status).toBe(403);
    });

    it('gets no CORS allow headers from a browser, on the preflight or the request', async () => {
      const pre = await preflight(TEST_LAYER_ORIGIN);
      expect(pre.headers.get('access-control-allow-origin')).toBeNull();
      expect(pre.headers.get('access-control-allow-headers')).toBeNull();
      const res = await send(service.publicUrl, '/api/auth/sign-in/email', {
        headers: { origin: TEST_LAYER_ORIGIN },
        body: { email: 'cors@example.com', password: STRONG_PASSWORD },
      });
      // The sign-in succeeded (the CSRF check trusts this origin), but with no
      // allow-origin the browser can read none of it. better-auth's bearer
      // plugin sets its own expose-headers on any success, which grants
      // nothing without allow-origin, so it is not asserted here.
      expect(res.status).toBe(200);
      expect(res.headers.get('access-control-allow-origin')).toBeNull();
      expect(res.headers.get('access-control-allow-credentials')).toBeNull();
    });
  });
});

/** The edge shapes (docs/cutover/edge-header-shapes.json), each with the probe output it must give. */
const DIAG_SHAPES = (
  JSON.parse(
    readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../../docs/cutover/edge-header-shapes.json'), 'utf8')
  ) as { shapes: { name: string; headers: Record<string, string>; probe: Record<string, unknown> }[] }
).shapes.map((s) => [s.name, s] as const);

describe('the diag route (P-4)', () => {
  it("returns only the caller's own X-Real-IP and the X-Forwarded-For entry count, no-store", async () => {
    const res = await send(service.publicUrl, '/__diag/client-ip', {
      ip: '203.0.113.150',
      headers: { 'x-forwarded-for': '198.51.100.1, 198.51.100.2' },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({
      x_real_ip: '203.0.113.150',
      x_forwarded_for_entries: 2,
      x_forwarded_for_first_is_x_real_ip: false,
      cf_connecting_ip: null,
      via_cloudflare: false,
    });
    expect(text).not.toContain('198.51.100');
  });

  it('reports no IP as null', async () => {
    const res = await send(service.publicUrl, '/__diag/client-ip', { ip: null });
    expect(await res.json()).toEqual({
      x_real_ip: null,
      x_forwarded_for_entries: 0,
      x_forwarded_for_first_is_x_real_ip: false,
      cf_connecting_ip: null,
      via_cloudflare: false,
    });
  });

  it.each(DIAG_SHAPES)('records the shape "%s", with no X-Forwarded-For value but the caller\'s', async (_name, shape) => {
    const res = await send(service.publicUrl, '/__diag/client-ip', { ip: null, headers: shape.headers });
    const text = await res.text();
    expect(JSON.parse(text)).toEqual(shape.probe);
    for (const entry of (shape.headers['x-forwarded-for'] ?? '').split(',').map((e) => e.trim())) {
      if (entry && entry !== shape.headers['x-real-ip']) expect(text).not.toContain(entry);
    }
  });
});

describe('health', () => {
  it('answers 200 once the auth database answers select 1', async () => {
    const res = await send(service.publicUrl, '/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });

  it('answers 503 when the database cannot', async () => {
    const down = await startService();
    await down.client.close();
    try {
      const res = await send(down.publicUrl, '/health');
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ status: 'unavailable' });
    } finally {
      await down.close().catch(() => {});
    }
  });
});
