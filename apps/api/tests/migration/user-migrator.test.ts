import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

// Issue #131: user-migrator against pglite with the current DDL (the original suite
// mocked the Drizzle call chain). Same four cases as the original — new user, dedup skip,
// existing user, dry-run — plus no-threads skip, atomicity, users-row defaults, and the
// idempotent second run. All cases use the --from-file path (threads embedded in the
// SourceUser), so no Mongo reader is involved.

const h = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('@/lib/db/index', () => ({
  get db() {
    return h.db;
  },
  closeDb: async () => {},
}));

import type { PGlite } from '@electric-sql/pglite';
import { mkdtemp, readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createMigrationDb, count, FAKE_BCRYPT_HASH, type MigrationDb } from './pglite';
import { migrateUser } from '../../scripts/migrate-users/target/user-migrator';
import type { SourceUser, SourceThread } from '../../scripts/migrate-users/types';

let client: PGlite;
let db: MigrationDb;
let mappingPath: string;

const sampleThread = (overrides?: Partial<SourceThread>): SourceThread => ({
  mongoId: 'thread-abc',
  name: 'Sample',
  messages: [{ mongoId: 'msg-1', role: 'user', content: 'hello', createdAt: new Date('2024-02-01T00:00:00Z') }],
  createdAt: new Date('2024-02-01T00:00:00Z'),
  updatedAt: new Date('2024-02-01T00:00:00Z'),
  ...overrides,
});

const makeSourceUser = (overrides?: Partial<SourceUser>): SourceUser => ({
  mongoId: 'mongo-abc',
  email: 'test@example.com',
  passwordHash: FAKE_BCRYPT_HASH,
  firstName: 'Test',
  lastName: 'User',
  source: 'android',
  createdAt: new Date('2024-01-01T00:00:00Z'),
  updatedAt: new Date('2024-06-01T00:00:00Z'),
  threads: [sampleThread()],
  ...overrides,
});

const fromFileOptions = (dryRun = false) => ({ dryRun, outputPath: mappingPath, fromFile: 'fixture.json' });

async function readMapping() {
  const text = await readFile(mappingPath, 'utf-8');
  return text.trim().split('\n').map((l) => JSON.parse(l));
}

beforeAll(async () => {
  ({ client, db } = await createMigrationDb());
  h.db = db;
});

afterAll(async () => {
  await client.close();
});

beforeEach(async () => {
  await client.exec(`DELETE FROM messages; DELETE FROM threads; DELETE FROM users;`);
  mappingPath = join(await mkdtemp(join(tmpdir(), 'migrate-users-')), 'mapping.jsonl');
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('migrateUser (pglite)', () => {
  it('inserts a new user via transaction when email does not exist', async () => {
    const result = await migrateUser(makeSourceUser(), fromFileOptions());

    expect(result.isNew).toBe(true);
    expect(result.skipped).toBe(false);
    expect(result.threadsInserted).toBe(1);
    expect(result.messagesInserted).toBe(1);

    const user = await client.query<{ id: string; email: string; password_hash: string; first_name: string; last_name: string; source: string; created_at: Date; updated_at: Date }>(
      `SELECT id, email, password_hash, first_name, last_name, source, created_at, updated_at FROM users`
    );
    expect(user.rows).toHaveLength(1);
    expect(user.rows[0]).toMatchObject({
      email: 'test@example.com',
      // Hash inserted verbatim, never re-hashed.
      password_hash: FAKE_BCRYPT_HASH,
      first_name: 'Test',
      last_name: 'User',
      source: 'android',
    });
    expect(result.postgresId).toBe(user.rows[0].id);
    expect(new Date(user.rows[0].created_at).toISOString()).toBe('2024-01-01T00:00:00.000Z');
    expect(new Date(user.rows[0].updated_at).toISOString()).toBe('2024-06-01T00:00:00.000Z');

    const threads = await client.query<{ id: string; source: string }>(`SELECT id, source FROM threads`);
    expect(threads.rows).toHaveLength(1);
    expect(threads.rows[0].source).toBe('legacy');

    // Mapping written AFTER commit: user entry then thread entry, with the real ids.
    expect(await readMapping()).toEqual([
      { type: 'user', mongoId: 'mongo-abc', postgresId: user.rows[0].id, email: 'test@example.com' },
      { type: 'thread', mongoId: 'thread-abc', postgresId: threads.rows[0].id, userId: user.rows[0].id, messageCount: 1 },
    ]);
  });

  it('leaves every post-0003 users column at its default (README column inventory)', async () => {
    await migrateUser(makeSourceUser(), fromFileOptions());
    const r = await client.query<Record<string, unknown>>(
      `SELECT registered_via, is_admin, system_key, session_version FROM users`
    );
    expect(r.rows[0]).toEqual({
      registered_via: null,
      is_admin: false,
      system_key: null,
      session_version: 0,
    });
  });

  it("defaults a null source to 'web'", async () => {
    await migrateUser(makeSourceUser({ source: null }), fromFileOptions());
    const r = await client.query<{ source: string }>(`SELECT source FROM users`);
    expect(r.rows[0].source).toBe('web');
  });

  it('skips user whose threads are already migrated (dedup by timestamp)', async () => {
    // Existing account with one legacy thread at the same created_at as the source thread.
    const existing = await client.query<{ id: string }>(
      `INSERT INTO users (email, password_hash) VALUES ('test@example.com', $1) RETURNING id`,
      [FAKE_BCRYPT_HASH]
    );
    await client.query(
      `INSERT INTO threads (user_id, name, source, created_at, updated_at) VALUES ($1, 'old', 'legacy', $2, $2)`,
      [existing.rows[0].id, '2024-01-01T00:00:00Z']
    );

    const alreadyMigrated = sampleThread({
      mongoId: 'thread-old',
      createdAt: new Date('2024-01-01T00:00:00Z'),
      updatedAt: new Date('2024-01-01T00:00:00Z'),
    });
    const result = await migrateUser(makeSourceUser({ threads: [alreadyMigrated] }), fromFileOptions());

    expect(result.skipped).toBe(true);
    expect(result.skipReason).toBe('no new threads');
    expect(result.postgresId).toBe(existing.rows[0].id);
    expect(result.isNew).toBe(false);
    expect(result.threadsInserted).toBe(0);
    expect(await count(client, 'users')).toBe(1);
    expect(await count(client, 'threads')).toBe(1);
    expect(existsSync(mappingPath)).toBe(false);
  });

  it('migrates threads for existing user without legacy data', async () => {
    const existing = await client.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, first_name) VALUES ('test@example.com', $1, 'Original') RETURNING id`,
      [FAKE_BCRYPT_HASH]
    );

    const result = await migrateUser(makeSourceUser(), fromFileOptions());

    expect(result.skipped).toBe(false);
    expect(result.isNew).toBe(false);
    expect(result.postgresId).toBe(existing.rows[0].id);
    expect(result.threadsInserted).toBe(1);

    // Account untouched (no re-create, no update); thread attached to it.
    const user = await client.query<{ first_name: string }>(`SELECT first_name FROM users`);
    expect(user.rows).toEqual([{ first_name: 'Original' }]);
    const threads = await client.query<{ user_id: string; source: string }>(`SELECT user_id, source FROM threads`);
    expect(threads.rows).toEqual([{ user_id: existing.rows[0].id, source: 'legacy' }]);

    // Only thread mapping entries for an existing account.
    const mapping = await readMapping();
    expect(mapping.map((m) => m.type)).toEqual(['thread']);
  });

  it('only dedups against source=legacy threads of the existing user', async () => {
    // A non-legacy thread at the same timestamp must NOT suppress the import.
    const existing = await client.query<{ id: string }>(
      `INSERT INTO users (email, password_hash) VALUES ('test@example.com', $1) RETURNING id`,
      [FAKE_BCRYPT_HASH]
    );
    await client.query(
      `INSERT INTO threads (user_id, name, source, created_at, updated_at) VALUES ($1, 'live', 'web', $2, $2)`,
      [existing.rows[0].id, '2024-02-01T00:00:00Z']
    );

    const result = await migrateUser(makeSourceUser(), fromFileOptions());
    expect(result.skipped).toBe(false);
    expect(result.threadsInserted).toBe(1);
    expect(await count(client, 'threads')).toBe(2);
  });

  it('skips a user with no threads (no account created)', async () => {
    const result = await migrateUser(makeSourceUser({ threads: [] }), fromFileOptions());
    expect(result.skipped).toBe(true);
    expect(result.skipReason).toBe('no threads');
    expect(await count(client, 'users')).toBe(0);
    expect(existsSync(mappingPath)).toBe(false);
  });

  it('skips a user whose threads have no messages (no account created)', async () => {
    const result = await migrateUser(
      makeSourceUser({ threads: [sampleThread({ messages: [] })] }),
      fromFileOptions()
    );
    expect(result.skipped).toBe(true);
    expect(result.skipReason).toBe('no threads');
    expect(await count(client, 'users')).toBe(0);
  });

  it('logs but does not write in dry-run mode', async () => {
    const result = await migrateUser(makeSourceUser(), fromFileOptions(true));

    expect(result.isNew).toBe(true);
    expect(result.skipped).toBe(false);
    expect(result.postgresId).toBe('dry-run-id');
    expect(result.threadsInserted).toBe(1);
    expect(await count(client, 'users')).toBe(0);
    expect(await count(client, 'threads')).toBe(0);
    expect(existsSync(mappingPath)).toBe(false);
  });

  it('is atomic: a failing thread insert leaves no user row and no mapping', async () => {
    // An invalid Date cannot be serialized by the driver, so the second thread's insert
    // throws INSIDE the transaction, after the user and the first thread were written.
    const bad = sampleThread({ mongoId: 'thread-bad', createdAt: new Date('not-a-date') });
    await expect(
      migrateUser(makeSourceUser({ threads: [sampleThread(), bad] }), fromFileOptions())
    ).rejects.toThrow();

    expect(await count(client, 'users')).toBe(0);
    expect(await count(client, 'threads')).toBe(0);
    expect(await count(client, 'messages')).toBe(0);
    expect(existsSync(mappingPath)).toBe(false);
  });

  it('is idempotent: a second identical run inserts zero rows', async () => {
    const source = makeSourceUser({
      threads: [
        sampleThread({ mongoId: 't1', createdAt: new Date('2024-02-01T00:00:00Z') }),
        sampleThread({ mongoId: 't2', createdAt: new Date('2024-03-01T00:00:00Z') }),
      ],
    });

    const first = await migrateUser(source, fromFileOptions());
    expect(first.isNew).toBe(true);
    expect(first.threadsInserted).toBe(2);
    const before = {
      users: await count(client, 'users'),
      threads: await count(client, 'threads'),
      messages: await count(client, 'messages'),
    };
    const mappingBefore = await readMapping();

    const second = await migrateUser(source, fromFileOptions());
    expect(second.skipped).toBe(true);
    expect(second.skipReason).toBe('no new threads');
    expect(second.postgresId).toBe(first.postgresId);
    expect(second.threadsInserted).toBe(0);

    expect({
      users: await count(client, 'users'),
      threads: await count(client, 'threads'),
      messages: await count(client, 'messages'),
    }).toEqual(before);
    expect(await readMapping()).toEqual(mappingBefore);
  });
});
