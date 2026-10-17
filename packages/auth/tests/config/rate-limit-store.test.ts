// The fixed-window store apps/auth's own limiters use (rate-limit-store.ts),
// and the retention rule that stops
// better-auth's pruner from deleting apps/auth's longer-window rows.
import type { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  consumeWindow,
  createAuth,
  keysSeenSince,
  peekWindow,
  schema,
  touchKey,
  type Auth,
  type Db,
} from '../../src/index';
import { LONGEST_WINDOW, RESET_REQUEST_PER_EMAIL } from '../../src/limits';
import { drizzleFor, migrate, setAuthEnv } from '../helpers/auth-db';
import { BASE, call } from '../helpers/http';

let client: PGlite;
let db: Db;
let auth: Auth;

beforeAll(async () => {
  setAuthEnv(BASE);
  client = await migrate();
  db = drizzleFor(client);
  auth = createAuth(db);
});

afterAll(async () => {
  await client?.close();
});

const RULE = { window: 60, max: 3 };

async function row(key: string) {
  const [r] = await db.select().from(schema.rateLimit).where(eq(schema.rateLimit.key, key));
  return r;
}

describe('consumeWindow: a fixed window anchored at its first request', () => {
  it('counts up from 1 and keeps the window start', async () => {
    const t0 = 1_000_000;
    expect((await consumeWindow(db, 'email:a|/x', RULE, t0)).count).toBe(1);
    expect((await consumeWindow(db, 'email:a|/x', RULE, t0 + 10_000)).count).toBe(2);
    const third = await consumeWindow(db, 'email:a|/x', RULE, t0 + 20_000);
    expect(third).toEqual({ count: 3, retryAfter: 40 });
    expect(Number((await row('email:a|/x'))?.lastRequest)).toBe(t0);
  });

  it('keeps counting past max without moving the window (no extension)', async () => {
    const t0 = 2_000_000;
    for (let i = 0; i < RULE.max; i++) await consumeWindow(db, 'email:b|/x', RULE, t0);
    const over = await consumeWindow(db, 'email:b|/x', RULE, t0 + 59_000);
    expect(over).toEqual({ count: RULE.max + 1, retryAfter: 1 });
  });

  it('restarts at 1 once the window has ended', async () => {
    const t0 = 3_000_000;
    for (let i = 0; i < 5; i++) await consumeWindow(db, 'email:c|/x', RULE, t0);
    expect((await consumeWindow(db, 'email:c|/x', RULE, t0 + 60_000)).count).toBe(1);
  });

  it('is atomic: concurrent requests each get a distinct count', async () => {
    const t0 = 4_000_000;
    const counts = await Promise.all(
      Array.from({ length: 10 }, () => consumeWindow(db, 'email:d|/x', RULE, t0))
    );
    expect(counts.map((c) => c.count).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });
});

describe('peekWindow and touchKey', () => {
  it('peeks without counting, and reads an ended window as empty', async () => {
    const t0 = 5_000_000;
    await consumeWindow(db, 'email:e|/x', RULE, t0);
    expect((await peekWindow(db, 'email:e|/x', RULE, t0 + 1000)).count).toBe(1);
    expect((await peekWindow(db, 'email:e|/x', RULE, t0 + 1000)).count).toBe(1);
    expect((await peekWindow(db, 'email:e|/x', RULE, t0 + 60_000)).count).toBe(0);
    expect((await peekWindow(db, 'email:none|/x', RULE, t0)).count).toBe(0);
  });

  it('counts distinct touched keys under a prefix since a time', async () => {
    const t0 = 6_000_000;
    await touchKey(db, 'walk:1111', t0);
    await touchKey(db, 'walk:2222', t0 + 5000);
    await touchKey(db, 'walk:2222', t0 + 6000);
    await touchKey(db, 'walk:3333', t0 - 10_000);
    const seen = await keysSeenSince(db, 'walk:', t0 - 1, 10);
    expect(seen.total).toBe(2);
    expect(seen.sample.sort()).toEqual(['walk:1111', 'walk:2222']);
  });
});

describe("better-auth's pruner keeps apps/auth rows for the longest window", () => {
  it('a 30-minute-old per-email reset row survives a prune; a 2-hour-old row does not', async () => {
    expect(LONGEST_WINDOW).toBe(RESET_REQUEST_PER_EMAIL.window);
    const now = Date.now();
    await db.insert(schema.rateLimit).values([
      { key: 'email:keep|/request-password-reset', count: 3, lastRequest: now - 30 * 60_000 },
      { key: 'email:gone|/request-password-reset', count: 3, lastRequest: now - 2 * 3_600_000 },
      // An expired router row: the next request from this IP resets it, which prunes.
      { key: '203.0.113.201|/ok', count: 5, lastRequest: now - 2 * 60_000 },
    ]);
    await call(auth, '/ok', { ip: '203.0.113.201' });
    expect(await row('email:gone|/request-password-reset')).toBeUndefined();
    expect(await row('email:keep|/request-password-reset')).toBeDefined();
  });
});
