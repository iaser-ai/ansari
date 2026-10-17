import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

// Spec 300: route-level authorization chain for /api/v2/admin/stats. Unlike
// admin-stats-endpoint.test.ts (which mocks requireAdmin), this exercises
// the REAL requireAdmin → apps/auth role path, mocking only requireUser
// below it, the role call to apps/auth, and the stats queries. The legacy
// `is_admin` column no longer grants anything: the role comes from apps/auth.

const mockAuthenticate = vi.fn();
vi.mock('@/lib/auth/require-user', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/require-user')>()),
  requireUser: (...args: unknown[]) => mockAuthenticate(...args),
}));
vi.mock('@/lib/error-response', () => ({
  createErrorResponse: (detail: string, status: number) =>
    NextResponse.json({ detail }, { status }),
}));

const mockGetAuthRole = vi.fn();
vi.mock('@/lib/auth-service/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth-service/client')>()),
  getAuthAccount: (...args: unknown[]) => mockGetAuthRole(...args),
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
import { AuthServiceUnavailableError } from '@/lib/auth-service/client';
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
  it('returns 403 for role user, even with the legacy is_admin=true', async () => {
    mockAuthenticate.mockResolvedValue({ user: makeUser(true) });
    mockGetAuthRole.mockResolvedValue({ role: 'user', banned: false });
    const res = await GET(makeRequest());
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.detail).toBe('Admin access required');
    // Asked with the admin's own JWT (owner amendment 2026-10-17).
    expect(mockGetAuthRole).toHaveBeenCalledWith('1', 'test-token');
  });

  it('returns 200 for role admin, even with the legacy is_admin=false', async () => {
    mockAuthenticate.mockResolvedValue({ user: makeUser(false) });
    mockGetAuthRole.mockResolvedValue({ role: 'admin', banned: false });
    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.summary.total_users).toBe(1);
  });

  it('returns 503 when apps/auth cannot answer', async () => {
    mockAuthenticate.mockResolvedValue({ user: makeUser(true) });
    mockGetAuthRole.mockRejectedValue(new AuthServiceUnavailableError(null));
    vi.spyOn(console, 'warn').mockImplementationOnce(() => {});
    const res = await GET(makeRequest());
    expect(res.status).toBe(503);
  });

  it('returns 401 when unauthenticated, without asking apps/auth', async () => {
    mockAuthenticate.mockResolvedValue({
      error: NextResponse.json({ detail: 'Not authenticated' }, { status: 401 }),
    });
    const res = await GET(makeRequest());
    expect(res.status).toBe(401);
    expect(mockGetAuthRole).not.toHaveBeenCalled();
  });
});
