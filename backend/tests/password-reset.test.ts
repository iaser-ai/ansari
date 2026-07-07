import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

// Mock database operations
const mockFindUserByEmail = vi.fn();
const mockStoreToken = vi.fn();
const mockDeleteUserTokens = vi.fn();
const mockFindToken = vi.fn();
const mockUpdateUser = vi.fn();

vi.mock('@/lib/db/users', () => ({
  findUserByEmail: (...args: unknown[]) => mockFindUserByEmail(...args),
  storeToken: (...args: unknown[]) => mockStoreToken(...args),
  deleteUserTokens: (...args: unknown[]) => mockDeleteUserTokens(...args),
  findToken: (...args: unknown[]) => mockFindToken(...args),
  updateUser: (...args: unknown[]) => mockUpdateUser(...args),
}));

// Mock JWT
const mockGenerateToken = vi.fn();
const mockVerifyToken = vi.fn();

vi.mock('@/lib/auth/jwt', () => ({
  generateToken: (...args: unknown[]) => mockGenerateToken(...args),
  verifyToken: (...args: unknown[]) => mockVerifyToken(...args),
  hashToken: (t: string) => `hashed-${t}`,
}));

// Mock password utilities
const mockHashPassword = vi.fn();
const mockCheckPasswordStrength = vi.fn();

vi.mock('@/lib/auth/password', () => ({
  hashPassword: (...args: unknown[]) => mockHashPassword(...args),
  checkPasswordStrength: (...args: unknown[]) => mockCheckPasswordStrength(...args),
}));

// Mock email
const mockSendPasswordResetEmail = vi.fn();

vi.mock('@/lib/email', () => ({
  sendPasswordResetEmail: (...args: unknown[]) => mockSendPasswordResetEmail(...args),
}));

// Mock middleware
vi.mock('@/lib/auth/middleware', () => ({
  createErrorResponse: (detail: string, status: number) =>
    NextResponse.json({ detail }, { status }),
}));

// Import route handlers after mocks
import { POST as requestPasswordReset } from '../src/app/api/v2/request_password_reset/route';
import { POST as resetPassword } from '../src/app/api/v2/reset_password/route';

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

function makePostRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/v2/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.JWT_SECRET = 'test-secret-key-for-testing-purposes-only-32chars';
  mockSendPasswordResetEmail.mockResolvedValue({ success: true });
  mockStoreToken.mockResolvedValue({ id: 'token-1' });
  mockDeleteUserTokens.mockResolvedValue(1);
});

describe('POST /api/v2/request_password_reset', () => {
  it('returns success for existing email and sends email', async () => {
    mockFindUserByEmail.mockResolvedValue(testUser);
    mockGenerateToken.mockReturnValue('mock-reset-token');

    const request = makePostRequest({ email: 'test@example.com' });
    const response = await requestPasswordReset(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.status).toBe('success');
    expect(mockFindUserByEmail).toHaveBeenCalledWith('test@example.com');
    expect(mockDeleteUserTokens).toHaveBeenCalledWith('user-123', 'reset');
    expect(mockGenerateToken).toHaveBeenCalledWith('user-123', 'reset', 1, expect.any(String));
    expect(mockStoreToken).toHaveBeenCalledWith({
      userId: 'user-123',
      token: 'mock-reset-token',
      tokenType: 'reset',
      expiresAt: expect.any(Date),
    });
    expect(mockSendPasswordResetEmail).toHaveBeenCalledWith('test@example.com', 'mock-reset-token');
  });

  it('returns success for nonexistent email without sending email', async () => {
    mockFindUserByEmail.mockResolvedValue(undefined);

    const request = makePostRequest({ email: 'nobody@example.com' });
    const response = await requestPasswordReset(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.status).toBe('success');
    expect(mockFindUserByEmail).toHaveBeenCalledWith('nobody@example.com');
    expect(mockGenerateToken).not.toHaveBeenCalled();
    expect(mockSendPasswordResetEmail).not.toHaveBeenCalled();
  });

  it('returns 422 for invalid email format', async () => {
    const request = makePostRequest({ email: 'not-an-email' });
    const response = await requestPasswordReset(request);
    const data = await response.json();

    expect(response.status).toBe(422);
    expect(data.detail).toBeDefined();
  });

  it('returns 422 for missing email field', async () => {
    const request = makePostRequest({});
    const response = await requestPasswordReset(request);
    const data = await response.json();

    expect(response.status).toBe(422);
    expect(data.detail).toBeDefined();
  });

  it('deletes previous reset tokens before creating new one', async () => {
    mockFindUserByEmail.mockResolvedValue(testUser);
    mockGenerateToken.mockReturnValue('new-token');

    const request = makePostRequest({ email: 'test@example.com' });
    await requestPasswordReset(request);

    // Verify deleteUserTokens was called before storeToken
    const deleteCall = mockDeleteUserTokens.mock.invocationCallOrder[0];
    const storeCall = mockStoreToken.mock.invocationCallOrder[0];
    expect(deleteCall).toBeLessThan(storeCall);
    expect(mockDeleteUserTokens).toHaveBeenCalledWith('user-123', 'reset');
  });

  it('deletes previous reset tokens on consecutive requests for same email', async () => {
    mockFindUserByEmail.mockResolvedValue(testUser);
    mockGenerateToken.mockReturnValueOnce('first-token').mockReturnValueOnce('second-token');

    // First request
    await requestPasswordReset(makePostRequest({ email: 'test@example.com' }));
    expect(mockDeleteUserTokens).toHaveBeenCalledWith('user-123', 'reset');
    expect(mockStoreToken).toHaveBeenCalledTimes(1);

    // Second request for the same email
    await requestPasswordReset(makePostRequest({ email: 'test@example.com' }));
    expect(mockDeleteUserTokens).toHaveBeenCalledTimes(2);
    expect(mockStoreToken).toHaveBeenCalledTimes(2);
    // Both requests delete old tokens and store a new one
    expect(mockDeleteUserTokens).toHaveBeenNthCalledWith(2, 'user-123', 'reset');
  });

  it('returns success even when email sending fails', async () => {
    mockFindUserByEmail.mockResolvedValue(testUser);
    mockGenerateToken.mockReturnValue('mock-token');
    mockSendPasswordResetEmail.mockRejectedValue(new Error('Resend API error'));

    const request = makePostRequest({ email: 'test@example.com' });
    const response = await requestPasswordReset(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.status).toBe('success');
  });

  it('returns identical response shape for existing and nonexistent emails', async () => {
    // Existing email
    mockFindUserByEmail.mockResolvedValue(testUser);
    mockGenerateToken.mockReturnValue('mock-token');
    const existingResponse = await requestPasswordReset(
      makePostRequest({ email: 'exists@example.com' })
    );
    const existingData = await existingResponse.json();

    vi.clearAllMocks();
    mockSendPasswordResetEmail.mockResolvedValue({ success: true });
    mockStoreToken.mockResolvedValue({ id: 'token-1' });
    mockDeleteUserTokens.mockResolvedValue(1);

    // Nonexistent email
    mockFindUserByEmail.mockResolvedValue(undefined);
    const nonexistentResponse = await requestPasswordReset(
      makePostRequest({ email: 'doesnotexist@example.com' })
    );
    const nonexistentData = await nonexistentResponse.json();

    // Same status code and body shape
    expect(existingResponse.status).toBe(nonexistentResponse.status);
    expect(Object.keys(existingData).sort()).toEqual(Object.keys(nonexistentData).sort());
    expect(existingData.status).toBe(nonexistentData.status);
  });
});

function makeInvalidJsonRequest(): NextRequest {
  return new NextRequest('http://localhost/api/v2/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: 'not valid json{{{',
  });
}

describe('POST /api/v2/reset_password', () => {
  it('returns 422 for invalid JSON body', async () => {
    const request = makeInvalidJsonRequest();
    const response = await resetPassword(request);
    const data = await response.json();

    expect(response.status).toBe(422);
    expect(data.detail).toBe('Invalid request body');
  });

  it('returns 422 for empty string reset_token', async () => {
    const request = makePostRequest({ reset_token: '', new_password: 'NewStr0ngP@ss!' });
    const response = await resetPassword(request);
    const data = await response.json();

    expect(response.status).toBe(422);
    expect(data.detail).toContain('reset_token is required');
  });

  it('returns 422 for empty string new_password', async () => {
    const request = makePostRequest({ reset_token: 'valid-jwt', new_password: '' });
    const response = await resetPassword(request);
    const data = await response.json();

    expect(response.status).toBe(422);
    expect(data.detail).toContain('new_password is required');
  });

  it('resets password with valid token and strong password', async () => {
    mockVerifyToken.mockReturnValue({ user_id: 'user-123', type: 'reset' });
    mockFindToken.mockResolvedValue({ ...testUser, user: testUser, tokenType: 'reset', tokenHash: 'hash' });
    mockCheckPasswordStrength.mockReturnValue({ valid: true, score: 4, suggestions: [] });
    mockHashPassword.mockResolvedValue('$2b$12$newhash');
    mockUpdateUser.mockResolvedValue(testUser);

    const request = makePostRequest({ reset_token: 'valid-jwt', new_password: 'NewStr0ngP@ss!' });
    const response = await resetPassword(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.status).toBe('success');
    expect(mockHashPassword).toHaveBeenCalledWith('NewStr0ngP@ss!');
    expect(mockUpdateUser).toHaveBeenCalledWith('user-123', { passwordHash: '$2b$12$newhash' });
    expect(mockDeleteUserTokens).toHaveBeenCalledWith('user-123');
  });

  it('returns 400 for invalid JWT (malformed)', async () => {
    mockVerifyToken.mockReturnValue(null);

    const request = makePostRequest({ reset_token: 'garbage-token', new_password: 'NewStr0ngP@ss!' });
    const response = await resetPassword(request);
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.detail).toBe('Invalid or expired reset token');
  });

  it('returns 400 for expired JWT', async () => {
    mockVerifyToken.mockReturnValue(null); // verifyToken returns null for expired tokens

    const request = makePostRequest({ reset_token: 'expired-jwt', new_password: 'NewStr0ngP@ss!' });
    const response = await resetPassword(request);
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.detail).toBe('Invalid or expired reset token');
  });

  it('returns 400 for valid JWT but token not in DB (already used)', async () => {
    mockVerifyToken.mockReturnValue({ user_id: 'user-123', type: 'reset' });
    mockFindToken.mockResolvedValue(undefined);

    const request = makePostRequest({ reset_token: 'used-jwt', new_password: 'NewStr0ngP@ss!' });
    const response = await resetPassword(request);
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.detail).toBe('Invalid or expired reset token');
  });

  it('returns 400 for valid JWT with wrong token type', async () => {
    mockVerifyToken.mockReturnValue({ user_id: 'user-123', type: 'access' });

    const request = makePostRequest({ reset_token: 'access-jwt', new_password: 'NewStr0ngP@ss!' });
    const response = await resetPassword(request);
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.detail).toBe('Invalid or expired reset token');
  });

  it('returns 400 for weak password', async () => {
    mockVerifyToken.mockReturnValue({ user_id: 'user-123', type: 'reset' });
    mockFindToken.mockResolvedValue({ ...testUser, user: testUser, tokenType: 'reset', tokenHash: 'hash' });
    mockCheckPasswordStrength.mockReturnValue({
      valid: false,
      score: 1,
      suggestions: ['Add uppercase letters.', 'Add numbers.'],
    });

    const request = makePostRequest({ reset_token: 'valid-jwt', new_password: 'weak' });
    const response = await resetPassword(request);
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.detail).toContain('Password is too weak');
    expect(data.detail).toContain('Add uppercase letters.');
    expect(mockUpdateUser).not.toHaveBeenCalled();
  });

  it('returns 422 for missing fields', async () => {
    const request = makePostRequest({});
    const response = await resetPassword(request);
    const data = await response.json();

    expect(response.status).toBe(422);
    expect(data.detail).toBeDefined();
  });

  it('returns 400 for token reuse after successful reset', async () => {
    // First successful reset
    mockVerifyToken.mockReturnValue({ user_id: 'user-123', type: 'reset' });
    mockFindToken.mockResolvedValue({ ...testUser, user: testUser, tokenType: 'reset', tokenHash: 'hash' });
    mockCheckPasswordStrength.mockReturnValue({ valid: true, score: 4, suggestions: [] });
    mockHashPassword.mockResolvedValue('$2b$12$newhash');
    mockUpdateUser.mockResolvedValue(testUser);

    const firstRequest = makePostRequest({ reset_token: 'valid-jwt', new_password: 'NewStr0ngP@ss!' });
    const firstResponse = await resetPassword(firstRequest);
    expect(firstResponse.status).toBe(200);

    // Second attempt with same token — token no longer in DB
    mockFindToken.mockResolvedValue(undefined);

    const secondRequest = makePostRequest({ reset_token: 'valid-jwt', new_password: 'AnotherP@ss123!' });
    const secondResponse = await resetPassword(secondRequest);
    const secondData = await secondResponse.json();

    expect(secondResponse.status).toBe(400);
    expect(secondData.detail).toBe('Invalid or expired reset token');
  });

  it('invalidates all user tokens (access + refresh + reset) on successful reset', async () => {
    mockVerifyToken.mockReturnValue({ user_id: 'user-123', type: 'reset' });
    mockFindToken.mockResolvedValue({ ...testUser, user: testUser, tokenType: 'reset', tokenHash: 'hash' });
    mockCheckPasswordStrength.mockReturnValue({ valid: true, score: 4, suggestions: [] });
    mockHashPassword.mockResolvedValue('$2b$12$newhash');
    mockUpdateUser.mockResolvedValue(testUser);

    const request = makePostRequest({ reset_token: 'valid-jwt', new_password: 'NewStr0ngP@ss!' });
    await resetPassword(request);

    // deleteUserTokens called WITHOUT a type filter = deletes all token types
    expect(mockDeleteUserTokens).toHaveBeenCalledWith('user-123');
    expect(mockDeleteUserTokens).toHaveBeenCalledTimes(1);
  });
});
