import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';

/**
 * findCitableDocumentsByThread (spec 168) against real pglite: selects only a
 * thread's assistant rows with tool_calls, derives inside, returns a
 * ordered list of { messageId, messageIndex, documents } with no empty entries, and reports malformed
 * records by id + reason codes only.
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
import type { ToolCallRecord } from '@/db/schema';
import { createMessage, createToolCallOrphan } from '@/lib/db/threads';
import { findCitableDocumentsByThread } from '@/lib/db/citable-documents';

let client: PGlite;

const USER_ID = '11111111-1111-1111-1111-111111111111';
const THREAD_ID = '22222222-2222-2222-2222-222222222222';
const OTHER_THREAD_ID = '55555555-5555-5555-5555-555555555555';
const at = (s: number) => new Date(Date.UTC(2026, 8, 1, 12, 0, s));

type Entry = { title: string; context?: string; content: string };
const V1: Entry = { title: 'Quran 2:153', context: 'Retrieved from the Holy Quran', content: 'verse one' };
const H1: Entry = { title: 'Sahih Muslim, Hadith 2999', context: 'Retrieved from hadith collections', content: 'hadith' };
const NO_RESULTS: Entry = { title: 'No Results', context: 'Quran Search', content: 'No results found.' };

function records(entries: Entry[], citations?: Array<{ enabled: boolean }>): ToolCallRecord[] {
  return [
    { type: 'tool_use', id: 'tool_1', name: 'search_quran', input: { query: 'q' } },
    {
      type: 'tool_result',
      tool_use_id: 'tool_1',
      content: { results: entries, summary: 's' },
      status: 'ok',
      duration_ms: 5,
      ...(citations ? { citations } : {}),
    },
  ];
}

const doc = (e: Entry) => ({
  type: 'document',
  source: { type: 'text', media_type: 'text/plain', data: e.content },
  title: e.title,
  ...(e.context !== undefined ? { context: e.context } : {}),
});

beforeAll(async () => {
  client = new PGlite();
  h.db = drizzle(client, { schema });
  await client.exec(`
    CREATE TABLE users (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      email text UNIQUE NOT NULL,
      password_hash text NOT NULL,
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
      model_provider text,
      model_id text,
      created_at timestamp with time zone DEFAULT now()
    );
    CREATE TABLE tool_call_orphans (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      thread_id uuid NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      reason text NOT NULL,
      source text,
      client text,
      tool_calls jsonb NOT NULL,
      model_provider text,
      model_id text,
      created_at timestamp with time zone DEFAULT now()
    );
  `);
  await client.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3)`, [USER_ID, 'd@example.com', 'x']);
});

afterAll(async () => {
  await client.close();
});

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(async () => {
  await client.exec('DELETE FROM threads');
  for (const id of [THREAD_ID, OTHER_THREAD_ID]) {
    await client.query(`INSERT INTO threads (id, user_id, name) VALUES ($1, $2, 't')`, [id, USER_ID]);
  }
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  warn.mockRestore();
});

const msg = (id: string, role: 'user' | 'assistant', s: number, toolCalls?: unknown, threadId = THREAD_ID) =>
  createMessage({
    id,
    threadId,
    role,
    content: [{ type: 'text', text: `m${s}` }],
    createdAt: at(s),
    ...(toolCalls !== undefined ? { toolCalls: toolCalls as ToolCallRecord[] } : {}),
  });

const ID = (n: number) => `44444444-0000-0000-0000-00000000000${n}`;

describe('findCitableDocumentsByThread (real pglite)', () => {
  it('returns thread-ordered entries for citable answers only, indexed by thread position; no empty entries', async () => {
    await msg(ID(1), 'user', 1);
    await msg(ID(2), 'assistant', 2, records([V1, NO_RESULTS], [{ enabled: true }, { enabled: false }]));
    await msg(ID(3), 'user', 3);
    await msg(ID(4), 'assistant', 4); // no tools → NULL tool_calls
    await msg(ID(5), 'user', 5);
    await msg(ID(6), 'assistant', 6, records([NO_RESULTS], [{ enabled: false }])); // notice only
    await msg(ID(7), 'user', 7);
    await msg(ID(8), 'assistant', 8, records([H1])); // legacy: no citations
    await msg(ID(9), 'user', 9);
    await msg('44444444-0000-0000-0000-000000000010', 'assistant', 10, records([H1], [{ enabled: true }]));

    const entries = await findCitableDocumentsByThread(THREAD_ID);
    expect(entries).toEqual([
      { messageId: ID(2), messageIndex: 1, documents: [doc(V1)] },
      { messageId: '44444444-0000-0000-0000-000000000010', messageIndex: 9, documents: [doc(H1)] },
    ]);
    // Legacy rows are expected, not warned about.
    expect(warn).not.toHaveBeenCalled();
  });

  it('ignores user rows even if they carried tool_calls, other threads, and orphan rows', async () => {
    await msg(ID(1), 'user', 1, records([V1], [{ enabled: true }]));
    await msg(ID(2), 'assistant', 2, records([V1], [{ enabled: true }]), OTHER_THREAD_ID);
    await createToolCallOrphan({ threadId: THREAD_ID, reason: 'error', toolCalls: records([H1], [{ enabled: true }]) });

    expect(await findCitableDocumentsByThread(THREAD_ID)).toEqual([]);
  });

  it('a malformed record fails closed without throwing; siblings still derive; the warning carries id + reasons only', async () => {
    const SENTINEL = 'SENTINEL-RECORD-TEXT';
    const malformed = [
      { type: 'tool_result', tool_use_id: 'x', content: { results: [{ title: SENTINEL, content: SENTINEL, context: 42 }] }, citations: [{ enabled: true }] },
      ...records([V1], [{ enabled: true }]),
    ];
    await msg(ID(2), 'assistant', 2, malformed);
    await msg(ID(3), 'assistant', 3, { not: 'an array', text: SENTINEL });
    await msg(ID(4), 'assistant', 4, records([H1], [{ enabled: true }]));

    expect(await findCitableDocumentsByThread(THREAD_ID)).toEqual([
      { messageId: ID(2), messageIndex: 0, documents: [doc(V1)] },
      { messageId: ID(4), messageIndex: 2, documents: [doc(H1)] },
    ]);

    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls).toEqual([
      ['[citable-documents] tool records skipped', { messageId: ID(2), reasons: ['bad_entry'] }],
      ['[citable-documents] tool records skipped', { messageId: ID(3), reasons: ['not_array'] }],
    ]);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(SENTINEL);
  });

  it('warns once per message with de-duplicated reasons, excluding legacy', async () => {
    const tc = [
      { type: 'tool_result', content: 'bad' },
      { type: 'tool_result', content: 'bad' },
      ...records([V1]), // legacy record in the same message
    ];
    await msg(ID(2), 'assistant', 2, tc);
    await findCitableDocumentsByThread(THREAD_ID);
    expect(warn.mock.calls).toEqual([['[citable-documents] tool records skipped', { messageId: ID(2), reasons: ['bad_content'] }]]);
  });

  it('an empty thread returns []', async () => {
    expect(await findCitableDocumentsByThread(THREAD_ID)).toEqual([]);
  });
});
