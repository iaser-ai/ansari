import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

// Issue #20: threads.ts and feedback.ts helpers take a trailing `exec`
// (Executor) so multi-table writes compose into one transaction. Exercised
// against pglite (like session-version-reuse) — a helper that ignored its
// executor would pass mocked tests but break the atomicity these prove.

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
import {
  createThread,
  createMessage,
  findThreadsByUser,
  findThreadById,
  updateThread,
  deleteThread,
  findMessagesByThread,
  findMessageById,
  findMessageInOwnedThread,
  getThreadWithMessages,
} from '@/lib/db/threads';
import { createFeedback, findFeedbackByMessage } from '@/lib/db/feedback';

let client: PGlite;
let db: ReturnType<typeof drizzle<typeof schema>>;
const USER_ID = '33333333-3333-3333-3333-333333333333';

beforeAll(async () => {
  client = new PGlite();
  db = drizzle(client, { schema });
  h.db = db;
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
      raw_payload jsonb,
      tool_calls jsonb,
      created_at timestamp with time zone DEFAULT now()
    );
    CREATE TABLE feedback (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      thread_id uuid NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      message_id uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      feedback_class text NOT NULL,
      comment text,
      created_at timestamp with time zone DEFAULT now()
    );
  `);
  await client.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3)`, [
    USER_ID,
    'exec@example.com',
    'nologin',
  ]);
});

afterAll(async () => {
  await client.close();
});

async function countRows(table: 'threads' | 'messages' | 'feedback'): Promise<number> {
  const result = await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`);
  return result.rows[0].n;
}

describe('executor threading against a real transaction', () => {
  it('rolls back thread + message + feedback together when the transaction throws', async () => {
    const before = {
      threads: await countRows('threads'),
      messages: await countRows('messages'),
      feedback: await countRows('feedback'),
    };

    await expect(
      db.transaction(async (tx) => {
        const thread = await createThread({ userId: USER_ID, name: 'doomed' }, tx);
        const message = await createMessage(
          { threadId: thread.id, role: 'user', content: [{ type: 'text', text: 'hi' }] },
          tx
        );
        await createFeedback(
          { userId: USER_ID, threadId: thread.id, messageId: message.id, feedbackClass: 'thumbsup' },
          tx
        );
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');

    expect(await countRows('threads')).toBe(before.threads);
    expect(await countRows('messages')).toBe(before.messages);
    expect(await countRows('feedback')).toBe(before.feedback);
  });

  it('commits a composed thread + message + feedback write atomically', async () => {
    const { thread, message } = await db.transaction(async (tx) => {
      const thread = await createThread({ userId: USER_ID, name: 'kept' }, tx);
      const message = await createMessage(
        { threadId: thread.id, role: 'user', content: [{ type: 'text', text: 'salaam' }] },
        tx
      );
      await createFeedback(
        { userId: USER_ID, threadId: thread.id, messageId: message.id, feedbackClass: 'thumbsup' },
        tx
      );
      // Reads through the same executor see the uncommitted writes.
      expect(await findMessageInOwnedThread(message.id, thread.id, USER_ID, tx)).toBeDefined();
      expect((await getThreadWithMessages(thread.id, USER_ID, tx))?.messages).toHaveLength(1);
      return { thread, message };
    });

    expect(await findThreadById(thread.id)).toBeDefined();
    expect(await findMessageById(message.id)).toBeDefined();
    expect(await findFeedbackByMessage(message.id, USER_ID)).toBeDefined();
  });
});

describe('no helper bypasses its executor', () => {
  it('every helper runs against a poisoned global db when an explicit exec is passed', async () => {
    // If any code path inside a helper still closes over the module-level `db`,
    // this getter fires and the test fails loudly.
    const poisoned = new Proxy(
      {},
      {
        get() {
          throw new Error('helper bypassed its exec param and touched the global db');
        },
      }
    );

    const realDb = h.db;
    h.db = poisoned;
    try {
      const thread = await createThread({ userId: USER_ID, name: 'poison-run' }, db);
      const message = await createMessage(
        { threadId: thread.id, role: 'user', content: [{ type: 'text', text: 'x' }] },
        db
      );
      await createFeedback(
        { userId: USER_ID, threadId: thread.id, messageId: message.id, feedbackClass: 'thumbsdown' },
        db
      );

      expect(await findThreadsByUser(USER_ID, db)).not.toHaveLength(0);
      expect(await findThreadById(thread.id, USER_ID, db)).toBeDefined();
      expect(await updateThread(thread.id, USER_ID, { name: 'renamed' }, db)).toBeDefined();
      expect(await findMessagesByThread(thread.id, db)).toHaveLength(1);
      expect(await findMessageById(message.id, thread.id, db)).toBeDefined();
      expect(await findMessageInOwnedThread(message.id, thread.id, USER_ID, db)).toBeDefined();
      expect((await getThreadWithMessages(thread.id, USER_ID, db))?.messages).toHaveLength(1);
      expect(await findFeedbackByMessage(message.id, USER_ID, db)).toBeDefined();
      expect(await deleteThread(thread.id, USER_ID, db)).toBe(true);
    } finally {
      h.db = realDb;
    }
  });

  it('helpers still work standalone (default exec = global db)', async () => {
    const thread = await createThread({ userId: USER_ID, name: 'standalone' });
    expect(await findThreadById(thread.id, USER_ID)).toBeDefined();
    expect(await deleteThread(thread.id, USER_ID)).toBe(true);
  });
});

describe('createMessage bumps thread.updated_at through the same executor', () => {
  it('updates the parent thread inside the transaction', async () => {
    const thread = await createThread({ userId: USER_ID, name: 'bump' });
    const stale = new Date('2020-01-01T00:00:00Z');
    await client.query(`UPDATE threads SET updated_at = $1 WHERE id = $2`, [stale, thread.id]);

    await db.transaction(async (tx) => {
      await createMessage(
        { threadId: thread.id, role: 'user', content: [{ type: 'text', text: 'bump' }] },
        tx
      );
    });

    const after = await findThreadById(thread.id);
    expect(after!.updatedAt!.getTime()).toBeGreaterThan(stale.getTime());
  });
});
