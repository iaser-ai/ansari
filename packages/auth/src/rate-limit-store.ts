// Fixed-window counters on `auth.rate_limit`, for apps/auth's own limiters
// (the per-email reset cap, the reset per-IP cap, the `email`-mode fallback)
// beside better-auth's router rows. Every instance shares one budget because
// every step is one atomic statement on the shared table.
//
// Rows written here use `last_request` as the START of the current window, so a
// window is anchored at its first request and never slides. Their keys carry a
// prefix (`email:`, `ip:`, `ip-burst:`, `global|`, `walk:`, `alert|`) that better-auth's own
// keys (`<ip>|<path>`) never start with.
import { and, gt, like, sql } from 'drizzle-orm';

import type { Db } from './db';
import type { LimitRule } from './limits';
import { rateLimit } from './schema';

export type WindowState = {
  /** Requests counted in the current window, this one included. */
  count: number;
  /** Seconds until the window ends. */
  retryAfter: number;
};

function retryAfter(windowStart: number, rule: LimitRule, now: number): number {
  return Math.max(1, Math.ceil((windowStart + rule.window * 1000 - now) / 1000));
}

/**
 * Count one request against `key` and return the window's count. A window
 * that has ended restarts at 1. The caller compares `count` with `rule.max`.
 */
export async function consumeWindow(
  db: Db,
  key: string,
  rule: LimitRule,
  now = Date.now()
): Promise<WindowState> {
  const windowMs = rule.window * 1000;
  const result = await db.execute(sql`
    insert into auth.rate_limit (key, count, last_request)
    values (${key}, 1, ${now})
    on conflict (key) do update set
      count = case
        when ${now} - auth.rate_limit.last_request >= ${windowMs} then 1
        else auth.rate_limit.count + 1
      end,
      last_request = case
        when ${now} - auth.rate_limit.last_request >= ${windowMs} then ${now}
        else auth.rate_limit.last_request
      end
    returning count, last_request
  `);
  const row = rowsOf<{ count: number | string; last_request: number | string }>(result)[0];
  if (!row) throw new Error('rate_limit upsert returned no row');
  return { count: Number(row.count), retryAfter: retryAfter(Number(row.last_request), rule, now) };
}

/** The current window's count for `key`, without counting a request. */
export async function peekWindow(
  db: Db,
  key: string,
  rule: LimitRule,
  now = Date.now()
): Promise<WindowState> {
  const [row] = await db
    .select({ count: rateLimit.count, lastRequest: rateLimit.lastRequest })
    .from(rateLimit)
    .where(sql`${rateLimit.key} = ${key}`);
  if (!row || now - Number(row.lastRequest) >= rule.window * 1000) {
    return { count: 0, retryAfter: 0 };
  }
  return { count: row.count, retryAfter: retryAfter(Number(row.lastRequest), rule, now) };
}

/** Mark `key` as seen at `now` (a presence row, for distinct counts). */
export async function touchKey(db: Db, key: string, now = Date.now()): Promise<void> {
  await db.execute(sql`
    insert into auth.rate_limit (key, count, last_request)
    values (${key}, 1, ${now})
    on conflict (key) do update set last_request = ${now}
  `);
}

/** Keys under `prefix` seen after `since` (ms epoch), at most `limit`. */
export async function keysSeenSince(
  db: Db,
  prefix: string,
  since: number,
  limit: number
): Promise<{ total: number; sample: string[] }> {
  const where = and(like(rateLimit.key, `${prefix}%`), gt(rateLimit.lastRequest, since));
  const [counted] = await db
    .select({ total: sql<number>`count(*)` })
    .from(rateLimit)
    .where(where);
  const sample = await db.select({ key: rateLimit.key }).from(rateLimit).where(where).limit(limit);
  return { total: Number(counted?.total ?? 0), sample: sample.map((r) => r.key) };
}

/** node-postgres returns `{rows}`; pglite returns `{rows}` too, typed differently. */
function rowsOf<T>(result: unknown): T[] {
  const rows = (result as { rows?: T[] }).rows;
  return Array.isArray(rows) ? rows : [];
}
