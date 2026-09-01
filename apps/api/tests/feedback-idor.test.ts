import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

// Spec 4 Phase 8: findMessageInOwnedThread must resolve a message ONLY when its
// thread belongs to the caller. Exercised against pglite so the real owner-scoped
// join is verified (a mocked test could not prove the SQL scopes by user).

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
import { findMessageInOwnedThread } from '@/lib/db/threads';

let client: PGlite;

const OWNER_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ID = '22222222-2222-4222-8222-222222222222';
const THREAD_ID = '33333333-3333-4333-8333-333333333333';
const MESSAGE_ID = '44444444-4444-4444-8444-444444444444';

beforeAll(async () => {
  client = new PGlite();
  h.db = drizzle(client, { schema });
  await client.exec(`
    CREATE TABLE users (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      email text UNIQUE NOT NULL,
      password_hash text NOT NULL,
      first_name text, last_name text, source text DEFAULT 'web', registered_via text,
      is_admin boolean NOT NULL DEFAULT false, system_key text, session_version integer NOT NULL DEFAULT 0,
      created_at timestamp with time zone DEFAULT now(), updated_at timestamp with time zone DEFAULT now()
    );
    CREATE TABLE threads (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name text, source text DEFAULT 'web', client text,
      created_at timestamp with time zone DEFAULT now(), updated_at timestamp with time zone DEFAULT now()
    );
    CREATE TABLE messages (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      thread_id uuid NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      role text NOT NULL, content jsonb NOT NULL, agent_name text, source text DEFAULT 'web', client text,
      input_tokens integer, output_tokens integer, thinking_tokens integer, total_tokens integer, raw_payload jsonb, tool_calls jsonb, model_provider text, model_id text,
      created_at timestamp with time zone DEFAULT now()
    );
  `);
  await client.query(`INSERT INTO users (id, email, password_hash) VALUES ($1,'owner@x.com','h'),($2,'other@x.com','h')`, [OWNER_ID, OTHER_ID]);
  // Thread owned by OWNER, with one message.
  await client.query(`INSERT INTO threads (id, user_id) VALUES ($1, $2)`, [THREAD_ID, OWNER_ID]);
  await client.query(`INSERT INTO messages (id, thread_id, role, content) VALUES ($1, $2, 'assistant', '[]'::jsonb)`, [MESSAGE_ID, THREAD_ID]);
});

afterAll(async () => {
  await client.close();
});

describe('findMessageInOwnedThread (owner-scoped)', () => {
  it('resolves the message for its owner', async () => {
    const m = await findMessageInOwnedThread(MESSAGE_ID, THREAD_ID, OWNER_ID);
    expect(m?.id).toBe(MESSAGE_ID);
  });

  it('returns undefined for a DIFFERENT user (cross-user IDOR blocked)', async () => {
    expect(await findMessageInOwnedThread(MESSAGE_ID, THREAD_ID, OTHER_ID)).toBeUndefined();
  });

  it('returns undefined for a nonexistent message', async () => {
    expect(
      await findMessageInOwnedThread('99999999-9999-4999-8999-999999999999', THREAD_ID, OWNER_ID)
    ).toBeUndefined();
  });

  it('returns undefined when the message does not belong to the given thread', async () => {
    expect(
      await findMessageInOwnedThread(MESSAGE_ID, '88888888-8888-4888-8888-888888888888', OWNER_ID)
    ).toBeUndefined();
  });
});
