import { describe, it, expect, vi, beforeAll } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import path from 'path';

/**
 * Code-vs-migration drift guard (issue #165).
 *
 * #66 shipped code that read and wrote a new messages column while its
 * migration was never applied on staging: thread GET, assistant-message
 * persistence and share creation all failed with "column does not exist".
 * Every existing pglite suite hand-writes its DDL, so each one carried the
 * column and none could see the gap.
 *
 * This suite builds its database ONLY from the real migration files, in
 * `_journal.json` order, and exercises the real read/write helpers on it:
 *  - against the migrations deployed on staging/production (through
 *    DEPLOYED_THROUGH) — the exact state of the outage;
 *  - against the full journal, where every column the Drizzle schema declares
 *    must exist, so the schema can never run ahead of its migrations.
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
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core';
import { is } from 'drizzle-orm';
import * as schema from '@/db/schema';
import { createThread, createMessage, getThreadWithMessages, findMessagesByThread } from '@/lib/db/threads';
import { createThreadSnapshot } from '@/lib/db/shares';

const DRIZZLE_DIR = path.resolve(__dirname, '../../drizzle');
// Last migration applied on staging and production. Advance it only once a
// newer migration has actually been applied there.
const DEPLOYED_THROUGH = '0008_model_provenance';

type JournalEntry = { idx: number; tag: string };
const journal: JournalEntry[] = JSON.parse(
  readFileSync(path.join(DRIZZLE_DIR, 'meta/_journal.json'), 'utf8')
).entries;

async function migrate(through?: string): Promise<PGlite> {
  const client = new PGlite();
  for (const { tag } of journal) {
    const sql = readFileSync(path.join(DRIZZLE_DIR, `${tag}.sql`), 'utf8');
    for (const stmt of sql.split('--> statement-breakpoint')) {
      if (stmt.trim()) await client.exec(stmt);
    }
    if (tag === through) return client;
  }
  if (through) throw new Error(`migration ${through} not in journal`);
  return client;
}

async function exerciseMessagePaths(client: PGlite) {
  h.db = drizzle(client, { schema });
  const [{ id: userId }] = (
    await client.query<{ id: string }>(
      `INSERT INTO users (email, password_hash) VALUES ('parity@example.com', 'x') RETURNING id`
    )
  ).rows;
  const thread = await createThread({ userId, name: 'parity' });
  await createMessage({ threadId: thread.id, role: 'user', content: [{ type: 'text', text: 'q' }] });
  await createMessage({
    threadId: thread.id,
    role: 'assistant',
    content: [{ type: 'text', text: 'a' }],
    toolCalls: [{ type: 'tool_use', id: 't1', name: 'search_quran', input: { query: 'q' } }],
  });

  const view = await getThreadWithMessages(thread.id, userId);
  expect(view?.messages).toHaveLength(2);
  expect(await findMessagesByThread(thread.id)).toHaveLength(2);
  expect(await createThreadSnapshot(thread.id, userId)).toBeDefined();
}

describe('migration files', () => {
  it('journal and .sql files agree one-to-one', () => {
    const files = readdirSync(DRIZZLE_DIR)
      .filter((f) => f.endsWith('.sql'))
      .map((f) => f.replace(/\.sql$/, ''))
      .sort();
    expect(files).toEqual(journal.map((e) => e.tag).sort());
  });

  it('the deployed migration is in the journal', () => {
    expect(journal.map((e) => e.tag)).toContain(DEPLOYED_THROUGH);
  });
});

describe('real read/write paths on a migration-built database', () => {
  it('work against the migrations deployed on staging/production', async () => {
    await exerciseMessagePaths(await migrate(DEPLOYED_THROUGH));
  });

  it('work against the full migration journal', async () => {
    await exerciseMessagePaths(await migrate());
  });
});

describe('Drizzle schema vs migrations', () => {
  let columns: Map<string, Set<string>>;

  beforeAll(async () => {
    const client = await migrate();
    const { rows } = await client.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public'`
    );
    columns = new Map();
    for (const r of rows) {
      if (!columns.has(r.table_name)) columns.set(r.table_name, new Set());
      columns.get(r.table_name)!.add(r.column_name);
    }
  });

  it('every column the schema declares is created by a migration', () => {
    const tables = Object.values(schema).filter((v): v is PgTable => is(v, PgTable));
    expect(tables.length).toBeGreaterThan(0);
    const missing: string[] = [];
    for (const table of tables) {
      const { name, columns: declared } = getTableConfig(table);
      for (const col of declared) {
        if (!columns.get(name)?.has(col.name)) missing.push(`${name}.${col.name}`);
      }
    }
    expect(missing).toEqual([]);
  });
});
