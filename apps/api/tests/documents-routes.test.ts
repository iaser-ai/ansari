import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

/**
 * Route persistence of citable documents (issue #66, Phase 2) — both
 * user-facing chat routes, through the ACTUAL route handlers against pglite,
 * mocking only the boundaries (auth, facilitator, thread-naming, Sentry, rate
 * limit, system user).
 *
 *  - a `done` carrying documents persists them on the assistant row; a `done`
 *    without them, or with [], persists NULL;
 *  - content, raw_payload, tool_calls and the SSE wire output are identical
 *    to the same turn without documents (the column is purely additive);
 *  - turn-2 history replay carries no document text, on both the raw-payload
 *    path and the text-only fallback path (raw_payload NULL);
 *  - error and empty-final turns write no assistant row, so no documents.
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

vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: () => ({ allowed: true, retryAfter: 0 }),
  getClientIp: () => '127.0.0.1',
}));

import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { eq } from 'drizzle-orm';
import type { Content } from '@google/genai';
import * as schema from '@/db/schema';
import { messages, type ToolCallRecord } from '@/db/schema';
import type { DocumentContentBlock } from '@/db/schema/messages';
import { RAW_TEXT_HEARTBEAT, SSE_HEARTBEAT } from '@/lib/streaming/heartbeat';
import { POST as threadPost } from '../src/app/api/v2/threads/[id]/route';
import { POST as chatPost } from '../src/app/api/v2/threads/[id]/chat/route';

let client: PGlite;
let db: ReturnType<typeof drizzle<typeof schema>>;

const USER_ID = '11111111-1111-1111-1111-111111111111';
const THREAD_ID = '22222222-2222-2222-2222-222222222222';

const QURAN_TEXT = 'إِنَّ اللَّهَ مَعَ الصَّابِرِينَ';
const HADITH_TEXT = 'Actions are judged by intentions.';
const DOCUMENTS: DocumentContentBlock[] = [
  {
    type: 'document',
    source: { type: 'text', media_type: 'text/plain', data: QURAN_TEXT },
    title: 'Quran 2:153',
    context: 'Ayah text',
  },
  {
    type: 'document',
    source: { type: 'text', media_type: 'text/plain', data: HADITH_TEXT },
    title: 'Sahih al-Bukhari 1',
  },
];

const RECORDS: ToolCallRecord[] = [
  { type: 'tool_use', id: 'tool_1_1_aaaaa', name: 'search_quran', input: { query: 'patience' } },
  {
    type: 'tool_result',
    tool_use_id: 'tool_1_1_aaaaa',
    content: { results: [{ text: QURAN_TEXT }], summary: 'Found 1 result.' },
    status: 'ok',
    duration_ms: 412,
  },
];

const RAW_PAYLOAD: Content = { role: 'model', parts: [{ text: 'Answer.' }] };

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
      model_provider text,
      model_id text,
      documents jsonb,
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
  await client.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3)`, [
    USER_ID,
    'documents-routes@example.com',
    'x',
  ]);
});

afterAll(async () => {
  await client.close();
});

beforeEach(async () => {
  vi.clearAllMocks();
  mockAuthenticateRequest.mockResolvedValue({ user: { id: USER_ID } });
  await resetThread();
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

interface TurnOptions {
  documents?: DocumentContentBlock[];
  rawPayload?: Content | null;
}

// A retrieval turn: the wire-facing tool events stay lossy (count only); the
// documents ride only on the terminal event, as the facilitator yields them.
function retrievalTurn(text: string, { documents, rawPayload = RAW_PAYLOAD }: TurnOptions = {}) {
  return async function* () {
    yield { type: 'tool_use' as const, data: JSON.stringify({ name: 'search_quran' }) };
    yield {
      type: 'tool_result' as const,
      data: JSON.stringify({ tool: 'search_quran', query: 'patience', resultCount: 1 }),
    };
    if (text) yield { type: 'text' as const, data: text };
    yield { type: 'done' as const, data: '', usage: undefined, rawPayload, toolCalls: RECORDS, documents };
  };
}

function errorTurn() {
  return async function* () {
    yield { type: 'tool_use' as const, data: JSON.stringify({ name: 'search_quran' }) };
    yield { type: 'error' as const, data: 'vertex exploded', toolCalls: RECORDS };
  };
}

async function assistantRows() {
  return db.select().from(messages).where(eq(messages.role, 'assistant'));
}

async function resetThread() {
  await client.exec('DELETE FROM threads');
  await client.query(`INSERT INTO threads (id, user_id) VALUES ($1, $2)`, [THREAD_ID, USER_ID]);
}

const ROUTES = [
  { name: 'POST /api/v2/threads/[id] (web)', post: threadPost, req: webReq, heartbeat: RAW_TEXT_HEARTBEAT },
  { name: 'POST /api/v2/threads/[id]/chat (SSE)', post: chatPost, req: chatReq, heartbeat: SSE_HEARTBEAT },
] as const;

describe.each(ROUTES)('$name', ({ post, req, heartbeat }) => {
  it('a done with documents persists them on the assistant row', async () => {
    mockRunFacilitator.mockImplementation(() => retrievalTurn('Answer.', { documents: DOCUMENTS })());

    const res = await post(req('q'), ctx);
    expect(res.status).toBe(200);
    await readAll(res);

    const rows = await assistantRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].documents).toEqual(DOCUMENTS);
  });

  it('a done without documents persists SQL NULL', async () => {
    mockRunFacilitator.mockImplementation(() => retrievalTurn('Answer.')());
    await readAll(await post(req('q'), ctx));

    const result = await client.query<{ is_null: boolean }>(
      `SELECT documents IS NULL AS is_null FROM messages WHERE role = 'assistant'`
    );
    expect(result.rows).toEqual([{ is_null: true }]);
  });

  it('a done with an EMPTY documents list persists SQL NULL, not []', async () => {
    mockRunFacilitator.mockImplementation(() => retrievalTurn('Answer.', { documents: [] })());
    await readAll(await post(req('q'), ctx));

    const result = await client.query<{ is_null: boolean }>(
      `SELECT documents IS NULL AS is_null FROM messages WHERE role = 'assistant'`
    );
    expect(result.rows).toEqual([{ is_null: true }]);
  });

  it('content, raw_payload, tool_calls and the wire output are identical to the same turn without documents', async () => {
    mockRunFacilitator.mockImplementation(() => retrievalTurn('Answer.')());
    const bodyWithout = await readAll(await post(req('q'), ctx));
    const [without] = await assistantRows();

    await resetThread();
    mockRunFacilitator.mockImplementation(() => retrievalTurn('Answer.', { documents: DOCUMENTS })());
    const bodyWith = await readAll(await post(req('q'), ctx));
    const [withDocs] = await assistantRows();

    expect(bodyWith.split(heartbeat).join('')).toBe(bodyWithout.split(heartbeat).join(''));
    expect(bodyWith).not.toContain(QURAN_TEXT);
    expect(bodyWith).not.toContain('Quran 2:153');
    expect(withDocs.content).toEqual(without.content);
    expect(withDocs.content).toEqual([{ type: 'text', text: 'Answer.' }]);
    expect(withDocs.rawPayload).toEqual(without.rawPayload);
    expect(withDocs.toolCalls).toEqual(without.toolCalls);
  });

  it.each([
    { path: 'raw-payload', rawPayload: RAW_PAYLOAD },
    { path: 'text-only fallback (raw_payload NULL)', rawPayload: null },
  ])('turn-2 history carries no document text on the $path path', async ({ rawPayload }) => {
    mockRunFacilitator.mockImplementation(() => retrievalTurn('Answer.', { documents: DOCUMENTS, rawPayload })());
    await readAll(await post(req('first'), ctx));
    expect((await assistantRows())[0].documents).toEqual(DOCUMENTS);

    mockRunFacilitator.mockImplementation(() => retrievalTurn('Second.')());
    await readAll(await post(req('second'), ctx));

    const history = mockRunFacilitator.mock.calls[1][0] as Array<Record<string, unknown>>;
    expect(history.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    for (const m of history) {
      expect(Object.keys(m)).not.toContain('documents');
    }
    const serialized = JSON.stringify(history);
    expect(serialized).not.toContain(QURAN_TEXT);
    expect(serialized).not.toContain(HADITH_TEXT);
    expect(serialized).not.toContain('Quran 2:153');
  });

  it('an error turn writes no assistant row, so no documents', async () => {
    mockRunFacilitator.mockImplementation(() => errorTurn()());
    await readAll(await post(req('q'), ctx));

    const result = await client.query(`SELECT count(*)::int AS n FROM messages WHERE documents IS NOT NULL`);
    expect(await assistantRows()).toHaveLength(0);
    expect(result.rows).toEqual([{ n: 0 }]);
  });

  it('an empty-final turn writes no assistant row, so no documents', async () => {
    mockRunFacilitator.mockImplementation(() => retrievalTurn('', { documents: DOCUMENTS })());
    await readAll(await post(req('q'), ctx));

    const result = await client.query(`SELECT count(*)::int AS n FROM messages WHERE documents IS NOT NULL`);
    expect(await assistantRows()).toHaveLength(0);
    expect(result.rows).toEqual([{ n: 0 }]);
  });
});
