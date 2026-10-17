import { describe, it, expect } from 'vitest';
import { NextRequest } from 'next/server';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GET } from '../../src/app/api/v2/%5Fdiag/client-ip/route';

/**
 * The P-4 edge probe (removed by the contract PR): the caller's own observed
 * X-Real-IP, the X-Forwarded-For entry count and whether the first entry is that
 * address (never the values), the CF-Connecting-IP that arrived, and whether the
 * request came through Cloudflare.
 */
const EDGE_SHAPES = (
  JSON.parse(
    readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../../../docs/cutover/edge-header-shapes.json'), 'utf8')
  ) as { shapes: { name: string; headers: Record<string, string>; probe: Record<string, unknown> }[] }
).shapes;
const probe = (headers: Record<string, string> = {}) =>
  GET(new NextRequest('http://localhost/api/v2/_diag/client-ip', { headers }));
describe('GET /api/v2/_diag/client-ip', () => {
  it('echoes the observed x-real-ip and counts x-forwarded-for entries without values', async () => {
    const res = GET(
      new NextRequest('http://localhost/api/v2/_diag/client-ip', {
        headers: { 'x-real-ip': '203.0.113.7', 'x-forwarded-for': '10.9.8.7, 198.51.100.4' },
      })
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({
      x_real_ip: '203.0.113.7',
      x_forwarded_for_entries: 2,
      x_forwarded_for_first_is_x_real_ip: false,
      cf_connecting_ip: null,
      via_cloudflare: false,
    });
    expect(text).not.toContain('10.9.8.7');
    expect(text).not.toContain('198.51.100.4');
  });

  it('reports absent headers as null and zero', async () => {
    const res = GET(new NextRequest('http://localhost/api/v2/_diag/client-ip'));
    expect(await res.json()).toEqual({
      x_real_ip: null,
      x_forwarded_for_entries: 0,
      x_forwarded_for_first_is_x_real_ip: false,
      cf_connecting_ip: null,
      via_cloudflare: false,
    });
  });

  it.each(EDGE_SHAPES.map((s) => [s.name, s] as const))(
    'records the shape "%s": the fixture\'s probe output, and no X-Forwarded-For value but the caller\'s',
    async (_name, shape) => {
      const text = await probe(shape.headers).text();
      expect(JSON.parse(text)).toEqual(shape.probe);
      for (const entry of (shape.headers['x-forwarded-for'] ?? '').split(',').map((e) => e.trim())) {
        if (entry && entry !== shape.headers['x-real-ip']) expect(text).not.toContain(entry);
      }
    }
  );
});
