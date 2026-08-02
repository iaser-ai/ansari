import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

// Phase 2 (token consolidation): the login route issues tokens via the shared
// issueTokenPair helper. This proves login calls it and preserves its response
// contract ({ status:'success', access_token, refresh_token, token_type, names }).

const mockFindUserByEmail = vi.fn();
const mockIssueTokenPair = vi.fn();

vi.mock('@/lib/db/users', () => ({
  findUserByEmail: (...args: unknown[]) => mockFindUserByEmail(...args),
  issueTokenPair: (...args: unknown[]) => mockIssueTokenPair(...args),
}));

const mockVerifyPassword = vi.fn();
vi.mock('@/lib/auth/password', () => ({
  verifyPassword: (...args: unknown[]) => mockVerifyPassword(...args),
}));

vi.mock('@/lib/auth/middleware', () => ({
  createErrorResponse: (detail: string, status: number) =>
    NextResponse.json({ detail }, { status }),
}));

import { POST as login } from '../src/app/api/v2/users/login/route';

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

function makeLoginRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/v2/users/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockIssueTokenPair.mockResolvedValue({
    accessToken: 'access-abc',
    refreshToken: 'refresh-xyz',
  });
});

describe('POST /api/v2/users/login', () => {
  it('issues a token pair and returns the Ansari response contract on valid credentials', async () => {
    mockFindUserByEmail.mockResolvedValue(testUser);
    mockVerifyPassword.mockResolvedValue(true);

    const res = await login(makeLoginRequest({ email: 'test@example.com', password: 'pw' }));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body).toMatchObject({
      status: 'success',
      access_token: 'access-abc',
      refresh_token: 'refresh-xyz',
      token_type: 'bearer',
      first_name: 'Test',
      last_name: 'User',
    });
    expect(mockIssueTokenPair).toHaveBeenCalledWith(testUser.id, 0);
  });

  it('returns 401 and does not issue tokens for an unknown user', async () => {
    mockFindUserByEmail.mockResolvedValue(null);

    const res = await login(makeLoginRequest({ email: 'nobody@example.com', password: 'pw' }));
    expect(res.status).toBe(401);
    expect(mockIssueTokenPair).not.toHaveBeenCalled();
  });

  it('returns 401 and does not issue tokens for a wrong password', async () => {
    mockFindUserByEmail.mockResolvedValue(testUser);
    mockVerifyPassword.mockResolvedValue(false);

    const res = await login(makeLoginRequest({ email: 'test@example.com', password: 'wrong' }));
    expect(res.status).toBe(401);
    expect(mockIssueTokenPair).not.toHaveBeenCalled();
  });
});
