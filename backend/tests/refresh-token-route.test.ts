import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

// Regression tests for issue #34 at the HTTP route layer: the refresh endpoint
// must rotate (not hard-delete) the old token, so concurrent refreshes with the
// same token all succeed.

const mockIssueTokenPair = vi.fn();
const mockMarkTokenRotated = vi.fn();
const mockDeleteToken = vi.fn();
const mockLookupRefreshToken = vi.fn();

vi.mock('@/lib/db/users', () => ({
  issueTokenPair: (...args: unknown[]) => mockIssueTokenPair(...args),
  markTokenRotated: (...args: unknown[]) => mockMarkTokenRotated(...args),
  deleteToken: (...args: unknown[]) => mockDeleteToken(...args),
  lookupRefreshToken: (...args: unknown[]) => mockLookupRefreshToken(...args),
  maybeSweepExpiredTokens: () => undefined,
}));

const mockGenerateToken = vi.fn();
const mockValidateRefreshToken = vi.fn();

vi.mock('@/lib/auth/jwt', () => ({
  generateToken: (...args: unknown[]) => mockGenerateToken(...args),
  extractBearerToken: (header: string | null) =>
    header?.startsWith('Bearer ') ? header.slice(7) : null,
  hashToken: (t: string) => `hashed-${t}`,
}));

vi.mock('@/lib/auth/middleware', () => ({
  validateRefreshToken: (...args: unknown[]) => mockValidateRefreshToken(...args),
  createErrorResponse: (detail: string, status: number) =>
    NextResponse.json({ detail }, { status }),
}));

// The route rotates + issues atomically via db.transaction. Run the callback
// with a dummy tx (the inner helpers are mocked, so they ignore it).
vi.mock('@/lib/db/index', () => ({
  db: { transaction: async (cb: (tx: unknown) => unknown) => cb({}) },
}));

import { POST as refresh } from '../src/app/api/v2/users/refresh_token/route';

const testUser = {
  id: 'user-123',
  email: 'test@example.com',
  passwordHash: '$2b$12$hashedpassword',
  firstName: 'Test',
  lastName: 'User',
  source: 'web',
  registeredVia: null,
  isAdmin: false,
  systemKey: null,
  sessionVersion: 0,
  createdAt: new Date(),
  updatedAt: new Date(),
};

function makeRefreshRequest(refreshToken: string): NextRequest {
  return new NextRequest('http://localhost/api/v2/users/refresh_token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh_token: refreshToken }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockValidateRefreshToken.mockResolvedValue({ user: testUser });
  mockLookupRefreshToken.mockResolvedValue({ status: 'valid', user: testUser });
  mockIssueTokenPair.mockResolvedValue({
    accessToken: 'new-access-token',
    refreshToken: 'new-refresh-token',
  });
  mockMarkTokenRotated.mockResolvedValue(true);
  mockDeleteToken.mockResolvedValue(true);
});

describe('POST /api/v2/users/refresh_token (issue #34)', () => {
  it('two concurrent refreshes with the same token both succeed', async () => {
    const [res1, res2] = await Promise.all([
      refresh(makeRefreshRequest('rt')),
      refresh(makeRefreshRequest('rt')),
    ]);

    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);

    const body1 = await res1.json();
    const body2 = await res2.json();
    expect(body1.access_token).toBeDefined();
    expect(body1.refresh_token).toBeDefined();
    expect(body2.access_token).toBeDefined();
    expect(body2.refresh_token).toBeDefined();
  });

  it('rotates the old refresh token instead of hard-deleting it', async () => {
    await refresh(makeRefreshRequest('rt'));
    expect(mockMarkTokenRotated).toHaveBeenCalledWith('rt', expect.anything());
    expect(mockDeleteToken).not.toHaveBeenCalled();
  });

  it('rejects a detected refresh-token reuse with a generic 401', async () => {
    mockValidateRefreshToken.mockResolvedValueOnce({ reuse: true });
    const res = await refresh(makeRefreshRequest('spent-rt'));
    expect(res.status).toBe(401);
    expect(mockIssueTokenPair).not.toHaveBeenCalled();
  });

  it('does NOT issue when the token was revoked between validation and the transaction', async () => {
    // Initial validation passed, but the in-transaction recheck finds it gone
    // (a concurrent logout/reset deleted it).
    mockLookupRefreshToken.mockResolvedValueOnce({ status: 'not_found' });
    const res = await refresh(makeRefreshRequest('rt'));
    expect(res.status).toBe(401);
    expect(mockIssueTokenPair).not.toHaveBeenCalled();
  });

  it('logs only sanitized metadata (no raw driver error) when the DB throws (issue #19)', async () => {
    const driverError = new Error(
      'canceling statement: params = (raw-refresh-token-material)'
    ) as Error & { code: string };
    driverError.code = '57014';
    mockValidateRefreshToken.mockRejectedValueOnce(driverError);
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await refresh(makeRefreshRequest('rt'));

    expect(res.status).toBe(500);
    expect((await res.json()).detail).toBe('Token refresh failed');
    // Only {name, code} may reach the logs — never message/query/params.
    const logged = JSON.stringify(consoleSpy.mock.calls);
    expect(logged).toContain('57014');
    expect(logged).not.toContain('raw-refresh-token-material');
    expect(logged).not.toContain('canceling statement');
    consoleSpy.mockRestore();
  });
});
