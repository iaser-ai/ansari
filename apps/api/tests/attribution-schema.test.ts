import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

// Round-trip tests for the spec-56 per-client attribution columns:
//   threads.client, messages.client, users.registered_via
//
// These exercise the real createThread / createMessage / createUser SQL against
// an in-memory Postgres (pglite), following the tests/token-grace.test.ts
// pattern. The production DATABASE_URL is never touched.
//
// The hand-written CREATE TABLE DDL below MUST stay in sync with db/schema/*.ts
// (the repo's pglite tests hand-write DDL); the new columns are included here.
const h = vi.hoisted(() => ({ db: null as unknown }));

vi.mock('@/lib/db/index', () => ({
  get db() {
    return h.db;
  },
  closeDb: async () => {},
}));

import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import * as schema from '@/db/schema';
import { createThread, createMessage } from '@/lib/db/threads';
import { createUser } from '@/lib/db/users';

let client: PGlite;
let seq = 0;
const email = () => `u${seq++}@example.com`;

beforeAll(async () => {
  client = new PGlite();
  h.db = drizzle(client, { schema });
  await client.exec(`
    CREATE TABLE users (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      email text UNIQUE NOT NULL,
      password_hash text NOT NULL,
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
    CREATE TABLE messages (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      thread_id uuid NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      role text NOT NULL,
      content jsonb NOT NULL,
      agent_name text,
      source text DEFAULT 'web',
      client text,
      input_tokens integer,
      output_tokens integer,
      thinking_tokens integer,
      total_tokens integer,
      created_at timestamp with time zone DEFAULT now()
    );
  `);
});

afterAll(async () => {
  await client.close();
});

describe('per-client attribution columns (spec 56)', () => {
  it('createUser persists registered_via when provided', async () => {
    const user = await createUser({ email: email(), passwordHash: 'x', registeredVia: 'muslimpedia' });
    expect(user.registeredVia).toBe('muslimpedia');
  });

  it('createUser defaults registered_via to NULL when omitted', async () => {
    const user = await createUser({ email: email(), passwordHash: 'x' });
    expect(user.registeredVia).toBeNull();
  });

  it('createThread persists client when provided', async () => {
    const user = await createUser({ email: email(), passwordHash: 'x' });
    const thread = await createThread({ userId: user.id, client: 'muslimpedia' });
    expect(thread.client).toBe('muslimpedia');
  });

  it('createThread defaults client to NULL when omitted', async () => {
    const user = await createUser({ email: email(), passwordHash: 'x' });
    const thread = await createThread({ userId: user.id });
    expect(thread.client).toBeNull();
  });

  it("createThread stores the 'invalid' sentinel like any other value", async () => {
    const user = await createUser({ email: email(), passwordHash: 'x' });
    const thread = await createThread({ userId: user.id, client: 'invalid' });
    expect(thread.client).toBe('invalid');
  });

  it('createMessage persists client when provided', async () => {
    const user = await createUser({ email: email(), passwordHash: 'x' });
    const thread = await createThread({ userId: user.id });
    const msg = await createMessage({
      threadId: thread.id,
      role: 'user',
      content: [{ type: 'text', text: 'hi' }],
      source: 'web',
      client: 'muslimpedia',
    });
    expect(msg.client).toBe('muslimpedia');
  });

  it('createMessage defaults client to NULL when omitted', async () => {
    const user = await createUser({ email: email(), passwordHash: 'x' });
    const thread = await createThread({ userId: user.id });
    const msg = await createMessage({
      threadId: thread.id,
      role: 'assistant',
      content: [{ type: 'text', text: 'yo' }],
      source: 'web',
    });
    expect(msg.client).toBeNull();
  });

  it('leaves existing source semantics untouched', async () => {
    const user = await createUser({ email: email(), passwordHash: 'x', source: 'web', registeredVia: 'kalimat' });
    const thread = await createThread({ userId: user.id, source: 'web', client: 'kalimat' });
    expect(user.source).toBe('web');
    expect(thread.source).toBe('web');
    expect(thread.client).toBe('kalimat');
  });
});
