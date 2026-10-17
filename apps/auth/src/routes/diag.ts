// The edge check's probe (plan P-4), removed by the contract PR. It tells the
// caller only what the edge says about the caller itself: the observed
// `X-Real-IP`; how many `X-Forwarded-For` entries arrived and whether the first
// is that same address (never the entries' values: via Cloudflare they are
// Cloudflare's and Railway's); the `CF-Connecting-IP` that arrived (Cloudflare's
// stamp of the caller, or whatever the caller sent itself); and whether the
// request came through Cloudflare. Telling a caller its own address is not a
// disclosure. These are the header shapes docs/cutover/edge-check.md records.
import type { Request, Response } from 'express';

export const DIAG_PATH = '/__diag/client-ip';

const header = (req: Request, name: string): string | null => {
  const value = req.headers[name];
  return typeof value === 'string' ? value : null;
};

export function clientIpDiag(req: Request, res: Response): void {
  const realIp = header(req, 'x-real-ip');
  const forwarded = (header(req, 'x-forwarded-for') ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  res.set('Cache-Control', 'no-store');
  res.status(200).json({
    x_real_ip: realIp,
    x_forwarded_for_entries: forwarded.length,
    x_forwarded_for_first_is_x_real_ip: realIp !== null && forwarded[0] === realIp.trim(),
    cf_connecting_ip: header(req, 'cf-connecting-ip'),
    via_cloudflare: header(req, 'cf-ray') !== null || /cloudflare/i.test(header(req, 'cdn-loop') ?? ''),
  });
}
