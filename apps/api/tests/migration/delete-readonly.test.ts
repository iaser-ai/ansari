import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

// Issue #131: delete-readonly against pglite with the current DDL (the original suite
// mocked the Drizzle call chain). Same five cases as the original, plus the cascade
// of a `feedback` row hanging off a legacy message.

const h = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('@/lib/db/index', () => ({
  get db() {
    return h.db;
  },
  closeDb: async () => {},
}));

import type { PGlite } from '@electric-sql/pglite';
import { mkdtemp, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { createMigrationDb, count, FAKE_BCRYPT_HASH, type MigrationDb } from './pglite';
import { deleteReadonly } from '../../scripts/migrate-users/target/delete-readonly';

let client: PGlite;
let db: MigrationDb;
let mappingPath: string;

// Fixture:
//   mapped@example.com    — created by the migration (in mapping file); only legacy threads
//   active@example.com    — in mapping file, but also has a live (source='web') thread
//   unmapped@example.com  — legacy threads, NOT in the mapping file (pre-existing account)
const ids = { mapped: '', active: '', unmapped: '' };

async function seedUser(email: string): Promise<string> {
  const r = await client.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id`,
    [email, FAKE_BCRYPT_HASH]
  );
  return r.rows[0].id;
}

async function seedThread(userId: string, source: string, messageCount: number): Promise<string> {
  const t = await client.query<{ id: string }>(
    `INSERT INTO threads (user_id, name, source) VALUES ($1, $2, $2) RETURNING id`,
    [userId, source]
  );
  for (let i = 0; i < messageCount; i++) {
    await client.query(
      `INSERT INTO messages (thread_id, role, content, source) VALUES ($1, 'user', '[{"type":"text","text":"m"}]', $2)`,
      [t.rows[0].id, source]
    );
  }
  return t.rows[0].id;
}

async function writeMapping(entries: object[]) {
  await writeFile(mappingPath, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
}

beforeAll(async () => {
  ({ client, db } = await createMigrationDb());
  h.db = db;
});

afterAll(async () => {
  await client.close();
});

beforeEach(async () => {
  await client.exec(`DELETE FROM feedback; DELETE FROM messages; DELETE FROM threads; DELETE FROM users;`);
  mappingPath = join(await mkdtemp(join(tmpdir(), 'delete-readonly-')), 'mapping.jsonl');
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});

  ids.mapped = await seedUser('mapped@example.com');
  await seedThread(ids.mapped, 'legacy', 3);
  await seedThread(ids.mapped, 'legacy', 2);

  ids.active = await seedUser('active@example.com');
  await seedThread(ids.active, 'legacy', 2);
  await seedThread(ids.active, 'web', 1);

  ids.unmapped = await seedUser('unmapped@example.com');
  await seedThread(ids.unmapped, 'legacy', 3);
});

describe('deleteReadonly (pglite)', () => {
  it('deletes legacy messages and threads in bulk mode (no mapping file → accounts preserved)', async () => {
    const result = await deleteReadonly({ mappingFile: mappingPath });

    expect(result.messagesDeleted).toBe(10);
    expect(result.threadsDeleted).toBe(4);
    expect(result.usersDeleted).toBe(0);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('Mapping file not found'));

    expect(await count(client, 'users')).toBe(3);
    // Only the live thread and its message survive.
    const threads = await client.query<{ source: string; user_id: string }>(`SELECT source, user_id FROM threads`);
    expect(threads.rows).toEqual([{ source: 'web', user_id: ids.active }]);
    expect(await count(client, 'messages')).toBe(1);
  });

  it('deletes mapped user with no remaining threads', async () => {
    await writeMapping([
      { type: 'user', mongoId: 'm1', postgresId: ids.mapped, email: 'mapped@example.com' },
    ]);

    const result = await deleteReadonly({ mappingFile: mappingPath });

    expect(result.usersDeleted).toBe(1);
    const emails = await client.query<{ email: string }>(`SELECT email FROM users ORDER BY email`);
    expect(emails.rows.map((r) => r.email)).toEqual(['active@example.com', 'unmapped@example.com']);
  });

  it('preserves mapped user who has non-legacy threads', async () => {
    await writeMapping([
      { type: 'user', mongoId: 'm2', postgresId: ids.active, email: 'active@example.com' },
    ]);

    const result = await deleteReadonly({ mappingFile: mappingPath });

    expect(result.usersDeleted).toBe(0);
    expect(result.usersPreserved).toBe(1);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('non-legacy threads'));
    expect(await count(client, 'users')).toBe(3);
  });

  it('scopes deletion to single user by email', async () => {
    await writeMapping([
      { type: 'user', mongoId: 'm1', postgresId: ids.mapped, email: 'mapped@example.com' },
    ]);

    const result = await deleteReadonly({ email: 'mapped@example.com', mappingFile: mappingPath });

    expect(result.messagesDeleted).toBe(5);
    expect(result.threadsDeleted).toBe(2);
    expect(result.usersDeleted).toBe(1);

    // Other accounts and ALL their rows untouched.
    const others = await client.query<{ email: string }>(`SELECT email FROM users ORDER BY email`);
    expect(others.rows.map((r) => r.email)).toEqual(['active@example.com', 'unmapped@example.com']);
    expect(await count(client, 'threads')).toBe(3);
    expect(await count(client, 'messages')).toBe(6);
  });

  it('scoped: preserves an account that is not in the mapping file', async () => {
    await writeMapping([]);
    const result = await deleteReadonly({ email: 'unmapped@example.com', mappingFile: mappingPath });

    expect(result.threadsDeleted).toBe(1);
    expect(result.usersDeleted).toBe(0);
    expect(result.usersPreserved).toBe(1);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('not found in mapping file'));
    expect(await count(client, 'users')).toBe(3);
  });

  it('returns empty result when scoped user not found', async () => {
    const result = await deleteReadonly({ email: 'nonexistent@example.com', mappingFile: mappingPath });

    expect(result).toEqual({ messagesDeleted: 0, threadsDeleted: 0, usersDeleted: 0, usersPreserved: 0 });
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('No user found'));
    expect(await count(client, 'threads')).toBe(5);
  });

  it('removes feedback on legacy messages by cascade (table the script never writes)', async () => {
    const legacy = await client.query<{ id: string; thread_id: string }>(
      `SELECT m.id, m.thread_id FROM messages m JOIN threads t ON t.id = m.thread_id
        WHERE t.user_id = $1 AND m.source = 'legacy' LIMIT 1`,
      [ids.mapped]
    );
    const live = await client.query<{ id: string; thread_id: string }>(
      `SELECT m.id, m.thread_id FROM messages m WHERE m.source = 'web' LIMIT 1`
    );
    await client.query(
      `INSERT INTO feedback (user_id, thread_id, message_id, feedback_class) VALUES ($1, $2, $3, 'thumbs_up')`,
      [ids.mapped, legacy.rows[0].thread_id, legacy.rows[0].id]
    );
    await client.query(
      `INSERT INTO feedback (user_id, thread_id, message_id, feedback_class) VALUES ($1, $2, $3, 'thumbs_up')`,
      [ids.active, live.rows[0].thread_id, live.rows[0].id]
    );
    expect(await count(client, 'feedback')).toBe(2);

    await deleteReadonly({ mappingFile: mappingPath });

    const remaining = await client.query<{ message_id: string }>(`SELECT message_id FROM feedback`);
    expect(remaining.rows).toEqual([{ message_id: live.rows[0].id }]);
  });
});
