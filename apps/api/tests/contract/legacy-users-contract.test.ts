import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import fixtures from './fixtures/legacy-users.json';
import { createHarness, type ContractHarness, type MockState, type WireResponse } from './harness';

// Frozen wire contract of the legacy /v2/users/* surface and the two
// password-reset routes (spec 300, plan phase 1). Written against the legacy
// apps/api; since phase 8 these same assertions run against the compatibility
// layer over apps/auth, unedited. Setup lives in ./harness (the AuthBackend
// seam); nothing below may branch on the backend. Reset emails are captured
// by the harness from apps/auth's injected mailer into `sentEmails`.

const h = vi.hoisted((): MockState => ({ db: null, sentEmails: [] }));

vi.mock('@/lib/db/index', () => ({
  get db() {
    return h.db;
  },
  closeDb: async () => {},
}));

type FixtureName = Exclude<keyof typeof fixtures, '$comment'>;
type ValueType = 'string' | 'null' | 'uuid' | 'iso-datetime';
interface Fixture {
  status: number;
  shape: Record<string, ValueType>;
  values?: Record<string, unknown>;
  detailOneOf?: string[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string' && UUID.test(value)) return 'uuid';
  if (typeof value === 'string' && ISO_DATETIME.test(value)) return 'iso-datetime';
  return typeof value;
}

/** The one assertion every scenario goes through. */
function expectWire(res: WireResponse, name: FixtureName): Record<string, unknown> {
  const fixture = fixtures[name] as Fixture;
  expect(res.status, `${name}: status`).toBe(fixture.status);
  expect(res.contentType, `${name}: content-type`).toMatch(/^application\/json/);
  const body = res.body as Record<string, unknown>;
  expect(Object.keys(body).sort(), `${name}: key set`).toEqual(Object.keys(fixture.shape).sort());
  for (const [key, type] of Object.entries(fixture.shape)) {
    expect(typeOf(body[key]), `${name}: type of ${key}`).toBe(type);
  }
  for (const [key, value] of Object.entries(fixture.values ?? {})) {
    expect(body[key], `${name}: value of ${key}`).toEqual(value);
  }
  if (fixture.detailOneOf) {
    expect(fixture.detailOneOf, `${name}: detail`).toContain(body.detail);
  }
  return body;
}

const PASSWORD = 'Correct-Horse-Battery-9';
const NEW_PASSWORD = 'Fresh-Lantern-Orchard-4';
const WEAK_PASSWORD = 'aaaaaaaa';
const SYSTEM_ADDRESS = 'someone@system.ansari.chat';

let harness: ContractHarness;

beforeAll(async () => {
  harness = await createHarness(h);
});

afterAll(async () => {
  await harness.close();
});

beforeEach(async () => {
  await harness.reset();
});

async function loginAs(email: string, password = PASSWORD) {
  return expectWire(await harness.call('login', { body: { email, password } }), 'login.ok') as {
    access_token: string;
    refresh_token: string;
  };
}

describe('POST /v2/users/register', () => {
  it('creates the account and returns the token pair', async () => {
    const body = expectWire(
      await harness.call('register', {
        body: { email: 'new@example.com', password: PASSWORD, first_name: 'Amina', last_name: 'Khan' },
      }),
      'register.ok'
    );
    // The returned access token authenticates as the new account.
    const me = expectWire(await harness.call('me.get', { token: body.access_token as string }), 'me.get.ok');
    expect(me).toMatchObject({ email: 'new@example.com', first_name: 'Amina', last_name: 'Khan' });
  });

  it('stores the email lowercased and names as null when omitted', async () => {
    const { access_token } = expectWire(
      await harness.call('register', { body: { email: 'Mixed.Case@Example.com', password: PASSWORD } }),
      'register.ok'
    ) as { access_token: string };
    const me = expectWire(await harness.call('me.get', { token: access_token }), 'me.get.ok_null_names');
    expect(me.email).toBe('mixed.case@example.com');
  });

  it('records registered_via from X-Ansari-Client, and NULL when the header is absent', async () => {
    await harness.call('register', {
      body: { email: 'android@example.com', password: PASSWORD },
      headers: { 'X-Ansari-Client': 'askansari-android' },
    });
    await harness.call('register', { body: { email: 'plain@example.com', password: PASSWORD } });
    expect((await harness.appUser('android@example.com'))?.registered_via).toBe('askansari-android');
    expect((await harness.appUser('plain@example.com'))?.registered_via).toBeNull();
  });

  it.each([
    ['register.invalid_email', { email: 'not-an-email', password: PASSWORD }],
    ['register.password_too_short', { email: 'a@example.com', password: 'Sh0rt!' }],
    ['register.password_too_long', { email: 'a@example.com', password: `Aa1!${'x'.repeat(125)}` }],
    ['register.invalid_email_and_short_password', { email: 'not-an-email', password: 'Sh0rt!' }],
    ['register.missing_fields', {}],
  ] as const)('validation failure: %s', async (name, body) => {
    expectWire(await harness.call('register', { body }), name);
  });

  it('answers malformed JSON with the generic failure', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expectWire(await harness.call('register', { rawBody: '{not json' }), 'register.malformed_json');
    } finally {
      consoleError.mockRestore();
    }
  });

  it('refuses a taken email with 409, case-insensitively', async () => {
    await harness.seedUser({ email: 'taken@example.com', password: PASSWORD });
    const exact = await harness.call('register', { body: { email: 'taken@example.com', password: PASSWORD } });
    const upper = await harness.call('register', { body: { email: 'Taken@Example.com', password: PASSWORD } });
    expectWire(exact, 'register.email_taken');
    expectWire(upper, 'register.email_taken');
  });

  it('refuses a reserved system address with the IDENTICAL 409 a taken email gets', async () => {
    await harness.seedUser({ email: 'taken@example.com', password: PASSWORD });
    const taken = await harness.call('register', { body: { email: 'taken@example.com', password: PASSWORD } });
    const reserved = await harness.call('register', { body: { email: SYSTEM_ADDRESS, password: PASSWORD } });
    expectWire(reserved, 'register.email_taken');
    expect(reserved).toEqual(taken);
    expect(await harness.appUser(SYSTEM_ADDRESS)).toBeUndefined();
  });

  it('refuses a weak password with 400 and creates nothing', async () => {
    expectWire(
      await harness.call('register', { body: { email: 'weak@example.com', password: WEAK_PASSWORD } }),
      'register.weak_password'
    );
    expect(await harness.appUser('weak@example.com')).toBeUndefined();
  });

  describe('guard order: validation → reserved/taken → strength → create', () => {
    it('validation runs before the taken check', async () => {
      await harness.seedUser({ email: 'taken@example.com', password: PASSWORD });
      expectWire(
        await harness.call('register', { body: { email: 'taken@example.com', password: 'Sh0rt!' } }),
        'register.password_too_short'
      );
    });

    it('a reserved address with a weak password gets 409, not 400', async () => {
      expectWire(
        await harness.call('register', { body: { email: SYSTEM_ADDRESS, password: WEAK_PASSWORD } }),
        'register.email_taken'
      );
    });

    it('a taken address with a weak password gets 409, not 400', async () => {
      await harness.seedUser({ email: 'taken@example.com', password: PASSWORD });
      expectWire(
        await harness.call('register', { body: { email: 'taken@example.com', password: WEAK_PASSWORD } }),
        'register.email_taken'
      );
    });
  });
});

describe('POST /v2/users/login', () => {
  it('returns the token pair and the stored names', async () => {
    await harness.seedUser({ email: 'amina@example.com', password: PASSWORD, firstName: 'Amina', lastName: 'Khan' });
    const body = await loginAs('amina@example.com');
    expect(body).toMatchObject({ first_name: 'Amina', last_name: 'Khan' });
    expectWire(await harness.call('me.get', { token: body.access_token }), 'me.get.ok');
  });

  it('scenario 7: null names come back as empty strings', async () => {
    await harness.seedUser({ email: 'nameless@example.com', password: PASSWORD });
    expectWire(
      await harness.call('login', { body: { email: 'nameless@example.com', password: PASSWORD } }),
      'login.ok_null_names'
    );
  });

  it('finds a lowercase row from a mixed-case email', async () => {
    await harness.seedUser({ email: 'bob@example.com', password: PASSWORD });
    await loginAs('Bob@Example.COM');
  });

  it('answers an unknown email and a wrong password identically (401)', async () => {
    await harness.seedUser({ email: 'amina@example.com', password: PASSWORD });
    const unknown = await harness.call('login', { body: { email: 'nobody@example.com', password: PASSWORD } });
    const wrong = await harness.call('login', { body: { email: 'amina@example.com', password: NEW_PASSWORD } });
    expectWire(unknown, 'login.invalid_credentials');
    expect(wrong).toEqual(unknown);
  });

  it.each([
    ['login.invalid_email', { email: 'not-an-email', password: PASSWORD }],
    ['login.missing_password', { email: 'amina@example.com', password: '' }],
  ] as const)('validation failure: %s', async (name, body) => {
    expectWire(await harness.call('login', { body }), name);
  });

  it('answers malformed JSON with the generic failure', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expectWire(await harness.call('login', { rawBody: '{not json' }), 'login.malformed_json');
    } finally {
      consoleError.mockRestore();
    }
  });
});

describe('POST /v2/users/refresh_token', () => {
  it('exchanges a refresh token for a working pair, with no `status` key', async () => {
    await harness.seedUser({ email: 'amina@example.com', password: PASSWORD, firstName: 'Amina', lastName: 'Khan' });
    const { refresh_token } = await loginAs('amina@example.com');
    const body = expectWire(await harness.call('refresh_token', { body: { refresh_token } }), 'refresh_token.ok');
    expect(body).not.toHaveProperty('status');
    expectWire(await harness.call('me.get', { token: body.access_token as string }), 'me.get.ok');
    // The returned refresh token is itself usable for the next cycle.
    expectWire(
      await harness.call('refresh_token', { body: { refresh_token: body.refresh_token } }),
      'refresh_token.ok'
    );
  });

  it('rejects a garbage token with 401', async () => {
    expectWire(
      await harness.call('refresh_token', { body: { refresh_token: 'not-a-token' } }),
      'refresh_token.invalid'
    );
  });

  it('rejects an access token presented as a refresh token with 401', async () => {
    await harness.seedUser({ email: 'amina@example.com', password: PASSWORD });
    const { access_token } = await loginAs('amina@example.com');
    expectWire(
      await harness.call('refresh_token', { body: { refresh_token: access_token } }),
      'refresh_token.rejected'
    );
  });

  it('rejects an empty token with 422', async () => {
    expectWire(await harness.call('refresh_token', { body: { refresh_token: '' } }), 'refresh_token.missing');
  });

  it('answers malformed JSON with the generic failure', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expectWire(await harness.call('refresh_token', { rawBody: '{not json' }), 'refresh_token.malformed_json');
    } finally {
      consoleError.mockRestore();
    }
  });
});

describe('POST /v2/users/logout', () => {
  it('logs out every device: no session of the user can refresh afterwards', async () => {
    await harness.seedUser({ email: 'amina@example.com', password: PASSWORD });
    const phone = await loginAs('amina@example.com');
    const laptop = await loginAs('amina@example.com');

    expectWire(await harness.call('logout', { token: phone.access_token }), 'logout.ok');

    for (const device of [phone, laptop]) {
      expectWire(
        await harness.call('refresh_token', { body: { refresh_token: device.refresh_token } }),
        'refresh_token.rejected'
      );
    }
    // Signing in again still works.
    await loginAs('amina@example.com');
  });

  it('requires a bearer token', async () => {
    expectWire(await harness.call('logout'), 'bearer.missing');
  });

  it('rejects a garbage bearer token with 401', async () => {
    expectWire(await harness.call('logout', { token: 'not-a-token' }), 'bearer.invalid_or_expired');
  });
});

describe('GET /v2/users/me', () => {
  it('returns the account in the frozen shape', async () => {
    const { id } = await harness.seedUser({
      email: 'amina@example.com',
      password: PASSWORD,
      firstName: 'Amina',
      lastName: 'Khan',
    });
    const { access_token } = await loginAs('amina@example.com');
    const me = expectWire(await harness.call('me.get', { token: access_token }), 'me.get.ok');
    expect(me).toMatchObject({ id, email: 'amina@example.com', first_name: 'Amina', last_name: 'Khan' });
  });

  it('returns null names as null (not empty strings, unlike login)', async () => {
    await harness.seedUser({ email: 'nameless@example.com', password: PASSWORD });
    const { access_token } = await loginAs('nameless@example.com');
    expectWire(await harness.call('me.get', { token: access_token }), 'me.get.ok_null_names');
  });

  it('requires a bearer token', async () => {
    expectWire(await harness.call('me.get'), 'bearer.missing');
  });

  it('rejects a garbage bearer token with 401', async () => {
    expectWire(await harness.call('me.get', { token: 'not-a-token' }), 'bearer.invalid_or_expired');
  });

  it('rejects a refresh token presented as the bearer with 401', async () => {
    await harness.seedUser({ email: 'amina@example.com', password: PASSWORD });
    const { refresh_token } = await loginAs('amina@example.com');
    expectWire(await harness.call('me.get', { token: refresh_token }), 'bearer.rejected');
  });

  it('rejects an expired access token with 401', async () => {
    await harness.seedUser({ email: 'amina@example.com', password: PASSWORD });
    const { access_token } = await loginAs('amina@example.com');
    harness.expireAccessToken();
    expectWire(await harness.call('me.get', { token: access_token }), 'bearer.invalid_or_expired');
  });
});

describe('DELETE /v2/users/me', () => {
  it('deletes the account and everything it owns; the token and password stop working', async () => {
    const { id } = await harness.seedUser({ email: 'amina@example.com', password: PASSWORD });
    await harness.seedOwnedRows(id);
    expect(await harness.ownedRowCounts(id)).toEqual({ threads: 1, preferences: 1, feedback: 1 });
    const { access_token, refresh_token } = await loginAs('amina@example.com');

    expectWire(await harness.call('me.delete', { token: access_token }), 'me.delete.ok');

    expect(await harness.ownedRowCounts(id)).toEqual({ threads: 0, preferences: 0, feedback: 0 });
    expect(await harness.appUser('amina@example.com')).toBeUndefined();
    expectWire(await harness.call('me.get', { token: access_token }), 'bearer.token_not_found');
    expectWire(await harness.call('refresh_token', { body: { refresh_token } }), 'refresh_token.rejected');
    expectWire(
      await harness.call('login', { body: { email: 'amina@example.com', password: PASSWORD } }),
      'login.invalid_credentials'
    );
  });

  it('frees the address: it can be registered again', async () => {
    await harness.seedUser({ email: 'amina@example.com', password: PASSWORD });
    const { access_token } = await loginAs('amina@example.com');
    expectWire(await harness.call('me.delete', { token: access_token }), 'me.delete.ok');
    expectWire(
      await harness.call('register', { body: { email: 'amina@example.com', password: PASSWORD } }),
      'register.ok'
    );
  });

  it('requires a bearer token', async () => {
    expectWire(await harness.call('me.delete'), 'bearer.missing');
  });

  it('rejects a garbage bearer token with 401', async () => {
    expectWire(await harness.call('me.delete', { token: 'not-a-token' }), 'bearer.invalid_or_expired');
  });
});

describe('POST /v2/request_password_reset', () => {
  it('emails a legacy-shaped reset link to a known address', async () => {
    await harness.seedUser({ email: 'amina@example.com', password: PASSWORD });
    expectWire(
      await harness.call('request_password_reset', { body: { email: 'amina@example.com' } }),
      'request_password_reset.ok'
    );
    await harness.awaitResetToken('amina@example.com');
    const [email] = harness.sentEmails();
    expect(email.html).toContain(`${harness.frontendUrl}/reset-password?token=`);
  });

  it('answers an unknown email identically, and sends it nothing', async () => {
    await harness.seedUser({ email: 'amina@example.com', password: PASSWORD });
    const unknown = await harness.call('request_password_reset', { body: { email: 'nobody@example.com' } });
    const known = await harness.call('request_password_reset', { body: { email: 'amina@example.com' } });
    expectWire(unknown, 'request_password_reset.ok');
    expect(unknown).toEqual(known);
    // The known request was made second; once its email is out, any email the
    // unknown one triggered would already be recorded.
    await harness.awaitResetToken('amina@example.com');
    expect(harness.sentEmails().map((e) => e.to)).toEqual(['amina@example.com']);
  });

  it('rejects an invalid email with 422', async () => {
    expectWire(
      await harness.call('request_password_reset', { body: { email: 'not-an-email' } }),
      'request_password_reset.invalid_email'
    );
  });

  it('rejects malformed JSON with 422', async () => {
    expectWire(
      await harness.call('request_password_reset', { rawBody: '{not json' }),
      'request_password_reset.malformed_json'
    );
  });
});

describe('POST /v2/reset_password', () => {
  async function requestResetToken(email: string): Promise<string> {
    await harness.call('request_password_reset', { body: { email } });
    return harness.awaitResetToken(email);
  }

  it('sets the new password and kills every prior session', async () => {
    await harness.seedUser({ email: 'amina@example.com', password: PASSWORD });
    const before = await loginAs('amina@example.com');
    const resetToken = await requestResetToken('amina@example.com');

    expectWire(
      await harness.call('reset_password', { body: { reset_token: resetToken, new_password: NEW_PASSWORD } }),
      'reset_password.ok'
    );

    expectWire(
      await harness.call('refresh_token', { body: { refresh_token: before.refresh_token } }),
      'refresh_token.rejected'
    );
    expectWire(
      await harness.call('login', { body: { email: 'amina@example.com', password: PASSWORD } }),
      'login.invalid_credentials'
    );
    await loginAs('amina@example.com', NEW_PASSWORD);
  });

  it('refuses to use a reset token twice', async () => {
    await harness.seedUser({ email: 'amina@example.com', password: PASSWORD });
    const resetToken = await requestResetToken('amina@example.com');
    expectWire(
      await harness.call('reset_password', { body: { reset_token: resetToken, new_password: NEW_PASSWORD } }),
      'reset_password.ok'
    );
    expectWire(
      await harness.call('reset_password', { body: { reset_token: resetToken, new_password: PASSWORD } }),
      'reset_password.invalid_token'
    );
  });

  it('rejects a garbage token with 400', async () => {
    expectWire(
      await harness.call('reset_password', { body: { reset_token: 'not-a-token', new_password: NEW_PASSWORD } }),
      'reset_password.invalid_token'
    );
  });

  it('checks the token before the password strength', async () => {
    expectWire(
      await harness.call('reset_password', { body: { reset_token: 'not-a-token', new_password: WEAK_PASSWORD } }),
      'reset_password.invalid_token'
    );
  });

  it('refuses a weak new password with 400 and keeps the old one', async () => {
    await harness.seedUser({ email: 'amina@example.com', password: PASSWORD });
    const resetToken = await requestResetToken('amina@example.com');
    expectWire(
      await harness.call('reset_password', { body: { reset_token: resetToken, new_password: WEAK_PASSWORD } }),
      'reset_password.weak_password'
    );
    await loginAs('amina@example.com');
  });

  it.each([
    ['reset_password.missing_token', { reset_token: '', new_password: NEW_PASSWORD }],
    ['reset_password.missing_password', { reset_token: 'not-a-token', new_password: '' }],
    ['reset_password.password_too_long', { reset_token: 'not-a-token', new_password: `Aa1!${'x'.repeat(125)}` }],
  ] as const)('validation failure: %s', async (name, body) => {
    expectWire(await harness.call('reset_password', { body }), name);
  });

  it('rejects malformed JSON with 422', async () => {
    expectWire(await harness.call('reset_password', { rawBody: '{not json' }), 'reset_password.malformed_json');
  });
});

describe('client flows, recorded as sequences', () => {
  // legacy/frontend-app ApiService.fetchWithAuthRetry: a 401 on a bearer call
  // triggers ONE refresh and ONE retry with the new access token.
  it('released mobile cycle: login → bearer call → 401 → refresh → retry', async () => {
    await harness.seedUser({ email: 'amina@example.com', password: PASSWORD });
    const session = await loginAs('amina@example.com');
    expect((await harness.call('threads.get', { token: session.access_token })).status).toBe(200);

    harness.expireAccessToken();
    expectWire(await harness.call('threads.get', { token: session.access_token }), 'bearer.invalid_or_expired');

    const refreshed = expectWire(
      await harness.call('refresh_token', { body: { refresh_token: session.refresh_token } }),
      'refresh_token.ok'
    );
    const retry = await harness.call('threads.get', { token: refreshed.access_token as string });
    expect(retry.status).toBe(200);
    expect(retry.body).toEqual([]);
  });

  // The mobile client has no single-flight guard: two 401s in flight each
  // refresh with the same stored refresh token. Both must succeed.
  it('released mobile cycle: concurrent refreshes with one refresh token all succeed', async () => {
    await harness.seedUser({ email: 'amina@example.com', password: PASSWORD });
    const session = await loginAs('amina@example.com');
    harness.expireAccessToken();

    const results = await Promise.all([
      harness.call('refresh_token', { body: { refresh_token: session.refresh_token } }),
      harness.call('refresh_token', { body: { refresh_token: session.refresh_token } }),
    ]);
    for (const result of results) {
      const pair = expectWire(result, 'refresh_token.ok');
      expect((await harness.call('threads.get', { token: pair.access_token as string })).status).toBe(200);
    }
  });

  // refreshAccessToken: any non-OK refresh removes the tokens and logs out.
  it('released mobile cycle: a revoked session gets a non-OK refresh (the client then logs out)', async () => {
    await harness.seedUser({ email: 'amina@example.com', password: PASSWORD });
    const phone = await loginAs('amina@example.com');
    const laptop = await loginAs('amina@example.com');
    expectWire(await harness.call('logout', { token: laptop.access_token }), 'logout.ok');

    const refresh = await harness.call('refresh_token', { body: { refresh_token: phone.refresh_token } });
    expectWire(refresh, 'refresh_token.rejected');
  });

  // apps/api/src/app/admin/analytics/page.tsx posts to login and sends the
  // `access_token` it reads as the bearer for admin/stats.
  it('admin analytics login: access_token from login authorizes admin/stats for an admin only', async () => {
    await harness.seedUser({ email: 'admin@example.com', password: PASSWORD, admin: true });
    await harness.seedUser({ email: 'member@example.com', password: PASSWORD });

    const admin = await loginAs('admin@example.com');
    expect((await harness.call('admin.stats', { token: admin.access_token })).status).toBe(200);

    const member = await loginAs('member@example.com');
    expectWire(await harness.call('admin.stats', { token: member.access_token }), 'admin.forbidden');
    expectWire(await harness.call('admin.stats'), 'bearer.missing');
  });
});
