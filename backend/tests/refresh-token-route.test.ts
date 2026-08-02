import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

// Regression tests for issue #34 at the HTTP route layer: the refresh endpoint
// must rotate (not hard-delete) the old token, so concurrent refreshes with the
// same token all succeed.

const mockIssueTokenPair = vi.fn();
const mockMarkTokenRotated = vi.fn();
const mockDeleteToken = vi.fn();

vi.mock('@/lib/db/users', () => ({
  issueTokenPair: (...args: unknown[]) => mockIssueTokenPair(...args),
  markTokenRotated: (...args: unknown[]) => mockMarkTokenRotated(...args),
  deleteToken: (...args: unknown[]) => mockDeleteToken(...args),
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

import { POST as refresh } from '../src/app/api/v2/users/refresh_token/route';

const testUser = {
  id: 'user-123',
  email: 'test@example.com',
  passwordHash: '$2b$12$hashedpassword',
  firstName: 'Test',
  lastName: 'User',
  source: 'web',
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
    expect(mockMarkTokenRotated).toHaveBeenCalledWith('rt');
    expect(mockDeleteToken).not.toHaveBeenCalled();
  });
});
