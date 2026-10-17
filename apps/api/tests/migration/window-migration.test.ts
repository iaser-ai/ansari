import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';

/**
 * Spec 300 app-database migrations, run from the real files on a database
 * built from the real journal:
 *  - 0009 scaffold cleanup: drops the #59 tables only when all are empty
 *    (scenario 15);
 *  - 0010 tombstones: additive `deleted_users`;
 *  - 0011 window migration: email normalization behind a collision guard
 *    (scenario 14, app half; scenario 13's padded mixed-case row), then
 *    `password_hash DROP NOT NULL`, and nothing else.
 * Every guard is shown to abort AND to leave the database unchanged.
 */

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
import { randomUUID } from 'node:crypto';
import {
  findUserById,
  getOrCreateSystemUser,
  insertAppUserRow,
  isUniqueViolation,
} from '@/lib/db/users';
import { createThread, createMessage, getThreadWithMessages } from '@/lib/db/threads';

const DRIZZLE_DIR = path.resolve(__dirname, '../../drizzle');
const LAST_LEGACY = '0008_model_provenance';
const CLEANUP = '0009_better_auth_scaffold_cleanup';
const TOMBSTONES = '0010_deleted_users';
const WINDOW = '0011_better_auth_window';

const journal: string[] = JSON.parse(
  readFileSync(path.join(DRIZZLE_DIR, 'meta/_journal.json'), 'utf8')
).entries.map((e: { tag: string }) => e.tag);

async function apply(client: PGlite, tag: string) {
  const sql = readFileSync(path.join(DRIZZLE_DIR, `${tag}.sql`), 'utf8');
  for (const stmt of sql.split('--> statement-breakpoint')) {
    if (stmt.trim()) await client.exec(stmt);
  }
}

async function migrateThrough(client: PGlite, through: string) {
  const end = journal.indexOf(through);
  if (end < 0) throw new Error(`migration ${through} not in journal`);
  for (const tag of journal.slice(0, end + 1)) await apply(client, tag);
}

// The #59 scaffold's shape: singular, text-id tables in `public`, with
// session and account referencing user.
const SCAFFOLD_DDL = `
  CREATE TABLE "user" (id text PRIMARY KEY, email text NOT NULL UNIQUE, name text NOT NULL);
  CREATE TABLE "session" (id text PRIMARY KEY, user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE, token text NOT NULL);
  CREATE TABLE "account" (id text PRIMARY KEY, user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE, provider_id text NOT NULL);
  CREATE TABLE "verification" (id text PRIMARY KEY, identifier text NOT NULL, value text NOT NULL);
`;
const SCAFFOLD_TABLES = ['account', 'session', 'user', 'verification'];

async function publicTables(client: PGlite): Promise<string[]> {
  const { rows } = await client.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY 1`
  );
  return rows.map((r) => r.table_name);
}

async function foreignKeysToUsers(client: PGlite) {
  const { rows } = await client.query<{ conname: string; tbl: string; def: string }>(
    `SELECT conname, conrelid::regclass::text AS tbl, pg_get_constraintdef(oid) AS def
       FROM pg_constraint
      WHERE contype = 'f' AND confrelid = 'public.users'::regclass
      ORDER BY conname`
  );
  return rows;
}

async function insertUser(client: PGlite, email: string): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'legacy-hash') RETURNING id`,
    [email]
  );
  return rows[0].id;
}

async function emails(client: PGlite): Promise<string[]> {
  const { rows } = await client.query<{ email: string }>(`SELECT email FROM users ORDER BY id`);
  return rows.map((r) => r.email);
}

async function passwordHashNullable(client: PGlite): Promise<string> {
  const { rows } = await client.query<{ is_nullable: string }>(
    `SELECT is_nullable FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'password_hash'`
  );
  return rows[0].is_nullable;
}

let client: PGlite;

beforeEach(() => {
  client = new PGlite();
});

afterEach(async () => {
  await client.close();
});

describe('the journal numbers', () => {
  it('runs the spec 300 migrations in order, right after the last legacy one', () => {
    const at = journal.indexOf(LAST_LEGACY);
    expect(journal.slice(at, at + 4)).toEqual([LAST_LEGACY, CLEANUP, TOMBSTONES, WINDOW]);
  });
});

describe('0009 scaffold cleanup (scenario 15)', () => {
  it('aborts when public.account holds one row, and changes nothing', async () => {
    await migrateThrough(client, LAST_LEGACY);
    await client.exec(SCAFFOLD_DDL);
    await client.exec(`
      INSERT INTO "user" VALUES ('u1', 'a@x.com', 'A');
      INSERT INTO "account" VALUES ('a1', 'u1', 'credential');
    `);
    const before = await publicTables(client);

    await expect(apply(client, CLEANUP)).rejects.toThrow(/public\.(user|account) holds rows/);

    expect(await publicTables(client)).toEqual(before);
    expect(before).toEqual(expect.arrayContaining(SCAFFOLD_TABLES));
    const { rows } = await client.query(`SELECT id FROM "account"`);
    expect(rows).toEqual([{ id: 'a1' }]);
  });

  it('aborts on a row in any single scaffold table', async () => {
    // The scaffold's foreign keys would force a user row beside any session or
    // account row; drop them so each table's guard is proven on its own.
    for (const [table, insert] of [
      ['user', `INSERT INTO "user" VALUES ('u1', 'a@x.com', 'A')`],
      ['session', `INSERT INTO "session" VALUES ('s1', 'u1', 't')`],
      ['account', `INSERT INTO "account" VALUES ('a1', 'u1', 'credential')`],
      ['verification', `INSERT INTO "verification" VALUES ('v1', 'i', 'v')`],
    ] as const) {
      const db = new PGlite();
      try {
        await migrateThrough(db, LAST_LEGACY);
        await db.exec(SCAFFOLD_DDL);
        await db.exec(`
          ALTER TABLE "session" DROP CONSTRAINT session_user_id_fkey;
          ALTER TABLE "account" DROP CONSTRAINT account_user_id_fkey;
        `);
        await db.exec(insert);
        await expect(apply(db, CLEANUP)).rejects.toThrow(`public.${table} holds rows`);
        expect(await publicTables(db)).toEqual(expect.arrayContaining(SCAFFOLD_TABLES));
      } finally {
        await db.close();
      }
    }
  });

  it('drops empty scaffold tables and nothing else', async () => {
    await migrateThrough(client, LAST_LEGACY);
    const legacy = await publicTables(client);
    await client.exec(SCAFFOLD_DDL);

    await apply(client, CLEANUP);

    expect(await publicTables(client)).toEqual(legacy);
  });

  it('is a no-op on a database that never had the scaffold', async () => {
    await migrateThrough(client, LAST_LEGACY);
    const legacy = await publicTables(client);

    await apply(client, CLEANUP);

    expect(await publicTables(client)).toEqual(legacy);
  });
});

describe('0010 tombstones', () => {
  it('creates deleted_users with no foreign key and a defaulted deleted_at', async () => {
    await migrateThrough(client, TOMBSTONES);
    const { rows } = await client.query<{ deleted_at: Date | null; auth_deleted_at: Date | null }>(
      `INSERT INTO deleted_users (id) VALUES (gen_random_uuid()) RETURNING deleted_at, auth_deleted_at`
    );
    expect(rows[0].deleted_at).toBeInstanceOf(Date);
    expect(rows[0].auth_deleted_at).toBeNull();
    const fks = await client.query(
      `SELECT 1 FROM pg_constraint WHERE contype = 'f' AND conrelid = 'public.deleted_users'::regclass`
    );
    expect(fks.rows).toEqual([]);
  });
});

describe('0011 window migration', () => {
  beforeEach(async () => {
    await migrateThrough(client, TOMBSTONES);
  });

  it('aborts on Bob@x.com + bob@x.com (scenario 14), and changes nothing', async () => {
    await insertUser(client, 'Bob@x.com');
    await insertUser(client, 'bob@x.com');
    await insertUser(client, '  Carol@X.com');
    const before = await emails(client);

    await expect(apply(client, WINDOW)).rejects.toThrow(/1 normalized email\(s\) are held by more than one/);

    expect(await emails(client)).toEqual(before);
    expect(await passwordHashNullable(client)).toBe('NO');
  });

  it('counts a collision that differs only in padding', async () => {
    await insertUser(client, 'dave@x.com');
    await insertUser(client, ' dave@x.com ');

    await expect(apply(client, WINDOW)).rejects.toThrow(/1 normalized email/);
  });

  it('names no address in the abort', async () => {
    await insertUser(client, 'Bob@x.com');
    await insertUser(client, 'bob@x.com');

    const err = await apply(client, WINDOW).catch((e: Error) => e);
    expect(String((err as Error).message)).not.toMatch(/bob/i);
  });

  it('normalizes a padded mixed-case email (scenario 13) and leaves the rest', async () => {
    const alice = await insertUser(client, '  Alice@Example.COM');
    const plain = await insertUser(client, 'plain@example.com');

    await apply(client, WINDOW);

    const { rows } = await client.query<{ id: string; email: string }>(`SELECT id, email FROM users`);
    expect(rows).toEqual(
      expect.arrayContaining([
        { id: alice, email: 'alice@example.com' },
        { id: plain, email: 'plain@example.com' },
      ])
    );
  });

  it('drops NOT NULL from password_hash', async () => {
    await apply(client, WINDOW);

    expect(await passwordHashNullable(client)).toBe('YES');
    await client.query(`INSERT INTO users (email, password_hash) VALUES ('new@x.com', NULL)`);
  });

  it('leaves the foreign keys from threads, preferences and feedback unchanged', async () => {
    const before = await foreignKeysToUsers(client);
    expect(before.map((r) => r.tbl)).toEqual(expect.arrayContaining(['threads', 'preferences', 'feedback']));

    await apply(client, WINDOW);

    expect(await foreignKeysToUsers(client)).toEqual(before);
  });

  it('changes no column, index or constraint beyond password_hash nullability', async () => {
    const shape = async () => ({
      columns: (
        await client.query(
          `SELECT table_name, column_name, data_type,
                  CASE WHEN table_name = 'users' AND column_name = 'password_hash' THEN NULL ELSE is_nullable END AS is_nullable,
                  column_default
             FROM information_schema.columns
            WHERE table_schema = 'public'
            ORDER BY table_name, column_name`
        )
      ).rows,
      indexes: (
        await client.query(`SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' ORDER BY 1`)
      ).rows,
      constraints: (
        await client.query(
          `SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
            WHERE connamespace = 'public'::regnamespace
              -- Postgres 18 (pglite) catalogs NOT NULL as a constraint; this is the one dropped.
              AND conname <> 'users_password_hash_not_null'
            ORDER BY 1`
        )
      ).rows,
    });
    const before = await shape();

    await apply(client, WINDOW);

    expect(await shape()).toEqual(before);
  });
});

describe('the scaffold cleanup and tombstones leave legacy foreign keys alone', () => {
  it('compares the users foreign keys before 0009 and after 0011', async () => {
    await migrateThrough(client, LAST_LEGACY);
    const before = await foreignKeysToUsers(client);

    for (const tag of [CLEANUP, TOMBSTONES, WINDOW]) await apply(client, tag);

    expect(await foreignKeysToUsers(client)).toEqual(before);
  });
});

describe('apps/api code after the window migration', () => {
  it('writes an app row with no credential, provisions a system account, writes threads and deletes', async () => {
    await migrateThrough(client, WINDOW);
    h.db = drizzle(client, { schema });

    const id = randomUUID();
    await insertAppUserRow({
      id,
      email: ' New@Example.com ',
      firstName: 'N',
      lastName: null,
      registeredVia: 'web',
    });
    const user = await findUserById(id);
    expect(user?.email).toBe('new@example.com');
    const { rows: hash } = await client.query(`SELECT password_hash FROM users WHERE id = $1`, [id]);
    expect(hash).toEqual([{ password_hash: null }]);

    // A system account is provisioned with no credential either (0011 dropped the NOT NULL).
    const system = await getOrCreateSystemUser('ai-skill');
    expect(system.systemKey).toBe('ai-skill');

    const thread = await createThread({ userId: id, name: 'after' });
    await createMessage({ threadId: thread.id, role: 'user', content: [{ type: 'text', text: 'q' }] });
    expect((await getThreadWithMessages(thread.id, id))?.messages).toHaveLength(1);

    await client.query(`DELETE FROM users WHERE id = $1`, [id]);
    const { rows } = await client.query(`SELECT 1 FROM threads WHERE user_id = $1`, [id]);
    expect(rows).toEqual([]);
  });

  it('a row the migration normalized holds its address against a new app row', async () => {
    await migrateThrough(client, TOMBSTONES);
    const id = await insertUser(client, '  Alice@Example.COM');
    await apply(client, WINDOW);
    h.db = drizzle(client, { schema });

    const err = await insertAppUserRow({
      id: randomUUID(),
      email: 'ALICE@example.com',
      firstName: null,
      lastName: null,
      registeredVia: null,
    }).catch((e: unknown) => e);
    expect(isUniqueViolation(err)).toBe(true);
    expect((await findUserById(id))?.email).toBe('alice@example.com');
  });
});
