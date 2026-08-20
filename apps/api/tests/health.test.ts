import { describe, it, expect, afterEach, vi } from 'vitest';

// The health route imports @/lib/db/index lazily and runs `SELECT 1`. We mock
// that module so the route never touches a real database or DATABASE_URL. The
// hoisted `h` lets each test choose the db behavior:
//   - h.execute        : the db.execute implementation (resolve / reject / hang)
//   - h.throwOnAccess  : if true, reading `db` throws — simulating the
//                        module-scope getPool() throw when DATABASE_URL is unset
const h = vi.hoisted(() => ({
  execute: (async () => [{ result: 1 }]) as () => Promise<unknown>,
  throwOnAccess: false,
}));

vi.mock('@/lib/db/index', () => ({
  get db() {
    if (h.throwOnAccess) {
      throw new Error('DATABASE_URL environment variable is not set');
    }
    return { execute: h.execute };
  },
  closeDb: async () => {},
}));

import { GET } from '../src/app/api/health/route';

afterEach(() => {
  vi.useRealTimers();
  h.execute = async () => [{ result: 1 }];
  h.throwOnAccess = false;
});

describe('GET /api/health', () => {
  it('returns 200 ok when the database responds', async () => {
    h.execute = async () => [{ result: 1 }];

    const response = await GET();
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.status).toBe('ok');
    expect(data.service).toBe('ansari-backend');
    // Shape unchanged: still an ISO timestamp.
    expect(new Date(data.timestamp).toISOString()).toBe(data.timestamp);
  });

  it('returns 503 error when the SELECT 1 query fails', async () => {
    h.execute = async () => {
      throw new Error('connect ECONNREFUSED 127.0.0.1:5432');
    };

    const response = await GET();
    const data = await response.json();

    expect(response.status).toBe(503);
    expect(data.status).toBe('error');
    expect(data.service).toBe('ansari-backend');
    expect(new Date(data.timestamp).toISOString()).toBe(data.timestamp);
    // Never leak the underlying DB error into the response body.
    expect(JSON.stringify(data)).not.toContain('ECONNREFUSED');
  });

  it('returns 503 (not 500) when DATABASE_URL is unset', async () => {
    // Simulate lib/db/index throwing at access time (module-scope getPool()).
    h.throwOnAccess = true;

    const response = await GET();
    const data = await response.json();

    expect(response.status).toBe(503);
    expect(data.status).toBe('error');
    expect(data.service).toBe('ansari-backend');
  });

  it('returns 503 when the query exceeds the 2000ms timeout', async () => {
    vi.useFakeTimers();
    // A query that never resolves — only the timeout can settle the race.
    h.execute = () => new Promise(() => {});

    const pending = GET();
    // Advance past the 2000ms cap; the timeout rejects and the route returns 503.
    await vi.advanceTimersByTimeAsync(2000);
    const response = await pending;
    const data = await response.json();

    expect(response.status).toBe(503);
    expect(data.status).toBe('error');
  });
});
