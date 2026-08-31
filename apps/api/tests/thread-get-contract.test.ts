import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

/**
 * Frozen thread-GET contract (spec 73) — the regression test that protects the
 * mobile API contract, which cannot be updated in the field.
 *
 * `formatMessageContent` returns a bare STRING iff `content` is exactly one text
 * block; every assistant message today is exactly that. Tool records live in a
 * separate column precisely so this stays true. Asserted on the SERIALIZED JSON
 * (key enumeration + typeof), through the real GET handler against pglite, with
 * the tool_calls column populated — and on the share snapshot, the second
 * serializing surface.
 */

const h = vi.hoisted(() => ({ db: null as unknown }));

vi.mock('@/lib/db/index', () => ({
  get db() {
    return h.db;
  },
  closeDb: async () => {},
}));

const mockAuthenticateRequest = vi.fn();
vi.mock('@/lib/auth/middleware', () => ({
  authenticateRequest: (...a: unknown[]) => mockAuthenticateRequest(...a),
  createErrorResponse: (message: string, status: number) =>
    new Response(JSON.stringify({ error: message }), {
      status,
      headers: { 'Content-Type': 'application/json' },
    }),
}));

vi.mock('@/lib/ai/thread-naming', () => ({ maybeGenerateThreadName: vi.fn() }));
vi.mock('@/lib/facilitator/agent', () => ({ runFacilitator: vi.fn() }));
vi.mock('@sentry/nextjs', () => ({ setTag: vi.fn(), captureException: vi.fn(), captureMessage: vi.fn() }));

import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import * as schema from '@/db/schema';
import type { ToolCallRecord } from '@/db/schema';
import { createMessage, createToolCallOrphan } from '@/lib/db/threads';
import { createThreadSnapshot } from '@/lib/db/shares';
import { GET as threadGet } from '../src/app/api/v2/threads/[id]/route';

let client: PGlite;

const USER_ID = '11111111-1111-1111-1111-111111111111';
const THREAD_ID = '22222222-2222-2222-2222-222222222222';

const RECORDS: ToolCallRecord[] = [
  { type: 'tool_use', id: 'tool_1_1_aaaaa', name: 'search_quran', input: { query: 'الصبر' } },
  {
    type: 'tool_result',
    tool_use_id: 'tool_1_1_aaaaa',
    content: { results: [{ title: 'Quran 2:153', context: 'quran', content: 'يا أيها الذين آمنوا استعينوا بالصبر' }], summary: 'ok' },
    status: 'ok',
    duration_ms: 300,
  },
];

// Today's exact key sets (order included — JSON.stringify preserves insertion order).
const TOP_LEVEL_KEYS = ['thread_id', 'thread_name', 'source', 'created_at', 'updated_at', 'messages'];
const MESSAGE_KEYS = ['id', 'role', 'content', 'agent_name', 'source', 'created_at'];
const TOOL_KEY_PATTERN = /tool_use|tool_result|tool_calls|toolCalls|rawPayload|raw_payload|duration_ms/;

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
  await client.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3)`, [USER_ID, 'c@example.com', 'x']);
});

afterAll(async () => {
  await client.close();
});

beforeEach(async () => {
  vi.clearAllMocks();
  mockAuthenticateRequest.mockResolvedValue({ user: { id: USER_ID } });
  await client.exec('DELETE FROM threads');
  await client.query(`INSERT INTO threads (id, user_id, name) VALUES ($1, $2, $3)`, [THREAD_ID, USER_ID, 'Sabr']);
});

const ctx = { params: Promise.resolve({ id: THREAD_ID }) };
const getReq = () => new NextRequest(`http://localhost/api/v2/threads/${THREAD_ID}`, { method: 'GET' });

async function seedConversation() {
  await createMessage({ threadId: THREAD_ID, role: 'user', content: [{ type: 'text', text: 'What is sabr?' }] });
  await createMessage({
    threadId: THREAD_ID,
    role: 'assistant',
    content: [{ type: 'text', text: 'Sabr is patience.' }],
    agentName: 'facilitator',
    rawPayload: { role: 'model', parts: [{ text: 'Sabr is patience.' }] },
    toolCalls: RECORDS,
  });
}

describe('TOOL_KEY_PATTERN is a live scan (negative-tested per lessons-critical)', () => {
  it('matches each known-bad key and not a near-miss', () => {
    for (const bad of ['tool_use', 'tool_result', 'tool_calls', 'toolCalls', 'rawPayload', 'raw_payload', 'duration_ms']) {
      expect(JSON.stringify({ [bad]: 1 })).toMatch(TOOL_KEY_PATTERN);
    }
    // Near-misses that legitimately appear in responses must NOT trip the scan.
    expect(JSON.stringify({ thread_name: 'tools of the trade', agent_name: 'facilitator' })).not.toMatch(TOOL_KEY_PATTERN);
  });
});

describe('GET /api/v2/threads/[id] — frozen contract with tool_calls populated', () => {
  it('a single-text-block assistant message still returns a bare STRING content', async () => {
    await seedConversation();

    const res = await threadGet(getReq(), ctx);
    expect(res.status).toBe(200);
    const raw = await res.text();
    const body = JSON.parse(raw);

    expect(Object.keys(body)).toEqual(TOP_LEVEL_KEYS);
    expect(body.messages).toHaveLength(2);
    for (const m of body.messages) {
      expect(Object.keys(m)).toEqual(MESSAGE_KEYS);
      expect(typeof m.content).toBe('string');
    }
    expect(body.messages[1].content).toBe('Sabr is patience.');
    // No tool or payload key anywhere in the serialized bytes.
    expect(raw).not.toMatch(TOOL_KEY_PATTERN);
  });

  it('a multi-block content still returns the block ARRAY (unchanged branch)', async () => {
    await createMessage({
      threadId: THREAD_ID,
      role: 'assistant',
      content: [
        { type: 'text', text: 'Two' },
        { type: 'text', text: 'blocks' },
      ],
      toolCalls: RECORDS,
    });

    const body = JSON.parse(await (await threadGet(getReq(), ctx)).text());
    expect(Array.isArray(body.messages[0].content)).toBe(true);
    expect(body.messages[0].content).toEqual([
      { type: 'text', text: 'Two' },
      { type: 'text', text: 'blocks' },
    ]);
  });

  it('orphan rows for the thread are invisible: same messages, same keys', async () => {
    await seedConversation();
    const before = await (await threadGet(getReq(), ctx)).text();

    await createToolCallOrphan({ threadId: THREAD_ID, reason: 'error', toolCalls: RECORDS });

    const after = await (await threadGet(getReq(), ctx)).text();
    expect(after).toBe(before);
  });
});

describe('share snapshot — second serializing surface', () => {
  it('serializes no tool or payload keys with tool_calls populated', async () => {
    await seedConversation();
    const share = await createThreadSnapshot(THREAD_ID, USER_ID);
    expect(share).toBeDefined();
    const raw = JSON.stringify(share!.content);
    expect(raw).not.toMatch(TOOL_KEY_PATTERN);
    expect(share!.content.messages.map((m) => Object.keys(m))).toEqual([
      ['role', 'content', 'createdAt'],
      ['role', 'content', 'createdAt'],
    ]);
  });
});
