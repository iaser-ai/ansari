import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

// Spec 4: logout is a full, all-device revocation. The route resolves the user
// from the access token (via authenticateRequest) and deletes ALL of that user's
// tokens, so a logged-out refresh token can no longer mint access tokens. The
// 401 auth-failure contract (no/invalid token) is preserved by delegating to
// authenticateRequest.

const mockAuthenticate = vi.fn();
vi.mock('@/lib/auth/middleware', () => ({
  authenticateRequest: (...args: unknown[]) => mockAuthenticate(...args),
  createErrorResponse: (detail: string, status: number) =>
    NextResponse.json({ detail }, { status }),
}));

const mockDeleteUserTokens = vi.fn();
vi.mock('@/lib/db/users', () => ({
  deleteUserTokens: (...args: unknown[]) => mockDeleteUserTokens(...args),
}));

import { POST as logout } from '../src/app/api/v2/users/logout/route';

const testUser = {
  id: 'user-123',
  email: 'test@example.com',
  passwordHash: '',
  firstName: null,
  lastName: null,
  source: 'web',
  registeredVia: null,
  isAdmin: false,
  systemKey: null,
  sessionVersion: 0,
  createdAt: new Date(),
  updatedAt: new Date(),
};

function makeRequest(auth?: string): NextRequest {
  return new NextRequest('http://localhost/api/v2/users/logout', {
    method: 'POST',
    headers: auth ? { Authorization: auth } : {},
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockDeleteUserTokens.mockResolvedValue(3);
});

describe('POST /api/v2/users/logout', () => {
  it('revokes ALL of the user\'s tokens on a valid access token (full logout)', async () => {
    mockAuthenticate.mockResolvedValue({ user: testUser });

    const res = await logout(makeRequest('Bearer valid-access-token'));

    expect(res.status).toBe(200);
    expect(mockDeleteUserTokens).toHaveBeenCalledWith('user-123');
    // Full logout, not a single-token delete.
    expect(mockDeleteUserTokens).toHaveBeenCalledTimes(1);
  });

  it('returns 401 and revokes nothing when no token is presented', async () => {
    mockAuthenticate.mockResolvedValue({
      error: NextResponse.json({ detail: 'Not authenticated' }, { status: 401 }),
    });

    const res = await logout(makeRequest());
    expect(res.status).toBe(401);
    expect(mockDeleteUserTokens).not.toHaveBeenCalled();
  });

  it('returns 401 and revokes nothing for an invalid/unverifiable token', async () => {
    mockAuthenticate.mockResolvedValue({
      error: NextResponse.json({ detail: 'Invalid or expired token' }, { status: 401 }),
    });

    const res = await logout(makeRequest('Bearer garbage'));
    expect(res.status).toBe(401);
    expect(mockDeleteUserTokens).not.toHaveBeenCalled();
  });
});
