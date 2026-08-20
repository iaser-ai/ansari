import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

// Spec 4: admin authorization is gated on the durable users.is_admin DB flag,
// NOT on the email being in an allowlist. Mock middleware to control the
// authenticated user; requireAdmin must consult only the flag.

vi.mock('@/lib/auth/middleware', () => ({
  authenticateRequest: vi.fn(),
  createErrorResponse: (detail: string, status: number) =>
    NextResponse.json({ detail }, { status }),
}));

import { requireAdmin } from '@/lib/auth/admin';
import { authenticateRequest } from '@/lib/auth/middleware';

const mockAuth = vi.mocked(authenticateRequest);

function makeRequest(): NextRequest {
  return new NextRequest('http://localhost/api/v2/admin/stats', {
    headers: { Authorization: 'Bearer test-token' },
  });
}

function makeUser(overrides: Record<string, unknown> = {}) {
  return {
    id: '1',
    email: 'user@example.com',
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
    ...overrides,
  };
}

describe('requireAdmin (durable is_admin flag)', () => {
  beforeEach(() => {
    mockAuth.mockReset();
  });

  it('returns 401 when not authenticated', async () => {
    const errorResponse = NextResponse.json({ detail: 'Not authenticated' }, { status: 401 });
    mockAuth.mockResolvedValue({ error: errorResponse });

    const result = await requireAdmin(makeRequest());
    expect('error' in result).toBe(true);
    if ('error' in result) expect(result.error.status).toBe(401);
  });

  it('returns 403 for an authenticated user with is_admin=false', async () => {
    mockAuth.mockResolvedValue({ user: makeUser({ isAdmin: false }) });

    const result = await requireAdmin(makeRequest());
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error.status).toBe(403);
      const body = await result.error.json();
      expect(body.detail).toBe('Admin access required');
    }
  });

  it('DENIES a user whose email looks like an admin but has is_admin=false', async () => {
    // The whole point of spec 4: an allowlisted email string is not enough.
    mockAuth.mockResolvedValue({
      user: makeUser({ email: 'admin@ansari.chat', isAdmin: false }),
    });

    const result = await requireAdmin(makeRequest());
    expect('error' in result).toBe(true);
    if ('error' in result) expect(result.error.status).toBe(403);
  });

  it('returns the user when is_admin=true', async () => {
    const adminUser = makeUser({ email: 'someone@example.com', isAdmin: true });
    mockAuth.mockResolvedValue({ user: adminUser });

    const result = await requireAdmin(makeRequest());
    expect('error' in result).toBe(false);
    if (!('error' in result)) expect(result.user.isAdmin).toBe(true);
  });
});
