// Sign-up (spec 300, phase 3): the legacy guard order with no oracle
// (validation → reserved/taken → strength → create), name derivation,
// `registered_via` from X-Ansari-Client, the newsletter opt-in, no verification
// email, and the profile-changing routes that stay off.
import { randomUUID } from 'node:crypto';

import type { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { createAuth, EMAIL_TAKEN_MESSAGE, schema, type Auth, type Db } from '../../src/index';
import { drizzleFor, migrate, setAuthEnv, TEST_ADMIN_EMAIL } from '../helpers/auth-db';
import { BASE, call, insertLegacyUser, json, signIn } from '../helpers/http';

let client: PGlite;
let db: Db;
let auth: Auth;

const STRONG = 'Sign-Up-Passw0rd!';
const WEAK = 'aaaaaaaa';

beforeAll(async () => {
  setAuthEnv(BASE);
  client = await migrate();
  db = drizzleFor(client);
  auth = createAuth(db);
  await insertLegacyUser(db, {
    id: randomUUID(),
    email: 'taken@example.com',
    passwordHash: '$2b$12$abcdefghijklmnopqrstuuJ1yJ0wTfT0b8nq0vO4dYQ7xT5uQm6Wy',
  });
});

afterAll(async () => {
  await client?.close();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function signUp(body: Record<string, unknown>, headers?: Record<string, string>) {
  return call(auth, '/sign-up/email', { body, headers });
}

async function userRow(email: string) {
  const [row] = await db.select().from(schema.users).where(eq(schema.users.email, email));
  return row;
}

describe('guard order: validation → reserved/taken → strength', () => {
  it('a taken address gets 409 with the one message', async () => {
    const res = await signUp({ email: 'taken@example.com', password: STRONG, name: 'X' });
    expect(res.status).toBe(409);
    expect((await json(res)).message).toBe(EMAIL_TAKEN_MESSAGE);
  });

  it('a taken address in another case gets the same 409', async () => {
    const res = await signUp({ email: 'Taken@Example.com', password: STRONG, name: 'X' });
    expect(res.status).toBe(409);
  });

  it('a reserved address with a WEAK password gets the identical 409, not the strength 400', async () => {
    const reserved = await signUp({ email: 'ai-skill@system.ansari.chat', password: WEAK, name: 'X' });
    const taken = await signUp({ email: 'taken@example.com', password: WEAK, name: 'X' });
    expect(reserved.status).toBe(409);
    expect(taken.status).toBe(409);
    expect(await reserved.json()).toEqual(await taken.json());
  });

  it.each([
    ['any @system.ansari.chat address', 'anything@system.ansari.chat'],
    ['the system domain in mixed case', 'Leaderboard@SYSTEM.Ansari.Chat'],
  ])('reserves %s, and creates no row', async (_label, email) => {
    const res = await signUp({ email, password: STRONG, name: 'X' });
    expect(res.status).toBe(409);
    expect((await json(res)).message).toBe(EMAIL_TAKEN_MESSAGE);
    expect(await userRow(email.toLowerCase())).toBeUndefined();
  });

  it('an address that would once have been a configured admin registers like any other (no admin list)', async () => {
    const res = await signUp({ email: TEST_ADMIN_EMAIL, password: STRONG, name: 'X' });
    expect(res.status).toBe(200);
    expect((await userRow(TEST_ADMIN_EMAIL))?.role).not.toBe('admin');
  });

  it('an invalid email is refused before the reservation check', async () => {
    const res = await signUp({ email: 'not-an-email', password: STRONG, name: 'X' });
    expect(res.status).toBe(400);
    expect((await json(res)).code).toBe('INVALID_EMAIL');
  });

  it('a too-short password on a reserved address is refused as too short, not 409', async () => {
    const res = await signUp({ email: 'x@system.ansari.chat', password: 'Ab1!', name: 'X' });
    expect(res.status).toBe(400);
    expect((await json(res)).code).toBe('PASSWORD_TOO_SHORT');
  });

  it('a too-long password on a taken address is refused as too long, not 409', async () => {
    const res = await signUp({ email: 'taken@example.com', password: `Aa1!${'x'.repeat(125)}`, name: 'X' });
    expect(res.status).toBe(400);
    expect((await json(res)).code).toBe('PASSWORD_TOO_LONG');
  });

  it('a new address with a weak password gets 400 with the legacy detail, and no row', async () => {
    const res = await signUp({ email: 'weak@example.com', password: WEAK, name: 'X' });
    expect(res.status).toBe(400);
    expect((await json(res)).message).toBe(
      'Password is too weak. Add uppercase letters Add numbers Add special characters'
    );
    expect(await userRow('weak@example.com')).toBeUndefined();
  });

  it('a common pattern is weak even when long and varied enough otherwise', async () => {
    const res = await signUp({ email: 'common@example.com', password: 'Password123', name: 'X' });
    expect(res.status).toBe(400);
    expect((await json(res)).message).toContain('Avoid common patterns');
  });

  it('a new address with a strong password is created', async () => {
    const res = await signUp({ email: 'ok@example.com', password: STRONG, name: 'Ok' });
    expect(res.status).toBe(200);
    expect(await userRow('ok@example.com')).toBeDefined();
  });
});

describe('defence in depth: no path creates a reserved address', () => {
  it('the user create hook refuses a reserved address even past the sign-up guard', async () => {
    const ctx = await auth.$context;
    await expect(
      ctx.internalAdapter.createUser({
        email: 'direct@system.ansari.chat',
        name: 'Direct',
        emailVerified: false,
      })
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(await userRow('direct@system.ansari.chat')).toBeUndefined();
  });
});

describe('names', () => {
  it('stores first_name and last_name, and returns them', async () => {
    const res = await signUp({
      email: 'named@example.com',
      password: STRONG,
      name: 'Given Name',
      first_name: 'Amina',
      last_name: 'Yusuf',
    });
    expect(res.status).toBe(200);
    const { user } = await json<{ user: Record<string, unknown> }>(res);
    expect(user.first_name).toBe('Amina');
    expect(user.last_name).toBe('Yusuf');
    const row = await userRow('named@example.com');
    expect([row?.name, row?.firstName, row?.lastName]).toEqual(['Given Name', 'Amina', 'Yusuf']);
  });

  it.each([
    ['first and last', { first_name: ' Amina ', last_name: 'Yusuf' }, 'derive1@example.com', 'Amina  Yusuf'],
    ['first only', { first_name: 'Amina' }, 'derive2@example.com', 'Amina'],
    ['no names: the email local-part', {}, 'derive3@example.com', 'derive3'],
    ['a blank name and blank parts', { name: '  ', first_name: ' ', last_name: '' }, 'derive4@example.com', 'derive4'],
  ])('derives name when the client sent none (%s)', async (_label, extra, email, expected) => {
    const res = await signUp({ email, password: STRONG, ...extra });
    expect(res.status).toBe(200);
    expect((await userRow(email))?.name).toBe(expected);
  });
});

describe('registered_via (X-Ansari-Client, through the shared parser)', () => {
  it('records the normalized client id', async () => {
    const res = await signUp(
      { email: 'via-web@example.com', password: STRONG, name: 'X' },
      { 'X-Ansari-Client': '  Askansari-Web ' }
    );
    expect(res.status).toBe(200);
    expect((await userRow('via-web@example.com'))?.registeredVia).toBe('askansari-web');
  });

  // The ids apps/frontend sends (apps/frontend/lib/auth/client-id.ts, whose
  // test pins the same three against the shared parser). A value the parser
  // refused would be recorded as `invalid`, silently.
  it.each(['askansari-web', 'askansari-ios', 'askansari-android'])(
    'records the apps/frontend id %s as sent',
    async (id) => {
      const email = `via-${id}@example.com`;
      const res = await signUp({ email, password: STRONG, name: 'X' }, { 'X-Ansari-Client': id });
      expect(res.status).toBe(200);
      expect((await userRow(email))?.registeredVia).toBe(id);
    }
  );

  it('records the sentinel for a malformed header', async () => {
    await signUp(
      { email: 'via-bad@example.com', password: STRONG, name: 'X' },
      { 'X-Ansari-Client': 'bad client!' }
    );
    expect((await userRow('via-bad@example.com'))?.registeredVia).toBe('invalid');
  });

  it('records NULL when the header is absent', async () => {
    await signUp({ email: 'via-none@example.com', password: STRONG, name: 'X' });
    expect((await userRow('via-none@example.com'))?.registeredVia).toBeNull();
  });

  it('a client cannot set registered_via itself', async () => {
    const res = await signUp({
      email: 'via-forged@example.com',
      password: STRONG,
      name: 'X',
      registered_via: 'forged',
    });
    expect(res.status).toBe(400);
    expect(await userRow('via-forged@example.com')).toBeUndefined();
  });
});

describe('newsletter opt-in', () => {
  let newsletterAuth: Auth;
  let newsletterClient: PGlite;

  beforeAll(async () => {
    process.env.MARKETMAKER_URL = 'https://marketmaker.test/subscribe';
    const { resetEnvCache } = await import('../../src/index');
    resetEnvCache();
    newsletterClient = await migrate();
    newsletterAuth = createAuth(drizzleFor(newsletterClient));
    setAuthEnv(BASE);
  });

  afterAll(async () => {
    await newsletterClient?.close();
  });

  function subscribeCalls(spy: ReturnType<typeof vi.spyOn>) {
    return spy.mock.calls.filter(([url]) => String(url) === 'https://marketmaker.test/subscribe');
  }

  it('subscribes when register_to_mail_list is true, with the legacy payload', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 200 }));
    const res = await call(newsletterAuth, '/sign-up/email', {
      body: {
        email: 'optin@example.com',
        password: STRONG,
        first_name: 'Amina',
        last_name: 'Yusuf',
        register_to_mail_list: true,
      },
    });
    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(subscribeCalls(fetchSpy)).toHaveLength(1));
    const [, init] = subscribeCalls(fetchSpy)[0]!;
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({
      email: 'optin@example.com',
      name: 'Amina Yusuf',
      projectSlug: 'ansari',
      interests: ['islamic'],
    });
  });

  it.each([
    ['false', { register_to_mail_list: false }],
    ['absent', {}],
    ['a truthy non-boolean', { register_to_mail_list: 'true' }],
  ])('never subscribes when the opt-in is %s', async (_label, extra) => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 200 }));
    const email = `optout-${randomUUID().slice(0, 8)}@example.com`;
    const res = await call(newsletterAuth, '/sign-up/email', {
      body: { email, password: STRONG, ...extra },
    });
    expect(res.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(subscribeCalls(fetchSpy)).toHaveLength(0);
  });

  it('never subscribes for a refused sign-up', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 200 }));
    const res = await call(newsletterAuth, '/sign-up/email', {
      body: { email: 'weak-optin@example.com', password: WEAK, register_to_mail_list: true },
    });
    expect(res.status).toBe(400);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(subscribeCalls(fetchSpy)).toHaveLength(0);
  });

  it('a failing subscribe does not fail the sign-up, and logs no email', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('optfail@example.com', { status: 500 }));
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await call(newsletterAuth, '/sign-up/email', {
      body: { email: 'optfail@example.com', password: STRONG, register_to_mail_list: true },
    });
    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(errors).toHaveBeenCalled());
    expect(JSON.stringify(errors.mock.calls)).not.toContain('optfail@example.com');
  });
});

describe('no email is sent, and profile-changing routes stay off', () => {
  it('sign-up creates no verification record and has no verification sender (scenario 9i)', async () => {
    const before = await db.select().from(schema.verification);
    await signUp({ email: 'noverify@example.com', password: STRONG, name: 'X' });
    const after = await db.select().from(schema.verification);
    expect(after.length).toBe(before.length);
    expect(auth.options.emailVerification?.sendOnSignUp).toBe(false);
    expect(auth.options.emailVerification?.sendVerificationEmail).toBeUndefined();
    expect(auth.options.emailAndPassword?.requireEmailVerification).toBeUndefined();
  });

  it('a new user signs in at once, unverified', async () => {
    await signUp({ email: 'unverified@example.com', password: STRONG, name: 'X' });
    expect((await signIn(auth, 'unverified@example.com', STRONG)).res.status).toBe(200);
  });

  it('change-email is refused and the email is unchanged', async () => {
    await signUp({ email: 'keepmail@example.com', password: STRONG, name: 'X' });
    const { token } = await signIn(auth, 'keepmail@example.com', STRONG);
    const res = await call(auth, '/change-email', {
      bearer: token,
      body: { newEmail: 'moved@example.com' },
    });
    // disabledPaths answers first (404); changeEmail is also off underneath.
    expect(res.status).toBe(404);
    expect(await userRow('keepmail@example.com')).toBeDefined();
    expect(await userRow('moved@example.com')).toBeUndefined();
  });

  it('delete-user is refused and the user remains', async () => {
    await signUp({ email: 'keepme@example.com', password: STRONG, name: 'X' });
    const { token } = await signIn(auth, 'keepme@example.com', STRONG);
    const res = await call(auth, '/delete-user', { bearer: token, body: {} });
    expect(res.status).toBe(404);
    expect(await userRow('keepme@example.com')).toBeDefined();
  });
});
