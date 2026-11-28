import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ db: null as unknown }));

vi.mock('@/lib/db/index', () => ({
  get db() {
    return h.db;
  },
  closeDb: async () => {},
}));

import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';

import * as schema from '@/db/schema';
import {
  createMessageIfThreadExists,
  getOrCreateThreadWithUserMessage,
} from '@/lib/db/threads';
import { insertAppUserRow } from '@/lib/db/users';

const POSTGRES_TEST_URL = process.env.POSTGRES_TEST_URL;
const DRIZZLE_DIR = fileURLToPath(new URL('../drizzle/', import.meta.url));
const journal = (
  JSON.parse(readFileSync(`${DRIZZLE_DIR}meta/_journal.json`, 'utf8')) as {
    entries: { tag: string }[];
  }
).entries;

let pool: Pool | undefined;
const testUserIds: string[] = [];

function getPool(): Pool {
  if (!pool) throw new Error('PostgreSQL test pool was not initialized');
  return pool;
}

describe.skipIf(!POSTGRES_TEST_URL)('WhatsApp thread lifecycle with concurrent PostgreSQL requests', () => {
  beforeAll(async () => {
    const client = new Pool({ connectionString: POSTGRES_TEST_URL, max: 10 });
    pool = client;
    for (const { tag } of journal) {
      const migration = readFileSync(`${DRIZZLE_DIR}${tag}.sql`, 'utf8');
      for (const statement of migration.split('--> statement-breakpoint')) {
        if (statement.trim()) await client.query(statement);
      }
    }
    h.db = drizzle(client, { schema });
  });

  afterEach(async () => {
    if (!pool) return;
    for (const userId of testUserIds.splice(0)) {
      await pool.query('DELETE FROM threads WHERE user_id = $1', [userId]);
      await pool.query('DELETE FROM users WHERE id = $1', [userId]);
    }
  });

  afterAll(async () => {
    if (pool) await pool.end();
    h.db = null;
  });

  async function createUser(): Promise<string> {
    getPool();
    const userId = randomUUID();
    testUserIds.push(userId);
    await insertAppUserRow({
      id: userId,
      email: `${userId}@thread-lifecycle.test`,
      firstName: 'Concurrent',
      lastName: 'Request',
      registeredVia: 'askansari-whatsapp',
    });
    return userId;
  }

  it('serializes simultaneous first messages onto one thread with both messages retained', async () => {
    const client = getPool();
    const userId = await createUser();

    await client.query(`
      CREATE FUNCTION test_delay_thread_insert() RETURNS trigger AS $$
      BEGIN
        PERFORM pg_sleep(0.2);
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER test_delay_thread_insert
      BEFORE INSERT ON threads
      FOR EACH ROW EXECUTE FUNCTION test_delay_thread_insert();
    `);

    try {
      const [first, second] = await Promise.all([
        getOrCreateThreadWithUserMessage(userId, 'whatsapp', 3, {
          role: 'user',
          content: [{ type: 'text', text: 'first simultaneous question' }],
          source: 'whatsapp',
        }),
        getOrCreateThreadWithUserMessage(userId, 'whatsapp', 3, {
          role: 'user',
          content: [{ type: 'text', text: 'second simultaneous question' }],
          source: 'whatsapp',
        }),
      ]);

      expect(first.thread.id).toBe(second.thread.id);
      expect(first.history.some((message) => message.id === first.message.id)).toBe(true);
      expect(second.history.some((message) => message.id === second.message.id)).toBe(true);

      const { rows } = await client.query<{ threads: number; messages: number }>(
        `SELECT
          (SELECT count(*)::int FROM threads WHERE user_id = $1 AND source = 'whatsapp') AS threads,
          (SELECT count(*)::int FROM messages WHERE thread_id IN (SELECT id FROM threads WHERE user_id = $1)) AS messages`,
        [userId],
      );
      expect(rows[0]).toEqual({ threads: 1, messages: 2 });
    } finally {
      await client.query('DROP TRIGGER test_delay_thread_insert ON threads');
      await client.query('DROP FUNCTION test_delay_thread_insert()');
    }
  });

  it('does not save an answer after expiry replaces its thread during generation', async () => {
    const client = getPool();
    const userId = await createUser();
    const original = await getOrCreateThreadWithUserMessage(userId, 'whatsapp', 3, {
      role: 'user',
      content: [{ type: 'text', text: 'question being answered' }],
      source: 'whatsapp',
    });

    const replacement = await getOrCreateThreadWithUserMessage(userId, 'whatsapp', 0, {
      role: 'user',
      content: [{ type: 'text', text: 'new conversation' }],
      source: 'whatsapp',
    });
    const staleAnswer = await createMessageIfThreadExists(
      {
        threadId: original.thread.id,
        role: 'assistant',
        content: [{ type: 'text', text: 'answer from the replaced conversation' }],
        source: 'whatsapp',
      },
      userId,
    );

    expect(replacement.thread.id).not.toBe(original.thread.id);
    expect(staleAnswer).toBeUndefined();
    const { rows } = await client.query<{ threads: number; stale_answers: number }>(
      `SELECT
        (SELECT count(*)::int FROM threads WHERE user_id = $1 AND source = 'whatsapp') AS threads,
        (SELECT count(*)::int FROM messages WHERE role = 'assistant' AND thread_id = $2) AS stale_answers`,
      [userId, original.thread.id],
    );
    expect(rows[0]).toEqual({ threads: 1, stale_answers: 0 });
  });
});
