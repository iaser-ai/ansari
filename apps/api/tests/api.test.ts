import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

// Real route test for the public share endpoint, exercised against an
// in-memory Postgres (pglite), via vi.mock('@/lib/db/index'). (Login moved to
// apps/auth in spec 300; the layer suites and the contract suite cover it.)
// The production DATABASE_URL is never touched. These replace the previous vacuous cases that asserted on object
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
import { GET as shareGET } from '../src/app/api/v2/share/[id]/route';

let client: PGlite;

const USER_ID = '11111111-1111-1111-1111-111111111111';
const THREAD_ID = '22222222-2222-2222-2222-222222222222';
const SHARE_ID = '33333333-3333-3333-3333-333333333333';
const MISSING_SHARE_ID = '44444444-4444-4444-4444-444444444444';

beforeAll(async () => {
  // `config` validates the whole env on first access — set every required var.
  process.env.DATABASE_URL = 'postgresql://placeholder:placeholder@localhost:5432/placeholder';
  process.env.KALEMAT_API_KEY = 'placeholder';
  process.env.USUL_API_TOKEN = 'placeholder';

  client = new PGlite();
  h.db = drizzle(client, { schema });

  // Minimal DDL for exactly the tables this route touches; users as after the
  // window migration (0011: password_hash nullable). The shares FK to
  // threads (and threads FK to users) is declared here on purpose so the seed
  // path has to satisfy it — matching production, where shares.thread_id is a
  // NOT NULL FK.
  await client.exec(`
    CREATE TABLE users (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      email text UNIQUE NOT NULL,
      password_hash text,
      first_name text,
      last_name text,
      source text DEFAULT 'web',
      registered_via text,
      is_admin boolean NOT NULL DEFAULT false,
      system_key text,
      session_version integer NOT NULL DEFAULT 0,
      created_at timestamp with time zone DEFAULT now(),
      updated_at timestamp with time zone DEFAULT now()
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

  // An app row as spec 300 writes it: no credential.
  await client.query(
    `INSERT INTO users (id, email, first_name, last_name) VALUES ($1, $2, $3, $4)`,
    [USER_ID, 'test@example.com', 'Test', 'User']
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
