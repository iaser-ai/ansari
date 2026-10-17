import { NextRequest, NextResponse } from 'next/server';

// The edge check's probe (spec 300; plan P-4), removed by the contract PR. It
// tells the caller only what the edge says about the caller itself: the
// observed `X-Real-IP`; how many `X-Forwarded-For` entries arrived and whether
// the first is that same address (never the entries' values: via Cloudflare
// they are Cloudflare's and Railway's); the `CF-Connecting-IP` that arrived
// (Cloudflare's stamp of the caller, or whatever the caller sent itself); and
// whether the request came through Cloudflare. Telling a caller its own address
// is not a disclosure. These are the header shapes docs/cutover/edge-check.md
// records.
//
// The folder is `%5Fdiag` because Next.js treats a `_`-prefixed folder as
// private and never routes it; the URL is `/api/v2/_diag/client-ip`.

export const dynamic = 'force-dynamic';

export function GET(request: NextRequest) {
  const realIp = request.headers.get('x-real-ip');
  const forwarded = (request.headers.get('x-forwarded-for') ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return NextResponse.json(
    {
      x_real_ip: realIp,
      x_forwarded_for_entries: forwarded.length,
      x_forwarded_for_first_is_x_real_ip: realIp !== null && forwarded[0] === realIp.trim(),
      cf_connecting_ip: request.headers.get('cf-connecting-ip'),
      via_cloudflare:
        request.headers.get('cf-ray') !== null || /cloudflare/i.test(request.headers.get('cdn-loop') ?? ''),
    },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}
