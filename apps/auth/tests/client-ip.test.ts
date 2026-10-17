// The client IP on the one listener (spec 300 Client IP; scenarios 21 and 22;
// owner amendment 2026-10-17). Rate-limit buckets are read back from
// auth.rate_limit, so each test shows WHICH key a request landed in, not only
// whether it was limited. No path apps/api's layer calls has a per-IP rule
// (tests/limits.test.ts), so the bucket tests use `/ok`, a path under the
// router's per-IP default.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { limits } from '@ansari/auth';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ipBucket, singleIp } from '../src/middleware/client-ip';
import { rateLimitKeys, send, startService, type Service } from './helpers/service';

const SIGN_IN = '/api/auth/sign-in/email';

type EdgeShape = { name: string; headers: Record<string, string>; probe?: { x_real_ip: string }; never?: string[] };
const DOCS_CUTOVER = resolve(dirname(fileURLToPath(import.meta.url)), '../../../docs/cutover');
/** Header shapes behind Railway's edge, per path (docs/cutover/edge-check.md). */
const EDGE = JSON.parse(readFileSync(resolve(DOCS_CUTOVER, 'edge-header-shapes.json'), 'utf8')) as {
  source: string;
  shapes: EdgeShape[];
  withoutTheEdge: EdgeShape[];
};
const wrongPassword = { email: 'nobody@example.com', password: 'Wrong-Passw0rd!' };

let service: Service;

beforeAll(async () => {
  service = await startService();
});

afterAll(async () => {
  await service?.close();
});

const failedSignIn = (baseUrl: string, ip: string | null, headers: Record<string, string> = {}) =>
  send(baseUrl, SIGN_IN, { ip, headers, body: wrongPassword });
const ok = (baseUrl: string, ip: string | null, headers: Record<string, string> = {}) =>
  send(baseUrl, '/api/auth/ok', { ip, headers });

/** The removed internal hop's header names: an attacker may still send them. */
const OLD_HOP_HEADERS = {
  'x-ansari-internal-auth': 'test-internal-secret-at-least-32-characters',
  'x-ansari-forwarded-client-ip': '192.0.2.60',
};

describe('one listener, no internal hop (owner amendment 2026-10-17)', () => {
  it.each([
    '/internal/users/00000000-0000-0000-0000-000000000000/profile',
    '/INTERNAL/users/x/role',
    '/internal/',
    '/internal',
    '/%69nternal/users/x/profile',
    '/Internal/users/x',
  ])('%s is not mounted: 404, with or without the old hop headers', async (path) => {
    for (const headers of [{}, OLD_HOP_HEADERS]) {
      const res = await send(service.publicUrl, path, { headers });
      expect(res.status).toBe(404);
      expect(await res.text()).toBe('');
    }
  });

  it('the old forwarded-IP header never becomes a bucket, whatever comes with it', async () => {
    const res = await ok(service.publicUrl, '203.0.113.60', OLD_HOP_HEADERS);
    expect(res.status).toBe(200);
    const keys = await rateLimitKeys(service);
    expect(keys).toContain('203.0.113.60|/ok');
    expect(keys.some((k) => k.includes('192.0.2.60'))).toBe(false);
  });
});

describe('singleIp', () => {
  it('accepts exactly one address', () => {
    expect(singleIp('203.0.113.1')).toBe('203.0.113.1');
    expect(singleIp(' 2001:db8::1 ')).toBe('2001:db8::1');
    expect(singleIp('::ffff:203.0.113.1')).toBe('::ffff:203.0.113.1');
    for (const bad of [
      '',
      '   ',
      '1.2.3.4, 5.6.7.8',
      '::ffff:zz.zz',
      '::ffff:999.1.1.1',
      'attacker.example',
      `1.2.3.${'4'.repeat(60)}`,
      'fe80::1%eth0',
      '300.1.1.1',
      undefined,
      ['1.2.3.4'],
    ]) {
      expect(singleIp(bad)).toBeNull();
    }
  });
});

describe('scenario 21: one bucket per X-Real-IP, on the router default', () => {
  it(`request ${limits.DEFAULT_RULE.max + 1} from one X-Real-IP is 429; another client is unaffected`, async () => {
    const ip = '203.0.113.80';
    for (let i = 0; i < limits.DEFAULT_RULE.max; i++) {
      expect((await ok(service.publicUrl, ip)).status).toBe(200);
    }
    expect((await ok(service.publicUrl, ip)).status).toBe(429);
    expect((await ok(service.publicUrl, '203.0.113.81')).status).toBe(200);
  });

  it('a forged two-entry X-Forwarded-For does not change the bucket', async () => {
    const ip = '203.0.113.82';
    for (let i = 0; i < limits.DEFAULT_RULE.max; i++) await ok(service.publicUrl, ip);
    const res = await ok(service.publicUrl, ip, { 'x-forwarded-for': '198.51.100.9, 198.51.100.10' });
    expect(res.status).toBe(429);
  });
});

describe('the production 400: no request reaches the shared no-trusted-ip bucket', () => {
  let prod: Service;

  beforeAll(async () => {
    prod = await startService({ production: true });
  });

  afterAll(async () => {
    await prod?.close();
  });

  it.each([
    ['sign-in, no X-Real-IP', () => failedSignIn(prod.publicUrl, null)],
    ['sign-in, a two-entry X-Real-IP', () => failedSignIn(prod.publicUrl, '1.2.3.4, 5.6.7.8')],
    ['the JWKS, no X-Real-IP', () => send(prod.publicUrl, '/api/auth/jwks', { ip: null })],
  ])('%s → 400', async (_name, request) => {
    expect((await request()).status).toBe(400);
  });

  it('nothing was bucketed, least of all no-trusted-ip', async () => {
    expect(await rateLimitKeys(prod)).toEqual([]);
  });

  // apps/api fetches the key set over the public domain, so the edge stamps
  // its egress IP: the JWKS answers, on the router's per-IP default.
  it('the JWKS answers with an X-Real-IP, in production', async () => {
    const res = await send(prod.publicUrl, '/api/auth/jwks', { ip: '192.0.2.30' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { keys: { kid: string; alg?: string }[] };
    expect(Array.isArray(body.keys)).toBe(true);
    expect(await rateLimitKeys(prod)).toContain('192.0.2.30|/jwks');
  });

  it('health, the diag route and the account endpoints answer without an IP', async () => {
    expect((await send(prod.publicUrl, '/health', { ip: null })).status).toBe(200);
    expect((await send(prod.publicUrl, '/__diag/client-ip', { ip: null })).status).toBe(200);
    // Outside the router: no IP rule, only the token (401 here).
    expect((await send(prod.publicUrl, '/api/account/me', { ip: null })).status).toBe(401);
  });

  it('outside production a missing IP is not refused', async () => {
    expect((await failedSignIn(service.publicUrl, null)).status).toBe(401);
  });
});

describe('ipBucket groups exactly like better-auth', () => {
  it.each([
    ['203.0.113.5', '203.0.113.5'],
    ['::ffff:203.0.113.5', '203.0.113.5'],
    ['::FFFF:203.0.113.5', '203.0.113.5'],
    ['::ffff:cb00:7105', '203.0.113.5'],
    ['0:0:0:0:0:ffff:cb00:7105', '203.0.113.5'],
    ['::ffff:cb00:7106', '203.0.113.6'],
    ['2001:db8:1:2:3:4:5:6', '2001:0db8:0001:0002:0000:0000:0000:0000'],
    ['2001:DB8:1:2::9', '2001:0db8:0001:0002:0000:0000:0000:0000'],
    ['2001:db8::1', '2001:0db8:0000:0000:0000:0000:0000:0000'],
  ])('%s → %s', (ip, bucket) => {
    expect(ipBucket(ip)).toBe(bucket);
  });
  it.each(['::ffff:cb00:7107', '::ffff:203.0.113.8', '2001:db8:9:9::1', '203.0.113.9'])(
    "%s lands in the same bucket better-auth's router computes",
    async (ip) => {
      await ok(service.publicUrl, ip);
      expect(await rateLimitKeys(service)).toContain(`${ipBucket(ip)}|/ok`);
    }
  );
});

describe('edge header shapes (docs/cutover/edge-header-shapes.json): only X-Real-IP is the client', () => {
  it('the fixture covers both paths and at least one no-edge shape', () => {
    const viaCloudflare = EDGE.shapes.map((s) => (s.probe as { via_cloudflare?: boolean } | undefined)?.via_cloudflare);
    expect(viaCloudflare).toContain(true);
    expect(viaCloudflare).toContain(false);
    expect(EDGE.withoutTheEdge.length).toBeGreaterThan(0);
  });

  it('provisional shapes cannot ship as evidence: once rehearsal.md records a verdict, the fixture must be measured', () => {
    const rehearsal = readFileSync(resolve(DOCS_CUTOVER, 'rehearsal.md'), 'utf8');
    const verdict = /^\*\*Staging edge verdict:\*\* (.+)$/m.exec(rehearsal)?.[1];
    expect(verdict, 'rehearsal.md has its verdict line').toBeDefined();
    if (verdict !== '_pending_') expect(EDGE.source).not.toMatch(/not yet measured/);
  });

  it.each(EDGE.shapes.map((s) => [s.name, s] as const))(
    '%s: the bucket is the X-Real-IP client; cf-connecting-ip and x-forwarded-for are never a key',
    async (_name, shape) => {
      const prod = await startService({ production: true });
      try {
        const res = await ok(prod.publicUrl, null, shape.headers);
        expect(res.status).toBe(200);
        const keys = await rateLimitKeys(prod);
        // The X-Real-IP client, bucketed as better-auth buckets it (IPv6 by its /64).
        expect(keys).toEqual([`${ipBucket(shape.probe?.x_real_ip ?? '')}|/ok`]);
        for (const other of shape.never ?? []) expect(keys.some((k) => k.includes(other))).toBe(false);
      } finally {
        await prod.close();
      }
    }
  );

  it.each(EDGE.withoutTheEdge.map((s) => [s.name, s] as const))(
    '%s: the production 400, and no bucket',
    async (_name, shape) => {
      const prod = await startService({ production: true });
      try {
        const res = await ok(prod.publicUrl, null, shape.headers);
        expect(res.status).toBe(400);
        expect(await rateLimitKeys(prod)).toEqual([]);
      } finally {
        await prod.close();
      }
    }
  );
});
