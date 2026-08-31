import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';

/**
 * tool_calls persistence round-trips against a REAL database (spec 73, Phase 1).
 *
 * Verifies, through the ACTUAL db helpers on pglite (per lessons-critical.md —
 * no mocks for persistence behavior):
 *  - createMessage round-trips a populated tool_calls array verbatim
 *    (analytics-side read: direct select, since the app-facing read helpers
 *    deliberately project the column OUT);
 *  - the read helpers (findMessagesByThread / getThreadWithMessages /
 *    createThreadSnapshot) never select tool_calls, while findMessagesByThread
 *    still returns raw_payload for history replay;
 *  - a turn with no tool calls stores NULL, not [];
 *  - createToolCallOrphan round-trips (reason included), does NOT bump
 *    threads.updated_at, and cascades on thread delete.
 *
 * pglite DDL drift guard: a fresh `grep -rln "CREATE TABLE messages" apps/api/tests/`
 * at implementation time hit exactly: attribution-schema, executor-threads-feedback,
 * feedback-idor, rawpayload-persistence, route-persistence-rollback (all updated
 * with tool_calls jsonb in the same commit as the schema change) — plus this file.
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
import { messages, toolCallOrphans, type ToolCallRecord } from '@/db/schema';
import {
  createMessage,
  createToolCallOrphan,
  findMessagesByThread,
  getThreadWithMessages,
  deleteThread,
} from '@/lib/db/threads';
import { createThreadSnapshot } from '@/lib/db/shares';

let client: PGlite;
let db: ReturnType<typeof drizzle<typeof schema>>;

const USER_ID = '11111111-1111-1111-1111-111111111111';
const THREAD_ID = '22222222-2222-2222-2222-222222222222';

// A realistic dispatch pair: full formatToolResultForGemini-shaped content,
// non-ASCII included, plus a degraded + a skipped record to cover the
// metadata fields end-to-end at the storage layer.
const TOOL_CALLS: ToolCallRecord[] = [
  {
    type: 'tool_use',
    id: 'tool_1700000000000_abc12',
    name: 'search_mawsuah',
    input: { query: 'أحكام الصيام' },
  },
  {
    type: 'tool_result',
    tool_use_id: 'tool_1700000000000_abc12',
    content: {
      results: [{ title: 'الموسوعة الفقهية', context: 'fiqh', content: 'نص الفتوى…' }],
      summary: 'Found 1 result.',
    },
    status: 'ok',
    duration_ms: 812,
  },
  {
    type: 'tool_use',
    id: 'tool_1700000000001_def34',
    name: 'search_hadith',
    input: { query: 'fasting' },
  },
  {
    type: 'tool_result',
    tool_use_id: 'tool_1700000000001_def34',
    content: { results: [], summary: 'The Hadith source is temporarily unavailable.' },
    status: 'degraded',
    duration_ms: 30021,
    error_class: 'timeout',
    attempts: 2,
  },
  {
    type: 'tool_use',
    id: 'tool_1700000000002_ghi56',
    name: 'search_quran',
    input: { query: 'patience' },
  },
  {
    type: 'tool_result',
    tool_use_id: 'tool_1700000000002_ghi56',
    content: { results: [], summary: 'Skipped: request time budget reached before this tool was called.' },
    status: 'budget_skipped',
    duration_ms: null,
    skip_trigger: 'T2',
  },
];

beforeAll(async () => {
  client = new PGlite();
  db = drizzle(client, { schema });
  h.db = db;
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
      created_at timestamp with time zone DEFAULT now()
    );
    CREATE TABLE tool_call_orphans (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      thread_id uuid NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      reason text NOT NULL,
      source text,
      client text,
      tool_calls jsonb NOT NULL,
      created_at timestamp with time zone DEFAULT now()
    );
    CREATE TABLE shares (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      thread_id uuid NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      content jsonb NOT NULL,
      created_at timestamp with time zone DEFAULT now()
    );
  `);
  await client.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3)`, [
    USER_ID,
    'tools@example.com',
    'x',
  ]);
});

afterAll(async () => {
  await client.close();
});

beforeEach(async () => {
  await client.exec('DELETE FROM threads');
  await client.query(`INSERT INTO threads (id, user_id) VALUES ($1, $2)`, [THREAD_ID, USER_ID]);
});

describe('messages.tool_calls round-trip (real pglite)', () => {
  it('persists a populated tool_calls array and reads it back verbatim via direct select', async () => {
    await createMessage({
      threadId: THREAD_ID,
      role: 'assistant',
      content: [{ type: 'text', text: 'الجواب…' }],
      toolCalls: TOOL_CALLS,
    });

    const rows = await db.select().from(messages);
    expect(rows).toHaveLength(1);
    expect(rows[0].toolCalls).toEqual(TOOL_CALLS);
  });

  it('stores NULL (not []) when a turn invoked no tools', async () => {
    await createMessage({
      threadId: THREAD_ID,
      role: 'assistant',
      content: [{ type: 'text', text: 'no tools' }],
    });

    const rows = await db.select().from(messages);
    expect(rows).toHaveLength(1);
    expect(rows[0].toolCalls).toBeNull();
  });
});

describe('read-path projection excludes tool_calls (structural contract safety)', () => {
  beforeEach(async () => {
    await createMessage({
      threadId: THREAD_ID,
      role: 'assistant',
      content: [{ type: 'text', text: 'answer' }],
      rawPayload: { role: 'model', parts: [{ text: 'answer' }] },
      toolCalls: TOOL_CALLS,
    });
  });

  it('findMessagesByThread returns no toolCalls key but still returns rawPayload', async () => {
    const rows = await findMessagesByThread(THREAD_ID);
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0])).not.toContain('toolCalls');
    expect(rows[0].rawPayload).toEqual({ role: 'model', parts: [{ text: 'answer' }] });
  });

  it('getThreadWithMessages returns no toolCalls key on any message', async () => {
    const result = await getThreadWithMessages(THREAD_ID, USER_ID);
    expect(result).toBeDefined();
    for (const m of result!.messages) {
      expect(Object.keys(m)).not.toContain('toolCalls');
    }
  });

  it('createThreadSnapshot serializes no tool keys anywhere', async () => {
    const share = await createThreadSnapshot(THREAD_ID, USER_ID);
    expect(share).toBeDefined();
    const serialized = JSON.stringify(share!.content);
    expect(serialized).not.toContain('toolCalls');
    expect(serialized).not.toContain('tool_calls');
    expect(serialized).not.toContain('tool_use');
    expect(serialized).not.toContain('tool_result');
    expect(serialized).not.toContain('rawPayload');
  });
});

describe('tool_call_orphans (real pglite)', () => {
  it('round-trips an orphan row, reason included', async () => {
    await createToolCallOrphan({
      threadId: THREAD_ID,
      reason: 'error',
      source: 'web',
      client: 'web-v2',
      toolCalls: TOOL_CALLS,
    });

    const rows = await db.select().from(toolCallOrphans);
    expect(rows).toHaveLength(1);
    expect(rows[0].reason).toBe('error');
    expect(rows[0].threadId).toBe(THREAD_ID);
    expect(rows[0].toolCalls).toEqual(TOOL_CALLS);
  });

  it('does NOT bump threads.updated_at (invisible in thread metadata)', async () => {
    const before = await client.query<{ updated_at: string }>(
      `SELECT updated_at FROM threads WHERE id = $1`,
      [THREAD_ID]
    );

    await createToolCallOrphan({
      threadId: THREAD_ID,
      reason: 'empty_final',
      toolCalls: TOOL_CALLS,
    });

    const after = await client.query<{ updated_at: string }>(
      `SELECT updated_at FROM threads WHERE id = $1`,
      [THREAD_ID]
    );
    expect(after.rows[0].updated_at).toEqual(before.rows[0].updated_at);
  });

  it('cascades on thread delete', async () => {
    await createToolCallOrphan({ threadId: THREAD_ID, reason: 'error', toolCalls: TOOL_CALLS });
    expect(await db.select().from(toolCallOrphans)).toHaveLength(1);

    expect(await deleteThread(THREAD_ID, USER_ID)).toBe(true);
    expect(await db.select().from(toolCallOrphans)).toHaveLength(0);
  });
});
