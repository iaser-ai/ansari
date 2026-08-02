import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

// Mock the DB users module. The register route issues tokens via the
// consolidated issueTokenPair helper (Phase 2: token consolidation).
vi.mock('../../lib/db/users', () => ({
  findUserByEmail: vi.fn().mockResolvedValue(null),
  createUser: vi.fn().mockResolvedValue({ id: 'new-user-uuid' }),
  issueTokenPair: vi.fn().mockResolvedValue({
    accessToken: 'mock-access-token',
    refreshToken: 'mock-refresh-token',
  }),
}));

// Mock password utilities
vi.mock('../../lib/auth/password', () => ({
  hashPassword: vi.fn().mockResolvedValue('hashed-password'),
  checkPasswordStrength: vi.fn().mockReturnValue({ valid: true, suggestions: [] }),
}));

// Mock the newsletter module — we spy on the actual function
vi.mock('../../lib/newsletter', () => ({
  subscribeToNewsletter: vi.fn().mockResolvedValue({ success: true }),
}));

// Mock Sentry — the register route now transitively uses it via getClientId
// (spec 56); mock so unit tests don't reach the network.
vi.mock('@sentry/nextjs', () => ({
  setTag: vi.fn(),
  captureMessage: vi.fn(),
}));

// Mock the reserved-address helper (spec 4) so tests control which addresses are
// reserved without loading real config. `h.reserved` is set per-test.
const h = vi.hoisted(() => ({ reserved: new Set<string>() }));
vi.mock('../../lib/auth/reserved', () => ({
  isReservedAddress: (email: string) => h.reserved.has(email),
}));

function makeRequest(body: Record<string, unknown>, clientId?: string): NextRequest {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (clientId !== undefined) headers['X-Ansari-Client'] = clientId;
  return new NextRequest('http://localhost:3000/api/v2/users/register', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

describe('Registration newsletter integration', () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    vi.clearAllMocks();
    h.reserved.clear();
    originalEnv = { ...process.env };
    process.env.JWT_SECRET = 'test-secret-key-for-testing-purposes-only-32chars';
    process.env.ACCESS_TOKEN_EXPIRY_HOURS = '2';
    process.env.REFRESH_TOKEN_EXPIRY_HOURS = '2160';
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('calls subscribeToNewsletter with correct payload after registration', async () => {
    const { POST } = await import('../../src/app/api/v2/users/register/route');
    const { subscribeToNewsletter } = await import('../../lib/newsletter');

    const response = await POST(makeRequest({
      email: 'new@example.com',
      password: 'StrongPass123!',
      first_name: 'John',
      last_name: 'Doe',
      register_to_mail_list: true,
    }));

    // Registration should succeed
    const data = await response.json();
    expect(data.status).toBe('success');
    expect(data.access_token).toBeDefined();

    // Flush microtasks so fire-and-forget promise resolves
    await new Promise(resolve => setImmediate(resolve));

    expect(subscribeToNewsletter).toHaveBeenCalledWith('new@example.com', 'John', 'Doe');
  });

  it('registration succeeds even when newsletter fails', async () => {
    const { subscribeToNewsletter } = await import('../../lib/newsletter');
    (subscribeToNewsletter as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      success: false,
      error: 'HTTP 500: Internal Server Error',
    });

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { POST } = await import('../../src/app/api/v2/users/register/route');

    const response = await POST(makeRequest({
      email: 'fail@example.com',
      password: 'StrongPass123!',
      first_name: 'Jane',
      last_name: 'Doe',
      register_to_mail_list: true,
    }));

    // Registration still succeeds
    const data = await response.json();
    expect(data.status).toBe('success');

    // Flush microtasks
    await new Promise(resolve => setImmediate(resolve));

    // Error should have been logged
    expect(consoleSpy).toHaveBeenCalledWith(
      'Newsletter subscription failed:',
      'HTTP 500: Internal Server Error',
    );

    consoleSpy.mockRestore();
  });

  it('sends empty name when both first_name and last_name are missing', async () => {
    const { POST } = await import('../../src/app/api/v2/users/register/route');
    const { subscribeToNewsletter } = await import('../../lib/newsletter');

    await POST(makeRequest({
      email: 'noname@example.com',
      password: 'StrongPass123!',
      register_to_mail_list: true,
    }));

    // Flush microtasks
    await new Promise(resolve => setImmediate(resolve));

    // undefined fields should be converted to null via ?? null
    expect(subscribeToNewsletter).toHaveBeenCalledWith('noname@example.com', null, null);
  });

  it('trims name when only first_name is provided', async () => {
    const { POST } = await import('../../src/app/api/v2/users/register/route');
    const { subscribeToNewsletter } = await import('../../lib/newsletter');

    await POST(makeRequest({
      email: 'firstonly@example.com',
      password: 'StrongPass123!',
      first_name: 'Alice',
      register_to_mail_list: true,
    }));

    // Flush microtasks
    await new Promise(resolve => setImmediate(resolve));

    // last_name is undefined → null, subscribeToNewsletter trims internally
    expect(subscribeToNewsletter).toHaveBeenCalledWith('firstonly@example.com', 'Alice', null);
  });

  it('returns registration response before newsletter completes (fire-and-forget)', async () => {
    const { subscribeToNewsletter } = await import('../../lib/newsletter');

    // Make newsletter very slow
    let resolveNewsletter!: (value: { success: boolean }) => void;
    (subscribeToNewsletter as ReturnType<typeof vi.fn>).mockImplementationOnce(
      () => new Promise(resolve => { resolveNewsletter = resolve; }),
    );

    const { POST } = await import('../../src/app/api/v2/users/register/route');

    const response = await POST(makeRequest({
      email: 'fast@example.com',
      password: 'StrongPass123!',
      first_name: 'Fast',
      last_name: 'User',
      register_to_mail_list: true,
    }));

    // Registration returns immediately even though newsletter hasn't resolved
    const data = await response.json();
    expect(data.status).toBe('success');

    // Newsletter hasn't been resolved yet — verify the mock was called but hasn't completed
    expect(subscribeToNewsletter).toHaveBeenCalled();

    // Now resolve it to clean up
    resolveNewsletter({ success: true });
    await new Promise(resolve => setImmediate(resolve));
  });
});

describe('Registration newsletter opt-in gating (issue #46)', () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    vi.clearAllMocks();
    h.reserved.clear();
    originalEnv = { ...process.env };
    process.env.JWT_SECRET = 'test-secret-key-for-testing-purposes-only-32chars';
    process.env.ACCESS_TOKEN_EXPIRY_HOURS = '2';
    process.env.REFRESH_TOKEN_EXPIRY_HOURS = '2160';
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('does NOT subscribe when register_to_mail_list is false (explicit opt-out)', async () => {
    const { POST } = await import('../../src/app/api/v2/users/register/route');
    const { subscribeToNewsletter } = await import('../../lib/newsletter');

    const response = await POST(makeRequest({
      email: 'optout@example.com',
      password: 'StrongPass123!',
      first_name: 'Opt',
      last_name: 'Out',
      register_to_mail_list: false,
    }));

    // Registration still succeeds
    const data = await response.json();
    expect(data.status).toBe('success');

    // Flush microtasks so any (incorrect) fire-and-forget call would have run
    await new Promise(resolve => setImmediate(resolve));

    expect(subscribeToNewsletter).not.toHaveBeenCalled();
  });

  it('does NOT subscribe when register_to_mail_list is omitted (opt-in default)', async () => {
    const { POST } = await import('../../src/app/api/v2/users/register/route');
    const { subscribeToNewsletter } = await import('../../lib/newsletter');

    const response = await POST(makeRequest({
      email: 'omitted@example.com',
      password: 'StrongPass123!',
      first_name: 'No',
      last_name: 'Flag',
    }));

    const data = await response.json();
    expect(data.status).toBe('success');

    await new Promise(resolve => setImmediate(resolve));

    expect(subscribeToNewsletter).not.toHaveBeenCalled();
  });

  it('does NOT subscribe guest registrations (guest_* sends false)', async () => {
    const { POST } = await import('../../src/app/api/v2/users/register/route');
    const { subscribeToNewsletter } = await import('../../lib/newsletter');

    const response = await POST(makeRequest({
      email: 'guest_a1b2c3d4e5@ansari.chat',
      password: 'StrongPass123!',
      register_to_mail_list: false,
    }));

    const data = await response.json();
    expect(data.status).toBe('success');

    await new Promise(resolve => setImmediate(resolve));

    expect(subscribeToNewsletter).not.toHaveBeenCalled();
  });

  it('DOES subscribe when register_to_mail_list is true (explicit opt-in)', async () => {
    const { POST } = await import('../../src/app/api/v2/users/register/route');
    const { subscribeToNewsletter } = await import('../../lib/newsletter');

    const response = await POST(makeRequest({
      email: 'optin@example.com',
      password: 'StrongPass123!',
      first_name: 'Opt',
      last_name: 'In',
      register_to_mail_list: true,
    }));

    const data = await response.json();
    expect(data.status).toBe('success');

    await new Promise(resolve => setImmediate(resolve));

    expect(subscribeToNewsletter).toHaveBeenCalledWith('optin@example.com', 'Opt', 'In');
  });

  it('rejects a non-boolean register_to_mail_list with 422 (backward-compatible validation)', async () => {
    const { POST } = await import('../../src/app/api/v2/users/register/route');
    const { subscribeToNewsletter } = await import('../../lib/newsletter');

    const response = await POST(makeRequest({
      email: 'badflag@example.com',
      password: 'StrongPass123!',
      register_to_mail_list: 'yes',
    }));

    expect(response.status).toBe(422);

    await new Promise(resolve => setImmediate(resolve));

    expect(subscribeToNewsletter).not.toHaveBeenCalled();
  });
});

describe('Registration client attribution (registered_via, spec 56)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.JWT_SECRET = 'test-secret-key-for-testing-purposes-only-32chars';
    process.env.ACCESS_TOKEN_EXPIRY_HOURS = '2';
    process.env.REFRESH_TOKEN_EXPIRY_HOURS = '2160';
  });

  it('records registered_via from the X-Ansari-Client header (source stays web)', async () => {
    const { POST } = await import('../../src/app/api/v2/users/register/route');
    const { createUser } = await import('../../lib/db/users');

    const response = await POST(makeRequest(
      { email: 'partner@example.com', password: 'StrongPass123!' },
      'muslimpedia'
    ));

    expect((await response.json()).status).toBe('success');
    expect(createUser).toHaveBeenCalledWith(
      expect.objectContaining({ registeredVia: 'muslimpedia', source: 'web' })
    );
  });

  it('registered_via is null when the header is absent (backward compatible)', async () => {
    const { POST } = await import('../../src/app/api/v2/users/register/route');
    const { createUser } = await import('../../lib/db/users');

    await POST(makeRequest({ email: 'noheader@example.com', password: 'StrongPass123!' }));

    expect(createUser).toHaveBeenCalledWith(
      expect.objectContaining({ registeredVia: null })
    );
  });

  it("records the 'invalid' sentinel for a malformed header", async () => {
    const { POST } = await import('../../src/app/api/v2/users/register/route');
    const { createUser } = await import('../../lib/db/users');

    await POST(makeRequest(
      { email: 'malformed@example.com', password: 'StrongPass123!' },
      'has spaces'
    ));

    expect(createUser).toHaveBeenCalledWith(
      expect.objectContaining({ registeredVia: 'invalid' })
    );
  });
});

describe('Reserved-address registration (spec 4 anti-oracle)', () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    vi.clearAllMocks();
    h.reserved.clear();
    originalEnv = { ...process.env };
    process.env.JWT_SECRET = 'test-secret-key-for-testing-purposes-only-32chars';
    process.env.ACCESS_TOKEN_EXPIRY_HOURS = '2';
    process.env.REFRESH_TOKEN_EXPIRY_HOURS = '2160';
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('refuses a reserved address with the SAME 409 as an existing-account conflict', async () => {
    h.reserved.add('admin@ansari.chat');
    const { POST } = await import('../../src/app/api/v2/users/register/route');
    const { issueTokenPair } = await import('../../lib/db/users');

    const response = await POST(makeRequest({
      email: 'admin@ansari.chat',
      password: 'StrongPass123!',
    }));

    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.detail).toBe('An account with this email already exists');
    // No account is created for a reserved address.
    expect(issueTokenPair).not.toHaveBeenCalled();
  });

  it('matches reserved addresses case-insensitively (normalized before the check)', async () => {
    h.reserved.add('admin@ansari.chat');
    const { POST } = await import('../../src/app/api/v2/users/register/route');

    const response = await POST(makeRequest({
      email: 'Admin@Ansari.Chat',
      password: 'StrongPass123!',
    }));

    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.detail).toBe('An account with this email already exists');
  });

  it('returns 409 (not 400) for a reserved address paired with a WEAK password (placement guard)', async () => {
    h.reserved.add('admin@ansari.chat');
    const { checkPasswordStrength } = await import('../../lib/auth/password');
    // Force the strength check to fail: if the reserved check were placed AFTER it,
    // this would return 400 and leak that the address is NOT reserved-vs-taken.
    (checkPasswordStrength as ReturnType<typeof vi.fn>).mockReturnValueOnce({
      valid: false,
      score: 0,
      suggestions: ['too weak'],
    });

    const { POST } = await import('../../src/app/api/v2/users/register/route');

    // 8+ chars so the Zod min(8) schema passes and control reaches the strength
    // check — which we've forced to fail. A correctly-placed reserved check still
    // returns 409 before that.
    const response = await POST(makeRequest({
      email: 'admin@ansari.chat',
      password: 'weakbutlongenough',
    }));

    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.detail).toBe('An account with this email already exists');
  });
});
