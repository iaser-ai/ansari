import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

// Real route tests for the two highest-value public/auth endpoints, exercised
// against an in-memory Postgres (pglite) via the same vi.mock('@/lib/db/index')
// pattern as tests/token-grace.test.ts. The production DATABASE_URL is never
// touched. These replace the previous vacuous cases that asserted on object
// literals they constructed in-test (which could never fail).
const h = vi.hoisted(() => ({ db: null as unknown }));

vi.mock('@/lib/db/index', () => ({
  get db() {
    return h.db;
  },
  closeDb: async () => {},
}));

import { NextRequest } from 'next/server';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import * as schema from '@/db/schema';
import { hashPassword } from '@/lib/auth/password';
import { POST as loginPOST } from '../src/app/api/v2/users/login/route';
import { GET as shareGET } from '../src/app/api/v2/share/[id]/route';

let client: PGlite;

const USER_ID = '11111111-1111-1111-1111-111111111111';
const THREAD_ID = '22222222-2222-2222-2222-222222222222';
const SHARE_ID = '33333333-3333-3333-3333-333333333333';
const MISSING_SHARE_ID = '44444444-4444-4444-4444-444444444444';
const PASSWORD = 'Correct-Horse-Battery-9';

beforeAll(async () => {
  process.env.JWT_SECRET = 'test-secret-key-for-testing-purposes-only-32chars';

  client = new PGlite();
  h.db = drizzle(client, { schema });

  // Minimal DDL for exactly the tables these two routes touch. The shares FK to
  // threads (and threads FK to users) is declared here on purpose so the seed
  // path has to satisfy it — matching production, where shares.thread_id is a
  // NOT NULL FK.
  await client.exec(`
    CREATE TABLE users (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      email text UNIQUE NOT NULL,
      password_hash text NOT NULL,
      first_name text,
      last_name text,
      source text DEFAULT 'web',
      registered_via text,
      created_at timestamp with time zone DEFAULT now(),
      updated_at timestamp with time zone DEFAULT now()
    );
    CREATE TABLE tokens (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_type text NOT NULL,
      token_hash text NOT NULL,
      expires_at timestamp with time zone NOT NULL,
      rotated_at timestamp with time zone,
      created_at timestamp with time zone DEFAULT now()
    );
    CREATE TABLE threads (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name text,
      source text DEFAULT 'web',
      client text,
      created_at timestamp with time zone DEFAULT now(),
      updated_at timestamp with time zone DEFAULT now()
    );
    CREATE TABLE shares (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      thread_id uuid NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      content jsonb NOT NULL,
      created_at timestamp with time zone DEFAULT now()
    );
  `);

  // Seed a user with a real bcrypt hash so the route's verifyPassword runs for real.
  await client.query(
    `INSERT INTO users (id, email, password_hash, first_name, last_name)
     VALUES ($1, $2, $3, $4, $5)`,
    [USER_ID, 'test@example.com', await hashPassword(PASSWORD), 'Test', 'User']
  );

  // Seed users -> threads -> shares in FK order.
  await client.query(`INSERT INTO threads (id, user_id, name) VALUES ($1, $2, $3)`, [
    THREAD_ID,
    USER_ID,
    'My shared thread',
  ]);
  const snapshot = {
    threadName: 'My shared thread',
    messages: [
      {
        role: 'user',
        content: [{ type: 'text', text: 'Assalamu alaikum' }],
        createdAt: new Date(0).toISOString(),
      },
    ],
  };
  await client.query(`INSERT INTO shares (id, thread_id, content) VALUES ($1, $2, $3)`, [
    SHARE_ID,
    THREAD_ID,
    JSON.stringify(snapshot),
  ]);
});

afterAll(async () => {
  await client.close();
});

beforeEach(async () => {
  // Login stores tokens; clear them between tests so counts stay predictable.
  await client.exec('DELETE FROM tokens');
});

function loginRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/v2/users/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/v2/users/login', () => {
  it('returns Ansari-format tokens for valid credentials', async () => {
    const res = await loginPOST(loginRequest({ email: 'test@example.com', password: PASSWORD }));
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.status).toBe('success');
    expect(typeof data.access_token).toBe('string');
    expect(data.access_token.length).toBeGreaterThan(0);
    expect(typeof data.refresh_token).toBe('string');
    expect(data.refresh_token.length).toBeGreaterThan(0);
    expect(data.token_type).toBe('bearer');
    expect(data.first_name).toBe('Test');
    expect(data.last_name).toBe('User');

    // Both tokens are actually persisted (proves the route hit the DB).
    const tokenCount = await client.query<{ count: number }>(
      'SELECT COUNT(*)::int AS count FROM tokens'
    );
    expect(tokenCount.rows[0].count).toBe(2);
  });

  it('rejects a wrong password with a generic 401', async () => {
    const res = await loginPOST(loginRequest({ email: 'test@example.com', password: 'wrong-password' }));
    const data = await res.json();

    expect(res.status).toBe(401);
    expect(data.detail).toBe('Invalid email or password');
  });

  it('rejects an unknown email with the same generic 401 (no user enumeration)', async () => {
    const res = await loginPOST(loginRequest({ email: 'nobody@example.com', password: PASSWORD }));
    const data = await res.json();

    expect(res.status).toBe(401);
    expect(data.detail).toBe('Invalid email or password');
  });

  it('returns 422 for a malformed body', async () => {
    const res = await loginPOST(loginRequest({ email: 'not-an-email', password: '' }));
    expect(res.status).toBe(422);
  });
});

describe('GET /api/v2/share/[id] (public)', () => {
  function shareContext(id: string) {
    return { params: Promise.resolve({ id }) };
  }
  const req = new NextRequest('http://localhost/api/v2/share/x');

  it('returns the snapshot for an existing share', async () => {
    const res = await shareGET(req, shareContext(SHARE_ID));
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.id).toBe(SHARE_ID);
    expect(data.thread_name).toBe('My shared thread');
    expect(Array.isArray(data.messages)).toBe(true);
    expect(data.messages).toHaveLength(1);
    expect(data.messages[0].role).toBe('user');
    // A single text block is collapsed to a plain string by the route.
    expect(data.messages[0].content).toBe('Assalamu alaikum');
    expect(data.created_at).toBeDefined();
  });

  it('returns 404 for a missing share', async () => {
    const res = await shareGET(req, shareContext(MISSING_SHARE_ID));
    const data = await res.json();

    expect(res.status).toBe(404);
    expect(data.detail).toBe('Share not found');
  });
});
