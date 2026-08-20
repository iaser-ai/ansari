import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

// Spec 4: route-level authorization chain for /api/v2/admin/stats. Unlike
// admin-stats-endpoint.test.ts (which mocks requireAdmin), this exercises the
// REAL requireAdmin → is_admin flag path, mocking only the layer below it
// (authenticateRequest) and the stats queries. Proves is_admin=false → 403 and
// is_admin=true → 200 end-to-end.

const mockAuthenticate = vi.fn();
vi.mock('@/lib/auth/middleware', () => ({
  authenticateRequest: (...args: unknown[]) => mockAuthenticate(...args),
  createErrorResponse: (detail: string, status: number) =>
    NextResponse.json({ detail }, { status }),
}));

vi.mock('@/lib/db/stats', () => ({
  getSummaryStats: vi.fn().mockResolvedValue({
    total_users: 1,
    new_users_24h: 0,
    new_users_7d: 0,
    new_users_30d: 0,
    total_threads: 0,
    total_messages: 0,
    total_feedback: 0,
  }),
  getUsersPerDay: vi.fn().mockResolvedValue([]),
  getThreadsPerDay: vi.fn().mockResolvedValue([]),
  getMessagesPerDay: vi.fn().mockResolvedValue([]),
  getRecentMessages: vi.fn().mockResolvedValue([]),
  getFeedbackSummary: vi.fn().mockResolvedValue({ thumbs_up: 0, thumbs_down: 0, report: 0 }),
}));

// Real requireAdmin (NOT mocked) — that is the point of this test.
import { GET } from '../src/app/api/v2/admin/stats/route';

function makeUser(isAdmin: boolean) {
  return {
    id: '1',
    email: 'x@example.com',
    passwordHash: '',
    firstName: null,
    lastName: null,
    source: 'web',
    registeredVia: null,
    isAdmin,
    systemKey: null,
    sessionVersion: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function makeRequest(): NextRequest {
  return new NextRequest('http://localhost/api/v2/admin/stats', {
    headers: { Authorization: 'Bearer test-token' },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/v2/admin/stats — authorization chain (real requireAdmin)', () => {
  it('returns 403 when the authenticated user has is_admin=false', async () => {
    mockAuthenticate.mockResolvedValue({ user: makeUser(false) });
    const res = await GET(makeRequest());
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.detail).toBe('Admin access required');
  });

  it('returns 200 when the authenticated user has is_admin=true', async () => {
    mockAuthenticate.mockResolvedValue({ user: makeUser(true) });
    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.summary.total_users).toBe(1);
  });

  it('returns 401 when unauthenticated', async () => {
    mockAuthenticate.mockResolvedValue({
      error: NextResponse.json({ detail: 'Not authenticated' }, { status: 401 }),
    });
    const res = await GET(makeRequest());
    expect(res.status).toBe(401);
  });
});
