import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

// Mock config module
const mockEmails: string[] = [];
vi.mock('../lib/config', () => ({
  config: {
    get admin() {
      return { emails: mockEmails };
    },
  },
}));

// Mock middleware module to avoid DB dependency chain
vi.mock('../lib/auth/middleware', () => ({
  authenticateRequest: vi.fn(),
  createErrorResponse: (detail: string, status: number) =>
    NextResponse.json({ detail }, { status }),
}));

import { isAdmin, requireAdmin } from '../lib/auth/admin';
import { authenticateRequest } from '../lib/auth/middleware';

function setAdminEmails(emails: string[]) {
  mockEmails.length = 0;
  mockEmails.push(...emails);
}

describe('isAdmin', () => {
  beforeEach(() => {
    setAdminEmails([]);
  });

  it('returns false when ADMIN_EMAILS is empty', () => {
    expect(isAdmin('anyone@example.com')).toBe(false);
  });

  it('returns true for an email on the whitelist', () => {
    setAdminEmails(['admin@example.com']);
    expect(isAdmin('admin@example.com')).toBe(true);
  });

  it('is case-insensitive (RFC 5321)', () => {
    setAdminEmails(['admin@example.com']);
    expect(isAdmin('ADMIN@EXAMPLE.COM')).toBe(true);
    expect(isAdmin('Admin@Example.Com')).toBe(true);
  });

  it('returns false for an email not on the whitelist', () => {
    setAdminEmails(['admin@example.com']);
    expect(isAdmin('other@example.com')).toBe(false);
  });

  it('handles multiple admin emails', () => {
    setAdminEmails(['admin1@example.com', 'admin2@example.com']);
    expect(isAdmin('admin1@example.com')).toBe(true);
    expect(isAdmin('admin2@example.com')).toBe(true);
    expect(isAdmin('admin3@example.com')).toBe(false);
  });
});

describe('requireAdmin', () => {
  const mockAuth = vi.mocked(authenticateRequest);

  beforeEach(() => {
    setAdminEmails(['admin@example.com']);
    mockAuth.mockReset();
  });

  function makeRequest(): NextRequest {
    return new NextRequest('http://localhost/api/v2/admin/stats', {
      headers: { Authorization: 'Bearer test-token' },
    });
  }

  it('returns 401 when not authenticated', async () => {
    const errorResponse = NextResponse.json({ detail: 'Not authenticated' }, { status: 401 });
    mockAuth.mockResolvedValue({ error: errorResponse });

    const result = await requireAdmin(makeRequest());
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error.status).toBe(401);
    }
  });

  it('returns 403 for authenticated non-admin user', async () => {
    mockAuth.mockResolvedValue({
      user: { id: '1', email: 'user@example.com', passwordHash: '', firstName: null, lastName: null, source: 'web', createdAt: new Date(), updatedAt: new Date() },
    });

    const result = await requireAdmin(makeRequest());
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error.status).toBe(403);
      const body = await result.error.json();
      expect(body.detail).toBe('Admin access required');
    }
  });

  it('returns user for authenticated admin', async () => {
    const adminUser = { id: '1', email: 'admin@example.com', passwordHash: '', firstName: null, lastName: null, source: 'web', createdAt: new Date(), updatedAt: new Date() };
    mockAuth.mockResolvedValue({ user: adminUser });

    const result = await requireAdmin(makeRequest());
    expect('error' in result).toBe(false);
    if (!('error' in result)) {
      expect(result.user.email).toBe('admin@example.com');
    }
  });

  it('handles case-insensitive admin email match', async () => {
    setAdminEmails(['admin@example.com']);
    mockAuth.mockResolvedValue({
      user: { id: '1', email: 'ADMIN@EXAMPLE.COM', passwordHash: '', firstName: null, lastName: null, source: 'web', createdAt: new Date(), updatedAt: new Date() },
    });

    const result = await requireAdmin(makeRequest());
    expect('error' in result).toBe(false);
  });

  it('returns 403 for all users when ADMIN_EMAILS is empty', async () => {
    setAdminEmails([]);
    mockAuth.mockResolvedValue({
      user: { id: '1', email: 'anyone@example.com', passwordHash: '', firstName: null, lastName: null, source: 'web', createdAt: new Date(), updatedAt: new Date() },
    });

    const result = await requireAdmin(makeRequest());
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error.status).toBe(403);
    }
  });
});

describe('ADMIN_EMAILS parsing logic', () => {
  it('parses comma-separated emails with trimming and lowering', () => {
    const raw = 'admin@a.com, Admin@B.COM , user@c.com';
    const parsed = raw.split(',').map((e) => e.trim().toLowerCase()).filter((e) => e.length > 0);
    expect(parsed).toEqual(['admin@a.com', 'admin@b.com', 'user@c.com']);
  });

  it('handles empty string', () => {
    const raw = '';
    const parsed = raw.split(',').map((e) => e.trim().toLowerCase()).filter((e) => e.length > 0);
    expect(parsed).toEqual([]);
  });

  it('handles whitespace-only entries', () => {
    const raw = 'admin@a.com, , ,user@b.com';
    const parsed = raw.split(',').map((e) => e.trim().toLowerCase()).filter((e) => e.length > 0);
    expect(parsed).toEqual(['admin@a.com', 'user@b.com']);
  });
});
