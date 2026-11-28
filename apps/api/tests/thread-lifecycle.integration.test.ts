import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ db: null as unknown }));

vi.mock('@/lib/db/index', () => ({
  get db() {
    return h.db;
  },
  closeDb: async () => {},
}));

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';

import * as schema from '@/db/schema';
import {
  createMessageIfThreadExists,
  getOrCreateThread,
  getOrCreateThreadWithUserMessage,
} from '@/lib/db/threads';
import { insertAppUserRow } from '@/lib/db/users';

const DRIZZLE_DIR = fileURLToPath(new URL('../drizzle/', import.meta.url));
const journal = (
  JSON.parse(readFileSync(`${DRIZZLE_DIR}meta/_journal.json`, 'utf8')) as {
    entries: { idx: number; tag: string }[];
  }
).entries;
const USER_ID = '00000000-0000-4000-8000-000000000360';

let client: PGlite;

beforeEach(async () => {
  client = new PGlite();
  for (const { tag } of journal) {
    const sql = readFileSync(`${DRIZZLE_DIR}${tag}.sql`, 'utf8');
    for (const statement of sql.split('--> statement-breakpoint')) {
      if (statement.trim()) await client.exec(statement);
    }
  }
  h.db = drizzle(client, { schema });
  await insertAppUserRow({
    id: USER_ID,
    email: 'thread-lifecycle@example.com',
    firstName: 'Thread',
    lastName: 'Lifecycle',
    registeredVia: 'askansari-whatsapp',
  });
});

afterEach(async () => {
  await client.close();
  h.db = null;
});

describe('getOrCreateThread against PostgreSQL via PGlite', () => {
  it('creates once, reuses within expiry, and replaces after expiry', async () => {
    const first = await getOrCreateThread(USER_ID, 'whatsapp', 3);
    const reused = await getOrCreateThread(USER_ID, 'whatsapp', 3);
    expect(reused.id).toBe(first.id);

    await client.query('UPDATE threads SET updated_at = $1 WHERE id = $2', [
      new Date(Date.now() - 4 * 60 * 60 * 1000),
      first.id,
    ]);

    const replaced = await getOrCreateThread(USER_ID, 'whatsapp', 3);
    expect(replaced.id).not.toBe(first.id);
    const { rows } = await client.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM threads WHERE user_id = $1 AND source = $2',
      [USER_ID, 'whatsapp'],
    );
    expect(rows[0]?.count).toBe('1');
  });

  it('replaces an existing thread when expiry is zero', async () => {
    const first = await getOrCreateThread(USER_ID, 'whatsapp', 3);
    const replaced = await getOrCreateThread(USER_ID, 'whatsapp', 0);

    expect(replaced.id).not.toBe(first.id);
    const { rows } = await client.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM threads WHERE user_id = $1 AND source = $2',
      [USER_ID, 'whatsapp'],
    );
    expect(rows[0]?.count).toBe('1');
  });

  it('creates a new thread and stores the first message in one transaction', async () => {
    const result = await getOrCreateThreadWithUserMessage(USER_ID, 'whatsapp', 3, {
      role: 'user',
      content: [{ type: 'text', text: 'first question' }],
      source: 'whatsapp',
    });

    expect(result.thread.id).toBeDefined();
    expect(result.message.threadId).toBe(result.thread.id);
    expect(result.history.some((message) => message.id === result.message.id)).toBe(true);
    const { rows } = await client.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM messages WHERE thread_id = $1',
      [result.thread.id],
    );
    expect(rows[0]?.count).toBe('1');
  });

  it('does not save a completed answer after its thread has been replaced', async () => {
    const thread = await getOrCreateThread(USER_ID, 'whatsapp', 3);
    await client.query('DELETE FROM threads WHERE id = $1', [thread.id]);

    const answer = await createMessageIfThreadExists(
      {
        threadId: thread.id,
        role: 'assistant',
        content: [{ type: 'text', text: 'Completed answer' }],
        source: 'whatsapp',
      },
      USER_ID,
    );

    expect(answer).toBeUndefined();
    const { rows } = await client.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM messages WHERE thread_id = $1',
      [thread.id],
    );
    expect(rows[0]?.count).toBe('0');
  });
});
