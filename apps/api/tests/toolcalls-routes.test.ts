import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

/**
 * Route persistence of tool records (spec 73, Phase 3) — all three persist sites,
 * through the ACTUAL route handlers against pglite, mocking only the boundaries
 * (auth, facilitator, thread-naming, Sentry, rate limit, system user).
 *
 *  - a tool-using turn → assistant row with tool_calls; a no-tool turn → NULL;
 *  - a turn that ran tools and then ended in `error` / empty-final / mcp 502 →
 *    NO assistant row, ONE tool_call_orphans row with the records and reason;
 *  - the next turn's history replay is unaffected by orphan rows;
 *  - the SSE wire output of the chat route is byte-identical for a given event
 *    sequence (no record data crosses the stream);
 *  - mcp-complete's facilitator-error contract (500 + facilitator message) is
 *    unchanged across the throw→return refactor.
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

vi.mock('@/lib/ai/thread-naming', () => ({
  maybeGenerateThreadName: vi.fn(),
}));

const mockRunFacilitator = vi.fn();
vi.mock('@/lib/facilitator/agent', () => ({
  runFacilitator: (...a: unknown[]) => mockRunFacilitator(...a),
}));

vi.mock('@sentry/nextjs', () => ({
  setTag: vi.fn(),
  captureException: vi.fn(),
  captureMessage: vi.fn(),
}));

const SYSTEM_USER_ID = '44444444-4444-4444-4444-444444444444';
vi.mock('@/lib/db/users', () => ({
  getOrCreateSystemUser: async () => ({
    id: '44444444-4444-4444-4444-444444444444',
    email: 'ai-skill@system.ansari.chat',
    passwordHash: 'nologin',
  }),
}));

vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: () => ({ allowed: true, retryAfter: 0 }),
  getClientIp: () => '127.0.0.1',
}));

import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { eq } from 'drizzle-orm';
import * as schema from '@/db/schema';
import { messages, toolCallOrphans, threads, type ToolCallRecord } from '@/db/schema';
import { SSE_HEARTBEAT } from '@/lib/streaming/heartbeat';
import { POST as threadPost } from '../src/app/api/v2/threads/[id]/route';
import { POST as chatPost } from '../src/app/api/v2/threads/[id]/chat/route';
import { POST as mcpPost } from '../src/app/api/v2/mcp-complete/route';

let client: PGlite;
let db: ReturnType<typeof drizzle<typeof schema>>;

const USER_ID = '11111111-1111-1111-1111-111111111111';
const THREAD_ID = '22222222-2222-2222-2222-222222222222';

const RECORDS: ToolCallRecord[] = [
  { type: 'tool_use', id: 'tool_1_1_aaaaa', name: 'search_mawsuah', input: { query: 'q' } },
  {
    type: 'tool_result',
    tool_use_id: 'tool_1_1_aaaaa',
    content: { results: [], summary: 'The Fiqh Encyclopedia is temporarily unavailable.' },
    status: 'degraded',
    duration_ms: 20001,
    error_class: 'timeout',
    attempts: 2,
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
  `);
  await client.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3), ($4, $5, $6)`, [
    USER_ID,
    'routes@example.com',
    'x',
    SYSTEM_USER_ID,
    'ai-skill@system.ansari.chat',
    'nologin',
  ]);
});

afterAll(async () => {
  await client.close();
});

beforeEach(async () => {
  vi.clearAllMocks();
  mockAuthenticateRequest.mockResolvedValue({ user: { id: USER_ID } });
  await client.exec('DELETE FROM threads');
  await client.query(`INSERT INTO threads (id, user_id) VALUES ($1, $2)`, [THREAD_ID, USER_ID]);
});

async function readAll(res: Response): Promise<string> {
  return new TextDecoder().decode(new Uint8Array(await res.arrayBuffer()));
}

const ctx = { params: Promise.resolve({ id: THREAD_ID }) };

function webReq(content: string): NextRequest {
  return new NextRequest(`http://localhost/api/v2/threads/${THREAD_ID}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Ansari-Client': 'web-v2' },
    body: JSON.stringify({ content }),
  });
}

function chatReq(message: string): NextRequest {
  return new NextRequest(`http://localhost/api/v2/threads/${THREAD_ID}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Ansari-Client': 'web-v2' },
    body: JSON.stringify({ message }),
  });
}

function mcpReq(content: string): NextRequest {
  return new NextRequest('http://localhost/api/v2/mcp-complete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Ansari-Client': 'ai-skill-v1' },
    body: JSON.stringify({ messages: [{ role: 'user', content }] }),
  });
}

// Facilitator scripts. The wire-facing tool events stay lossy; the records ride
// only on the terminal event.
function toolTurnThenDone(text: string, toolCalls?: ToolCallRecord[]) {
  return async function* () {
    yield { type: 'tool_use' as const, data: JSON.stringify({ name: 'search_mawsuah' }) };
    yield { type: 'tool_result' as const, data: JSON.stringify({ tool: 'search_mawsuah', query: 'q', resultCount: 0 }) };
    if (text) yield { type: 'text' as const, data: text };
    yield { type: 'done' as const, data: '', usage: undefined, rawPayload: null, toolCalls };
  };
}

function toolTurnThenError(message: string, toolCalls?: ToolCallRecord[]) {
  return async function* () {
    yield { type: 'tool_use' as const, data: JSON.stringify({ name: 'search_mawsuah' }) };
    yield { type: 'error' as const, data: message, toolCalls };
  };
}

async function assistantRows() {
  return db.select().from(messages).where(eq(messages.role, 'assistant'));
}

async function orphanRows() {
  return db.select().from(toolCallOrphans);
}

describe('POST /api/v2/threads/[id] (web)', () => {
  it('a tool-using turn persists tool_calls on the assistant row', async () => {
    mockRunFacilitator.mockImplementation(() => toolTurnThenDone('Answer.', RECORDS)());

    const res = await threadPost(webReq('q'), ctx);
    expect(res.status).toBe(200);
    await readAll(res);

    const rows = await assistantRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].toolCalls).toEqual(RECORDS);
    expect(await orphanRows()).toHaveLength(0);
  });

  it('a no-tool turn persists NULL, not []', async () => {
    mockRunFacilitator.mockImplementation(() => toolTurnThenDone('Answer.', undefined)());

    await readAll(await threadPost(webReq('q'), ctx));

    const rows = await assistantRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].toolCalls).toBeNull();
  });

  it('a facilitator error after tools → no assistant row, one orphan with reason error', async () => {
    mockRunFacilitator.mockImplementation(() => toolTurnThenError('vertex exploded', RECORDS)());

    const body = await readAll(await threadPost(webReq('q'), ctx));
    expect(body).toContain('Error: vertex exploded');

    expect(await assistantRows()).toHaveLength(0);
    const orphans = await orphanRows();
    expect(orphans).toHaveLength(1);
    expect(orphans[0]).toMatchObject({ threadId: THREAD_ID, reason: 'error', source: 'web', client: 'web-v2' });
    expect(orphans[0].toolCalls).toEqual(RECORDS);
  });

  it('an empty final after tools → no assistant row, one orphan with reason empty_final', async () => {
    mockRunFacilitator.mockImplementation(() => toolTurnThenDone('', RECORDS)());

    const body = await readAll(await threadPost(webReq('q'), ctx));
    expect(body).toContain('empty answer');

    expect(await assistantRows()).toHaveLength(0);
    const orphans = await orphanRows();
    expect(orphans).toHaveLength(1);
    expect(orphans[0].reason).toBe('empty_final');
  });

  it('an error turn with no tools writes no orphan row', async () => {
    mockRunFacilitator.mockImplementation(() => toolTurnThenError('boom', undefined)());
    await readAll(await threadPost(webReq('q'), ctx));
    expect(await orphanRows()).toHaveLength(0);
  });

  it('history replay on the next turn is unaffected by an orphan row', async () => {
    mockRunFacilitator.mockImplementation(() => toolTurnThenError('vertex exploded', RECORDS)());
    await readAll(await threadPost(webReq('first'), ctx));

    mockRunFacilitator.mockImplementation(() => toolTurnThenDone('Answer.', RECORDS)());
    await readAll(await threadPost(webReq('second'), ctx));

    // Turn 2's history: the two user turns only (the failed turn left no assistant
    // row), and no message carries any tool-record key.
    const history = mockRunFacilitator.mock.calls[1][0] as Array<Record<string, unknown>>;
    expect(history.map((m) => m.role)).toEqual(['user', 'user']);
    for (const m of history) {
      expect(Object.keys(m).sort()).toEqual(['content', 'rawPayload', 'role']);
    }
  });
});

describe('POST /api/v2/threads/[id]/chat (SSE)', () => {
  it('a tool-using turn persists tool_calls; the SSE wire output is byte-identical to the pre-change format', async () => {
    mockRunFacilitator.mockImplementation(() => toolTurnThenDone('Hello', RECORDS)());

    const res = await chatPost(chatReq('q'), ctx);
    expect(res.status).toBe(200);
    const body = await readAll(res);

    const expected =
      `data: ${JSON.stringify({ type: 'tool_call', name: 'search_mawsuah' })}\n\n` +
      `data: ${JSON.stringify({ type: 'tool_result', tool: 'search_mawsuah', query: 'q', resultCount: 0 })}\n\n` +
      `data: ${JSON.stringify({ type: 'text', content: 'Hello' })}\n\n` +
      `data: ${JSON.stringify({ type: 'done' })}\n\n`;
    expect(body.split(SSE_HEARTBEAT).join('')).toBe(expected);
    expect(body).not.toContain('tool_use_id');
    expect(body).not.toContain('duration_ms');

    const rows = await assistantRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].toolCalls).toEqual(RECORDS);
  });

  it('a no-tool turn persists NULL', async () => {
    mockRunFacilitator.mockImplementation(() => toolTurnThenDone('Hello', undefined)());
    await readAll(await chatPost(chatReq('q'), ctx));
    expect((await assistantRows())[0].toolCalls).toBeNull();
  });

  it('a facilitator error after tools → orphan with reason error, error event on the wire unchanged', async () => {
    mockRunFacilitator.mockImplementation(() => toolTurnThenError('vertex exploded', RECORDS)());

    const body = await readAll(await chatPost(chatReq('q'), ctx));
    expect(body.split(SSE_HEARTBEAT).join('')).toBe(
      `data: ${JSON.stringify({ type: 'tool_call', name: 'search_mawsuah' })}\n\n` +
        `data: ${JSON.stringify({ type: 'error', message: 'vertex exploded' })}\n\n`
    );

    expect(await assistantRows()).toHaveLength(0);
    const orphans = await orphanRows();
    expect(orphans).toHaveLength(1);
    expect(orphans[0]).toMatchObject({ reason: 'error', source: 'web', client: 'web-v2' });
    expect(orphans[0].toolCalls).toEqual(RECORDS);
  });

  it('an empty final after tools → orphan with reason empty_final', async () => {
    mockRunFacilitator.mockImplementation(() => toolTurnThenDone('', RECORDS)());
    await readAll(await chatPost(chatReq('q'), ctx));
    expect(await assistantRows()).toHaveLength(0);
    expect((await orphanRows())[0].reason).toBe('empty_final');
  });
});

describe('POST /api/v2/mcp-complete (ai-skill)', () => {
  it('a tool-using turn persists tool_calls on the assistant row', async () => {
    mockRunFacilitator.mockImplementation(() => toolTurnThenDone('Answer.', RECORDS)());

    const res = await mcpPost(mcpReq('q'));
    expect(res.status).toBe(200);

    const rows = await assistantRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].source).toBe('ai-skill');
    expect(rows[0].toolCalls).toEqual(RECORDS);
  });

  it('a no-tool turn persists NULL', async () => {
    mockRunFacilitator.mockImplementation(() => toolTurnThenDone('Answer.', undefined)());
    await mcpPost(mcpReq('q'));
    expect((await assistantRows())[0].toolCalls).toBeNull();
  });

  it('a facilitator error after tools → orphan with reason error, and the 500 contract is unchanged', async () => {
    mockRunFacilitator.mockImplementation(() => toolTurnThenError('Gemini API timeout', RECORDS)());

    const res = await mcpPost(mcpReq('q'));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Gemini API timeout' });

    expect(await assistantRows()).toHaveLength(0);
    const orphans = await orphanRows();
    expect(orphans).toHaveLength(1);
    expect(orphans[0]).toMatchObject({ reason: 'error', source: 'ai-skill', client: 'ai-skill-v1' });
    expect(orphans[0].toolCalls).toEqual(RECORDS);
    // The orphan is attached to the thread this request created.
    const threadRows = await db.select().from(threads).where(eq(threads.id, orphans[0].threadId));
    expect(threadRows).toHaveLength(1);
    expect(threadRows[0].source).toBe('ai-skill');
  });

  it('an empty answer after tools → 502 as today, orphan with reason empty_final', async () => {
    mockRunFacilitator.mockImplementation(() => toolTurnThenDone('', RECORDS)());

    const res = await mcpPost(mcpReq('q'));
    expect(res.status).toBe(502);
    expect((await res.json()).error).toMatch(/empty answer/i);

    expect(await assistantRows()).toHaveLength(0);
    expect((await orphanRows())[0].reason).toBe('empty_final');
  });
});
