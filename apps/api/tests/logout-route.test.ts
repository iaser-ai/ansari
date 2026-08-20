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
const mockBumpSessionVersion = vi.fn();
vi.mock('@/lib/db/users', () => ({
  deleteUserTokens: (...args: unknown[]) => mockDeleteUserTokens(...args),
  bumpSessionVersion: (...args: unknown[]) => mockBumpSessionVersion(...args),
}));

// Logout runs its revocation in a db.transaction; run the callback with a dummy tx.
// This fake CANNOT roll back — real transaction/rollback coverage for this route
// lives in logout-route-pglite.test.ts (issue #18).
vi.mock('@/lib/db/index', () => ({
  db: { transaction: async (cb: (tx: unknown) => unknown) => cb({}) },
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
  mockBumpSessionVersion.mockResolvedValue(undefined);
});

describe('POST /api/v2/users/logout', () => {
  it('revokes ALL tokens AND bumps session_version on a valid access token (full logout)', async () => {
    mockAuthenticate.mockResolvedValue({ user: testUser });

    const res = await logout(makeRequest('Bearer valid-access-token'));

    expect(res.status).toBe(200);
    // Full logout, not a single-token delete.
    expect(mockDeleteUserTokens).toHaveBeenCalledWith('user-123', undefined, expect.anything());
    // Version bump closes the logout-vs-refresh race.
    expect(mockBumpSessionVersion).toHaveBeenCalledWith('user-123', expect.anything());
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
