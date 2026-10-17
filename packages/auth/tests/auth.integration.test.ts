// Integration test for the Better Auth wiring, exercised against a REAL
// Postgres-compatible database (pglite in-process), not mocks — per
// lessons-critical: a helper that no-ops against a mock passes every test while
// committing nothing. This drives the actual sign-up → sign-in → session →
// sign-out path and asserts on real rows.
import type { PGlite } from '@electric-sql/pglite';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';

import { createAuth, schema, type Auth, type Db } from '../src/index';
import { drizzleFor, migrate, setAuthEnv } from './helpers/auth-db';

let client: PGlite;
let auth: Auth;
let db: Db;

const testUser = {
  name: 'Test User',
  email: 'test@example.com',
  password: 'correct-horse-battery-staple',
};

beforeAll(async () => {
  // createAuth() reads env via getEnv(); set a valid, fake env before it runs.
  setAuthEnv('http://localhost:3100');

  // The migration journal IS the artifact under test: apply the exact SQL a
  // deploy would, so the test fails if the migration and the schema diverge.
  client = await migrate();
  db = drizzleFor(client);
  auth = createAuth(db);
});

afterAll(async () => {
  await client?.close();
});

describe('Better Auth email/password over a real database', () => {
  it('sign-up creates exactly one row in auth.users', async () => {
    const result = await auth.api.signUpEmail({ body: testUser });
    expect(result.user.email).toBe(testUser.email);

    const users = await db.select().from(schema.users);
    expect(users).toHaveLength(1);
    expect(users[0]?.email).toBe(testUser.email);
  });

  it('sign-in adds a row to "session" and returns a session cookie', async () => {
    // Better Auth auto-signs-in on sign-up, so a session already exists; assert
    // sign-in ADDS one rather than asserting an absolute count.
    const before = await db.select().from(schema.session);

    const response = await auth.api.signInEmail({
      body: { email: testUser.email, password: testUser.password },
      asResponse: true,
    });
    expect(response.status).toBe(200);

    const setCookie = response.headers.get('set-cookie');
    expect(setCookie).toBeTruthy();
    expect(setCookie).toContain('better-auth.session_token');

    const after = await db.select().from(schema.session);
    expect(after.length).toBe(before.length + 1);
  });

  it('an authenticated getSession resolves the signed-in user from the cookie', async () => {
    const signIn = await auth.api.signInEmail({
      body: { email: testUser.email, password: testUser.password },
      asResponse: true,
    });
    const cookie = signIn.headers.get('set-cookie') ?? '';

    const sessionData = await auth.api.getSession({
      headers: new Headers({ cookie }),
    });
    expect(sessionData?.user.email).toBe(testUser.email);
  });

  it('sign-out invalidates the session', async () => {
    const signIn = await auth.api.signInEmail({
      body: { email: testUser.email, password: testUser.password },
      asResponse: true,
    });
    const cookie = signIn.headers.get('set-cookie') ?? '';
    const headers = new Headers({ cookie });

    const sessionsBefore = await db.select().from(schema.session);
    expect(sessionsBefore.length).toBeGreaterThan(0);

    await auth.api.signOut({ headers });

    const after = await auth.api.getSession({ headers });
    expect(after).toBeNull();
  });
});
