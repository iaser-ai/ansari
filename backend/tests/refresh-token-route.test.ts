import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

// Regression tests for issue #34 at the HTTP route layer: the refresh endpoint
// must rotate (not hard-delete) the old token, so concurrent refreshes with the
// same token all succeed; logout must still invalidate immediately.

const mockStoreToken = vi.fn();
const mockMarkTokenRotated = vi.fn();
const mockDeleteToken = vi.fn();

vi.mock('@/lib/db/users', () => ({
  storeToken: (...args: unknown[]) => mockStoreToken(...args),
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
import { POST as logout } from '../src/app/api/v2/users/logout/route';

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
  process.env.JWT_SECRET = 'test-secret-key-for-testing-purposes-only-32chars';
  mockValidateRefreshToken.mockResolvedValue({ user: testUser });
  mockGenerateToken.mockReturnValue('new-token');
  mockStoreToken.mockResolvedValue({ id: 'token-1' });
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

describe('POST /api/v2/users/logout (issue #34)', () => {
  it('still invalidates the token immediately', async () => {
    const req = new NextRequest('http://localhost/api/v2/users/logout', {
      method: 'POST',
      headers: { Authorization: 'Bearer at' },
    });

    const res = await logout(req);
    expect(res.status).toBe(200);
    expect(mockDeleteToken).toHaveBeenCalledWith('at');
  });
});
