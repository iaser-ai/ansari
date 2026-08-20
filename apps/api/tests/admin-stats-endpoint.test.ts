import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

// Mock admin auth — must match import paths used in the route file
const mockRequireAdmin = vi.fn();
vi.mock('@/lib/auth/admin', () => ({
  requireAdmin: (...args: unknown[]) => mockRequireAdmin(...args),
}));

// Mock middleware for createErrorResponse
vi.mock('@/lib/auth/middleware', () => ({
  authenticateRequest: vi.fn(),
  createErrorResponse: (detail: string, status: number) =>
    NextResponse.json({ detail }, { status }),
}));

// Mock all stats query functions
const mockGetSummaryStats = vi.fn();
const mockGetUsersPerDay = vi.fn();
const mockGetThreadsPerDay = vi.fn();
const mockGetMessagesPerDay = vi.fn();
const mockGetRecentMessages = vi.fn();
const mockGetFeedbackSummary = vi.fn();

vi.mock('@/lib/db/stats', () => ({
  getSummaryStats: (...args: unknown[]) => mockGetSummaryStats(...args),
  getUsersPerDay: (...args: unknown[]) => mockGetUsersPerDay(...args),
  getThreadsPerDay: (...args: unknown[]) => mockGetThreadsPerDay(...args),
  getMessagesPerDay: (...args: unknown[]) => mockGetMessagesPerDay(...args),
  getRecentMessages: (...args: unknown[]) => mockGetRecentMessages(...args),
  getFeedbackSummary: (...args: unknown[]) => mockGetFeedbackSummary(...args),
}));

// Import the route handler after mocks
import { GET } from '../src/app/api/v2/admin/stats/route';

const adminUser = {
  id: '1',
  email: 'admin@example.com',
  passwordHash: '',
  firstName: null,
  lastName: null,
  source: 'web',
  createdAt: new Date(),
  updatedAt: new Date(),
};

function makeRequest(params?: Record<string, string>): NextRequest {
  const url = new URL('http://localhost/api/v2/admin/stats');
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }
  }
  return new NextRequest(url, {
    headers: { Authorization: 'Bearer test-token' },
  });
}

function setUpSuccessfulAuth() {
  mockRequireAdmin.mockResolvedValue({ user: adminUser });
}

function setUpDefaultStats() {
  mockGetSummaryStats.mockResolvedValue({
    total_users: 100,
    new_users_24h: 5,
    new_users_7d: 20,
    new_users_30d: 50,
    total_threads: 200,
    total_messages: 1000,
    total_feedback: 30,
  });
  mockGetUsersPerDay.mockResolvedValue([{ date: '2026-03-01', count: 3 }]);
  mockGetThreadsPerDay.mockResolvedValue([{ date: '2026-03-01', web: 2, legacy: 1 }]);
  mockGetMessagesPerDay.mockResolvedValue([{ date: '2026-03-01', user: 10, assistant: 8 }]);
  mockGetRecentMessages.mockResolvedValue([
    {
      id: 'msg-1',
      thread_id: 'thread-1',
      thread_name: 'Test Thread',
      role: 'user',
      content_preview: 'Hello world',
      agent_name: null,
      source: 'web',
      created_at: '2026-03-01T10:00:00.000Z',
    },
  ]);
  mockGetFeedbackSummary.mockResolvedValue({
    thumbs_up: 10,
    thumbs_down: 3,
    report: 0,
  });
}

describe('GET /api/v2/admin/stats', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 401 for unauthenticated requests', async () => {
    const errorResponse = NextResponse.json({ detail: 'Not authenticated' }, { status: 401 });
    mockRequireAdmin.mockResolvedValue({ error: errorResponse });

    const response = await GET(makeRequest());
    expect(response.status).toBe(401);
  });

  it('returns 403 for non-admin users', async () => {
    const errorResponse = NextResponse.json({ detail: 'Admin access required' }, { status: 403 });
    mockRequireAdmin.mockResolvedValue({ error: errorResponse });

    const response = await GET(makeRequest());
    expect(response.status).toBe(403);
  });

  it('returns full stats response for admin users', async () => {
    setUpSuccessfulAuth();
    setUpDefaultStats();

    const response = await GET(makeRequest());
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.summary.total_users).toBe(100);
    expect(body.summary.new_users_24h).toBe(5);
    expect(body.time_series.users_per_day).toHaveLength(1);
    expect(body.time_series.threads_per_day).toHaveLength(1);
    expect(body.time_series.messages_per_day).toHaveLength(1);
    expect(body.recent_messages).toHaveLength(1);
    expect(body.recent_messages[0].content_preview).toBe('Hello world');
    expect(body.feedback_summary.thumbs_up).toBe(10);
    expect(body.feedback_summary.report).toBe(0);
    expect(body.generated_at).toBeDefined();
  });

  it('uses default days=30 and limit=50 when no params provided', async () => {
    setUpSuccessfulAuth();
    setUpDefaultStats();

    await GET(makeRequest());

    expect(mockGetUsersPerDay).toHaveBeenCalledWith(30);
    expect(mockGetThreadsPerDay).toHaveBeenCalledWith(30);
    expect(mockGetMessagesPerDay).toHaveBeenCalledWith(30);
    expect(mockGetRecentMessages).toHaveBeenCalledWith(50);
  });

  it('respects custom days parameter', async () => {
    setUpSuccessfulAuth();
    setUpDefaultStats();

    await GET(makeRequest({ days: '7' }));

    expect(mockGetUsersPerDay).toHaveBeenCalledWith(7);
    expect(mockGetThreadsPerDay).toHaveBeenCalledWith(7);
    expect(mockGetMessagesPerDay).toHaveBeenCalledWith(7);
  });

  it('respects custom limit parameter', async () => {
    setUpSuccessfulAuth();
    setUpDefaultStats();

    await GET(makeRequest({ limit: '10' }));

    expect(mockGetRecentMessages).toHaveBeenCalledWith(10);
  });

  it('clamps days to max 365', async () => {
    setUpSuccessfulAuth();
    setUpDefaultStats();

    await GET(makeRequest({ days: '999' }));

    expect(mockGetUsersPerDay).toHaveBeenCalledWith(365);
  });

  it('clamps limit to max 200', async () => {
    setUpSuccessfulAuth();
    setUpDefaultStats();

    await GET(makeRequest({ limit: '500' }));

    expect(mockGetRecentMessages).toHaveBeenCalledWith(200);
  });

  it('clamps days to min 1', async () => {
    setUpSuccessfulAuth();
    setUpDefaultStats();

    await GET(makeRequest({ days: '0' }));

    expect(mockGetUsersPerDay).toHaveBeenCalledWith(1);
  });

  it('returns 400 for non-numeric days', async () => {
    setUpSuccessfulAuth();

    const response = await GET(makeRequest({ days: 'abc' }));
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.detail).toBe('Invalid days parameter');
  });

  it('returns 400 for non-numeric limit', async () => {
    setUpSuccessfulAuth();

    const response = await GET(makeRequest({ limit: 'xyz' }));
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.detail).toBe('Invalid limit parameter');
  });

  it('returns 400 for empty days value', async () => {
    setUpSuccessfulAuth();

    const response = await GET(makeRequest({ days: '' }));
    expect(response.status).toBe(400);
  });

  it('returns 500 when a query throws', async () => {
    setUpSuccessfulAuth();
    mockGetSummaryStats.mockRejectedValue(new Error('DB connection failed'));

    const response = await GET(makeRequest());
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.detail).toBe('Internal server error');
  });

  it('response matches spec shape (snake_case, nested structure)', async () => {
    setUpSuccessfulAuth();
    setUpDefaultStats();

    const response = await GET(makeRequest());
    const body = await response.json();

    // Verify top-level keys match spec
    expect(Object.keys(body).sort()).toEqual([
      'feedback_summary',
      'generated_at',
      'recent_messages',
      'summary',
      'time_series',
    ]);

    // Verify summary keys
    expect(Object.keys(body.summary).sort()).toEqual([
      'new_users_24h',
      'new_users_30d',
      'new_users_7d',
      'total_feedback',
      'total_messages',
      'total_threads',
      'total_users',
    ]);

    // Verify time_series keys
    expect(Object.keys(body.time_series).sort()).toEqual([
      'messages_per_day',
      'threads_per_day',
      'users_per_day',
    ]);

    // Verify recent_messages item keys
    expect(Object.keys(body.recent_messages[0]).sort()).toEqual([
      'agent_name',
      'content_preview',
      'created_at',
      'id',
      'role',
      'source',
      'thread_id',
      'thread_name',
    ]);

    // Verify feedback_summary keys
    expect(Object.keys(body.feedback_summary).sort()).toEqual([
      'report',
      'thumbs_down',
      'thumbs_up',
    ]);
  });
});
