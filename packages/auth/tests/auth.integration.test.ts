// Integration test for the Better Auth wiring, exercised against a REAL
// Postgres-compatible database (pglite in-process), not mocks — per
// lessons-critical: a helper that no-ops against a mock passes every test while
// committing nothing. This drives the actual sign-up → sign-in → session →
// sign-out path and asserts on real rows.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';

import { createAuth, schema, type Auth, type Db } from '../src/index';

// The generated migration IS the artifact under test — apply the exact SQL a
// deploy would, so the test fails if the migration and the schema ever diverge.
const migrationSql = readFileSync(
  fileURLToPath(new URL('../drizzle/0000_better_auth_init.sql', import.meta.url)),
  'utf8'
);

let client: PGlite;
let auth: Auth;
let db: ReturnType<typeof drizzle>;

const testUser = {
  name: 'Test User',
  email: 'test@example.com',
  password: 'correct-horse-battery-staple',
};

beforeAll(async () => {
  // createAuth() reads env via getEnv(); set a valid, fake env before it runs.
  process.env.DATABASE_URL = 'postgres://test:test@localhost:5432/test';
  process.env.BETTER_AUTH_SECRET = 'test-secret-at-least-32-characters-long-000';
  process.env.BETTER_AUTH_URL = 'http://localhost:3100';
  process.env.CORS_ORIGIN = 'http://localhost:3100';
  process.env.NODE_ENV = 'test';

  client = new PGlite();
  // `--> statement-breakpoint` lines are SQL comments (`--`), so pglite ignores
  // them; the whole file runs as one multi-statement exec.
  await client.exec(migrationSql);

  db = drizzle(client, { schema });
  auth = createAuth(db as unknown as Db);
});

afterAll(async () => {
  await client?.close();
});

describe('Better Auth email/password over a real database', () => {
  it('sign-up creates exactly one row in "user"', async () => {
    const result = await auth.api.signUpEmail({ body: testUser });
    expect(result.user.email).toBe(testUser.email);

    const users = await db.select().from(schema.user);
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
