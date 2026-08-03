import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// Phase 1 (config centralization): regression guard proving authenticateRequest /
// validateRefreshToken verify tokens with `config.auth.jwtSecret` (not a direct
// process.env read). If a future edit reverts middleware to process.env.JWT_SECRET,
// the "different secret" cases here would start passing and these tests would fail.

const CONFIG_SECRET = 'middleware-config-secret-at-least-32-characters';
const OTHER_SECRET = 'a-totally-different-secret-also-32-plus-characters';

// NOTE: the vi.mock factory is hoisted above these consts, so the secret is
// inlined here as a literal. It MUST stay equal to CONFIG_SECRET above.
vi.mock('@/lib/config', () => ({
  config: {
    auth: {
      jwtSecret: 'middleware-config-secret-at-least-32-characters',
      accessTokenExpiryHours: 2,
      refreshTokenExpiryHours: 2160,
    },
  },
}));

// Mock the DB lookups so no real db/index (and its config load) is pulled in.
const mockFindToken = vi.fn();
const mockLookupRefreshToken = vi.fn();
vi.mock('@/lib/db/users', () => ({
  findToken: (...args: unknown[]) => mockFindToken(...args),
  lookupRefreshToken: (...args: unknown[]) => mockLookupRefreshToken(...args),
}));

// Import after mocks. jwt.ts takes the secret as a parameter (no config import),
// so it is used unmocked to sign real tokens.
import { authenticateRequest, validateRefreshToken } from '@/lib/auth/middleware';
import { generateToken } from '@/lib/auth/jwt';

const testUser = {
  id: 'user-1',
  email: 'test@example.com',
  passwordHash: 'x',
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

function requestWithBearer(token: string): NextRequest {
  return new NextRequest('http://localhost/api/v2/protected', {
    headers: { Authorization: `Bearer ${token}` },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('authenticateRequest uses config.auth.jwtSecret', () => {
  it('accepts an access token signed with the config secret', async () => {
    mockFindToken.mockResolvedValue({ user: testUser });
    const token = generateToken(testUser.id, 'access', 2, CONFIG_SECRET, 0);

    const result = await authenticateRequest(requestWithBearer(token));

    expect('user' in result).toBe(true);
    if ('user' in result) expect(result.user.id).toBe('user-1');
    expect(mockFindToken).toHaveBeenCalledWith(token);
  });

  it('rejects an access token signed with a different secret (signature checked with config secret)', async () => {
    const token = generateToken(testUser.id, 'access', 2, OTHER_SECRET, 0);

    const result = await authenticateRequest(requestWithBearer(token));

    expect('error' in result).toBe(true);
    // Signature verification fails before the DB is consulted.
    expect(mockFindToken).not.toHaveBeenCalled();
  });

  it('rejects an access token whose session_version is stale (issued before a reset)', async () => {
    // User's current version is 1; the token was issued at version 0 (pre-reset).
    mockFindToken.mockResolvedValue({ user: { ...testUser, sessionVersion: 1 } });
    const token = generateToken(testUser.id, 'access', 2, CONFIG_SECRET, 0);

    const result = await authenticateRequest(requestWithBearer(token));

    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error.status).toBe(401);
      const body = await result.error.json();
      expect(body.detail).toBe('Session no longer valid');
    }
  });
});

describe('validateRefreshToken uses config.auth.jwtSecret', () => {
  it('accepts a refresh token signed with the config secret', async () => {
    mockLookupRefreshToken.mockResolvedValue({ status: 'valid', user: testUser });
    const token = generateToken(testUser.id, 'refresh', 2160, CONFIG_SECRET, 0);

    const result = await validateRefreshToken(token);

    expect('user' in result).toBe(true);
    if ('user' in result) expect(result.user.id).toBe('user-1');
  });

  it('rejects a refresh token signed with a different secret', async () => {
    const token = generateToken(testUser.id, 'refresh', 2160, OTHER_SECRET, 0);

    const result = await validateRefreshToken(token);

    expect('error' in result).toBe(true);
    expect(mockLookupRefreshToken).not.toHaveBeenCalled();
  });

  it('flags a reuse (with the user id) when the lookup reports a spent token', async () => {
    mockLookupRefreshToken.mockResolvedValue({ status: 'reuse', userId: 'user-1' });
    const token = generateToken(testUser.id, 'refresh', 2160, CONFIG_SECRET, 0);

    const result = await validateRefreshToken(token);

    expect('reuse' in result).toBe(true);
    // The user id is carried through so the caller can log which account was replayed.
    if ('reuse' in result) expect(result.userId).toBe('user-1');
  });

  it('rejects a refresh token whose session_version is stale', async () => {
    mockLookupRefreshToken.mockResolvedValue({ status: 'valid', user: { ...testUser, sessionVersion: 1 } });
    const token = generateToken(testUser.id, 'refresh', 2160, CONFIG_SECRET, 0);

    const result = await validateRefreshToken(token);

    expect('error' in result).toBe(true);
  });
});
