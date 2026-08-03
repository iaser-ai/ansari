import { describe, it, expect, vi, beforeEach } from 'vitest';

// Spec 4: the admin bootstrap startup assertion. It must (a) throw when a
// configured admin is missing or unflagged, (b) pass when all exist and are
// flagged, and (c) only RUN in a production Node server — never during
// `next build` or in dev/test.

const mockEmails: string[] = [];
vi.mock('@/lib/config', () => ({
  config: {
    get admin() {
      return { emails: mockEmails };
    },
  },
}));

const mockFindUserByEmail = vi.fn();
vi.mock('@/lib/db/users', () => ({
  findUserByEmail: (...args: unknown[]) => mockFindUserByEmail(...args),
}));

import { assertConfiguredAdminsExist, shouldRunAdminStartupCheck } from '@/lib/auth/startup-checks';

function setEmails(emails: string[]) {
  mockEmails.length = 0;
  mockEmails.push(...emails);
}

beforeEach(() => {
  vi.clearAllMocks();
  setEmails([]);
});

describe('assertConfiguredAdminsExist', () => {
  it('is a no-op when no admin addresses are configured', async () => {
    await expect(assertConfiguredAdminsExist()).resolves.toBeUndefined();
    expect(mockFindUserByEmail).not.toHaveBeenCalled();
  });

  it('passes when every configured admin exists and is flagged', async () => {
    setEmails(['admin@ansari.chat']);
    mockFindUserByEmail.mockResolvedValue({ id: '1', email: 'admin@ansari.chat', isAdmin: true });
    await expect(assertConfiguredAdminsExist()).resolves.toBeUndefined();
  });

  it('throws when a configured admin has no account', async () => {
    setEmails(['admin@ansari.chat']);
    mockFindUserByEmail.mockResolvedValue(undefined);
    await expect(assertConfiguredAdminsExist()).rejects.toThrow(/has no account/);
  });

  it('throws when a configured admin exists but is not flagged is_admin', async () => {
    setEmails(['admin@ansari.chat']);
    mockFindUserByEmail.mockResolvedValue({ id: '1', email: 'admin@ansari.chat', isAdmin: false });
    await expect(assertConfiguredAdminsExist()).rejects.toThrow(/not flagged is_admin/);
  });

  it('does not leak the admin email address in the error (logs carry no email content)', async () => {
    setEmails(['secret-admin@ansari.chat']);
    mockFindUserByEmail.mockResolvedValue(undefined);
    await expect(assertConfiguredAdminsExist()).rejects.toThrow(
      expect.objectContaining({ message: expect.not.stringContaining('secret-admin@ansari.chat') })
    );
  });

  it('reports a DB-unreachable error distinctly from a missing admin', async () => {
    setEmails(['admin@ansari.chat']);
    mockFindUserByEmail.mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(assertConfiguredAdminsExist()).rejects.toThrow(/could not reach the database/);
  });
});

describe('shouldRunAdminStartupCheck', () => {
  const base = {
    NODE_ENV: 'production',
    NEXT_RUNTIME: 'nodejs',
    NEXT_PHASE: undefined,
  } as unknown as NodeJS.ProcessEnv;

  it('runs only in a production Node server (not during build)', () => {
    expect(shouldRunAdminStartupCheck(base)).toBe(true);
  });

  it('does NOT run during next build (NEXT_PHASE=phase-production-build)', () => {
    expect(
      shouldRunAdminStartupCheck({ ...base, NEXT_PHASE: 'phase-production-build' } as NodeJS.ProcessEnv)
    ).toBe(false);
  });

  it('does NOT run in development or test', () => {
    expect(shouldRunAdminStartupCheck({ ...base, NODE_ENV: 'development' } as NodeJS.ProcessEnv)).toBe(false);
    expect(shouldRunAdminStartupCheck({ ...base, NODE_ENV: 'test' } as NodeJS.ProcessEnv)).toBe(false);
  });

  it('does NOT run in a non-nodejs runtime (edge)', () => {
    expect(shouldRunAdminStartupCheck({ ...base, NEXT_RUNTIME: 'edge' } as NodeJS.ProcessEnv)).toBe(false);
  });
});
