import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

// Issue #131: thread-migrator against pglite with the current DDL (the original suite
// mocked the Drizzle call chain). Same five cases as the original, plus a full-row
// assertion of the columns the port leaves at their defaults (README column inventory).

const h = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('@/lib/db/index', () => ({
  get db() {
    return h.db;
  },
  closeDb: async () => {},
}));

import type { PGlite } from '@electric-sql/pglite';
import { createMigrationDb, count, FAKE_BCRYPT_HASH, type MigrationDb } from './pglite';
import { migrateThreadsForUser } from '../../scripts/migrate-users/target/thread-migrator';
import type { SourceThread } from '../../scripts/migrate-users/types';

let client: PGlite;
let db: MigrationDb;
let userId: string;

const makeThread = (overrides?: Partial<SourceThread>): SourceThread => ({
  mongoId: 'thread-mongo-1',
  name: 'Test Thread',
  messages: [
    { mongoId: 'msg-1', role: 'user', content: 'Hello', createdAt: new Date('2024-01-15T00:00:00Z') },
    { mongoId: 'msg-2', role: 'assistant', content: 'Hi there', createdAt: new Date('2024-01-15T00:00:05Z') },
  ],
  createdAt: new Date('2024-01-15T00:00:00Z'),
  updatedAt: new Date('2024-06-01T00:00:00Z'),
  ...overrides,
});

// Every message filtered: a tool-role message and a tool_use-only block.
const emptyAfterFilter = (): SourceThread['messages'] => [
  { mongoId: 'msg-t', role: 'tool', content: 'tool output', createdAt: null },
  { mongoId: 'msg-u', role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'search', input: {} }], createdAt: null },
];

beforeAll(async () => {
  ({ client, db } = await createMigrationDb());
  h.db = db;
});

afterAll(async () => {
  await client.close();
});

beforeEach(async () => {
  await client.exec(`DELETE FROM messages; DELETE FROM threads; DELETE FROM users;`);
  const r = await client.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ('owner@example.com', $1) RETURNING id`,
    [FAKE_BCRYPT_HASH]
  );
  userId = r.rows[0].id;
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

function run(threads: SourceThread[], dryRun = false) {
  if (dryRun) {
    return migrateThreadsForUser('mongo-user-1', userId, threads, null as never, { dryRun: true });
  }
  return db.transaction((tx) =>
    migrateThreadsForUser('mongo-user-1', userId, threads, tx as never, { dryRun: false })
  );
}

describe('migrateThreadsForUser (pglite)', () => {
  it('inserts thread and messages with correct fields', async () => {
    const result = await run([makeThread()]);

    expect(result.threadsInserted).toBe(1);
    expect(result.messagesInserted).toBe(2);
    expect(result.threadsSkipped).toBe(0);
    expect(result.messagesFiltered).toBe(0);

    const threads = await client.query<{ user_id: string; name: string; source: string; created_at: Date; updated_at: Date }>(
      `SELECT user_id, name, source, created_at, updated_at FROM threads`
    );
    expect(threads.rows).toHaveLength(1);
    expect(threads.rows[0]).toMatchObject({ user_id: userId, name: 'Test Thread', source: 'legacy' });
    // Source timestamps preserved (NOT now()): created_at is the re-run dedup key.
    expect(new Date(threads.rows[0].created_at).toISOString()).toBe('2024-01-15T00:00:00.000Z');
    expect(new Date(threads.rows[0].updated_at).toISOString()).toBe('2024-06-01T00:00:00.000Z');

    const messages = await client.query<{ role: string; content: unknown; agent_name: string | null; source: string }>(
      `SELECT role, content, agent_name, source FROM messages ORDER BY created_at`
    );
    expect(messages.rows).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'Hello' }], agent_name: null, source: 'legacy' },
      { role: 'assistant', content: [{ type: 'text', text: 'Hi there' }], agent_name: null, source: 'legacy' },
    ]);
  });

  it('leaves every post-0003 column at its default (README column inventory)', async () => {
    await run([makeThread()]);

    const thread = await client.query<{ client: string | null }>(`SELECT client FROM threads`);
    expect(thread.rows[0].client).toBeNull();

    const rows = await client.query<Record<string, unknown>>(
      `SELECT client, input_tokens, output_tokens, thinking_tokens, total_tokens,
              raw_payload, tool_calls, model_provider, model_id
         FROM messages`
    );
    expect(rows.rows).toHaveLength(2);
    for (const row of rows.rows) {
      expect(row).toEqual({
        client: null,
        input_tokens: null,
        output_tokens: null,
        thinking_tokens: null,
        total_tokens: null,
        raw_payload: null,
        // NULL, never [] — the schema's "turn invoked no tools" value.
        tool_calls: null,
        model_provider: null,
        model_id: null,
      });
    }
  });

  it('falls back to the thread created_at when a message has none', async () => {
    await run([
      makeThread({
        messages: [{ mongoId: 'msg-x', role: 'user', content: 'no timestamp', createdAt: null }],
      }),
    ]);
    const r = await client.query<{ created_at: Date }>(`SELECT created_at FROM messages`);
    expect(new Date(r.rows[0].created_at).toISOString()).toBe('2024-01-15T00:00:00.000Z');
  });

  it('skips threads where all messages are filtered out', async () => {
    const result = await run([makeThread({ messages: emptyAfterFilter() })]);

    expect(result.threadsInserted).toBe(0);
    expect(result.messagesInserted).toBe(0);
    expect(result.messagesFiltered).toBe(2);
    expect(result.threadsSkipped).toBe(1);
    expect(await count(client, 'threads')).toBe(0);
    expect(await count(client, 'messages')).toBe(0);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('Skipping empty thread'));
  });

  it('collects thread mappings with correct fields', async () => {
    const result = await run([makeThread()]);
    const inserted = await client.query<{ id: string }>(`SELECT id FROM threads`);

    expect(result.threadMappings).toEqual([
      {
        type: 'thread',
        mongoId: 'thread-mongo-1',
        postgresId: inserted.rows[0].id,
        userId,
        messageCount: 2,
      },
    ]);
  });

  it('handles dry-run mode without DB writes', async () => {
    const result = await run([makeThread()], true);

    expect(result.threadsInserted).toBe(1);
    expect(result.messagesInserted).toBe(2);
    expect(result.threadsSkipped).toBe(0);
    // No thread mappings in dry-run (no actual IDs)
    expect(result.threadMappings).toHaveLength(0);
    expect(await count(client, 'threads')).toBe(0);
    expect(await count(client, 'messages')).toBe(0);
  });

  it('handles multiple threads with mixed results', async () => {
    const result = await run([
      makeThread({ mongoId: 'thread-1', name: 'Good Thread' }),
      makeThread({ mongoId: 'thread-2', name: 'Empty Thread', messages: emptyAfterFilter() }),
    ]);

    expect(result.threadsInserted).toBe(1);
    expect(result.threadsSkipped).toBe(1);
    expect(result.messagesInserted).toBe(2);
    expect(result.messagesFiltered).toBe(2);
    expect(result.threadMappings).toHaveLength(1);
    expect(result.threadMappings[0].mongoId).toBe('thread-1');

    const names = await client.query<{ name: string }>(`SELECT name FROM threads`);
    expect(names.rows.map((r) => r.name)).toEqual(['Good Thread']);
  });
});
