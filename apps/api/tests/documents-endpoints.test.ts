import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { NextRequest } from 'next/server';

/**
 * The citable-sources endpoints (spec 168), through the real handlers on pglite:
 *   GET /api/v2/threads/{id}/documents — owner-scoped, derived live
 *   GET /api/v2/share/{id}/documents   — public, read from the snapshot
 * Both return { messages: [{ message_index, documents }] } (the thread one adds
 * message_id); message_index is the position in the matching GET's messages.
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
import { GET as threadDocsGet } from '../src/app/api/v2/threads/[id]/documents/route';
import { GET as shareGet } from '../src/app/api/v2/share/[id]/route';
import { GET as shareDocsGet } from '../src/app/api/v2/share/[id]/documents/route';

let client: PGlite;

const USER_ID = '11111111-1111-1111-1111-111111111111';
const OTHER_USER_ID = '66666666-6666-6666-6666-666666666666';
const THREAD_ID = '22222222-2222-2222-2222-222222222222';
const FOREIGN_THREAD_ID = '77777777-7777-7777-7777-777777777777';
const MISSING_THREAD_ID = '88888888-8888-8888-8888-888888888888';
const at = (s: number) => new Date(Date.UTC(2026, 8, 1, 12, 0, s));
const ID = (n: number) => `44444444-0000-0000-0000-0000000000${String(n).padStart(2, '0')}`;

type Entry = { title: string; context?: string; content: string };
const V1: Entry = { title: 'Quran 2:153', context: 'Retrieved from the Holy Quran', content: 'Seek help through patience and prayer.' };
const V2: Entry = { title: 'Quran 2:155', context: 'Retrieved from the Holy Quran', content: 'And We will surely test you.' };
const H1: Entry = { title: 'Sahih Muslim, Hadith 2999', context: 'Retrieved from hadith collections', content: 'How wonderful is the affair of the believer.' };
const NO_RESULTS: Entry = { title: 'No Results', context: 'Quran Search', content: 'No results found.' };

let toolSeq = 0;
function records(...rounds: Array<[Entry[], boolean[] | undefined]>): ToolCallRecord[] {
  return rounds.flatMap(([entries, flags]) => {
    toolSeq++;
    const id = `tool_${toolSeq}`;
    return [
      { type: 'tool_use' as const, id, name: 'search_quran', input: { query: 'q' } },
      {
        type: 'tool_result' as const,
        tool_use_id: id,
        content: { results: entries, summary: 's' },
        status: 'ok' as const,
        duration_ms: 5,
        ...(flags ? { citations: flags.map((enabled) => ({ enabled })) } : {}),
      },
    ];
  });
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
    CREATE TABLE shares (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      thread_id uuid NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      content jsonb NOT NULL,
      created_at timestamp with time zone DEFAULT now()
    );
  `);
  await client.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, 'a@example.com', 'x'), ($2, 'b@example.com', 'x')`, [USER_ID, OTHER_USER_ID]);
});

afterAll(async () => {
  await client.close();
});

beforeEach(async () => {
  vi.clearAllMocks();
  mockAuthenticateRequest.mockResolvedValue({ user: { id: USER_ID } });
  await client.exec('DELETE FROM threads');
  await client.query(`INSERT INTO threads (id, user_id, name) VALUES ($1, $2, 'Sabr'), ($3, $4, 'Foreign')`, [
    THREAD_ID,
    USER_ID,
    FOREIGN_THREAD_ID,
    OTHER_USER_ID,
  ]);
});

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const req = (path: string) => new NextRequest(`http://localhost${path}`, { method: 'GET' });
const json = async (r: Response) => JSON.parse(await r.text());

const getThread = () => threadGet(req(`/api/v2/threads/${THREAD_ID}`), ctx(THREAD_ID));
const getThreadDocs = (id = THREAD_ID) => threadDocsGet(req(`/api/v2/threads/${id}/documents`), ctx(id));
const getShare = (id: string) => shareGet(req(`/api/v2/share/${id}`), ctx(id));
const getShareDocs = (id: string) => shareDocsGet(req(`/api/v2/share/${id}/documents`), ctx(id));

async function msg(n: number, role: 'user' | 'assistant', toolCalls?: unknown, threadId = THREAD_ID) {
  await createMessage({
    id: ID(n),
    threadId,
    role,
    content: [{ type: 'text', text: `message ${n}` }],
    createdAt: at(n),
    ...(toolCalls !== undefined ? { toolCalls: toolCalls as ToolCallRecord[] } : {}),
  });
}

/** user / citable (hit + notice) / user / no-tool / user / notice-only / user / legacy / user / two-round citable with a duplicate. */
async function seedMixedThread() {
  await msg(1, 'user');
  await msg(2, 'assistant', records([[V1, NO_RESULTS], [true, false]]));
  await msg(3, 'user');
  await msg(4, 'assistant');
  await msg(5, 'user');
  await msg(6, 'assistant', records([[NO_RESULTS], [false]]));
  await msg(7, 'user');
  await msg(8, 'assistant', records([[H1], undefined]));
  await msg(9, 'user');
  await msg(10, 'assistant', records([[V2, V1], [true, true]], [[H1, V2], [true, true]]));
}

describe('GET /api/v2/threads/[id]/documents', () => {
  it('returns only messages with citable documents, in thread order, with id, index and documents', async () => {
    await seedMixedThread();
    const res = await getThreadDocs();
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(Object.keys(body)).toEqual(['thread_id', 'messages']);
    expect(body).toEqual({
      thread_id: THREAD_ID,
      messages: [
        { message_id: ID(2), message_index: 1, documents: [doc(V1)] },
        // Dispatch order across rounds; the second V2 is a duplicate and collapses.
        { message_id: ID(10), message_index: 9, documents: [doc(V2), doc(V1), doc(H1)] },
      ],
    });
    for (const m of body.messages) expect(Object.keys(m)).toEqual(['message_id', 'message_index', 'documents']);
  });

  it('message_index points at the same message in thread GET', async () => {
    await seedMixedThread();
    const thread = await json(await getThread());
    const docs = await json(await getThreadDocs());
    expect(docs.messages.length).toBeGreaterThan(0);
    for (const e of docs.messages) {
      expect(thread.messages[e.message_index].id).toBe(e.message_id);
      expect(thread.messages[e.message_index].role).toBe('assistant');
    }
  });

  it('a thread with no citable retrieval returns messages: []', async () => {
    await msg(1, 'user');
    await msg(2, 'assistant');
    await msg(3, 'assistant', records([[NO_RESULTS], [false]]));
    expect(await json(await getThreadDocs())).toEqual({ thread_id: THREAD_ID, messages: [] });
  });

  it('auth: an unauthenticated request gets exactly what thread GET returns', async () => {
    const unauthorized = () =>
      new Response(JSON.stringify({ error: 'Authentication required' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    mockAuthenticateRequest.mockImplementation(async () => ({ error: unauthorized() }));
    const a = await getThread();
    const b = await getThreadDocs();
    expect(b.status).toBe(a.status);
    expect(await b.text()).toBe(await a.text());
  });

  it('auth: a foreign thread and a missing thread return the same 404 as thread GET', async () => {
    await msg(1, 'assistant', records([[V1], [true]]), FOREIGN_THREAD_ID);
    const foreign = await getThreadDocs(FOREIGN_THREAD_ID);
    const missing = await getThreadDocs(MISSING_THREAD_ID);
    const threadGet404 = await threadGet(req(`/api/v2/threads/${MISSING_THREAD_ID}`), ctx(MISSING_THREAD_ID));
    expect(foreign.status).toBe(404);
    expect(missing.status).toBe(404);
    const [f, m, g] = [await foreign.text(), await missing.text(), await threadGet404.text()];
    expect(f).toBe(m);
    expect(f).toBe(g);
    expect(f).not.toContain(V1.content);
  });

  it('malformed tool_calls on one message: 200 with the other messages’ documents', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await msg(1, 'user');
    await msg(2, 'assistant', { not: 'an array' });
    await msg(3, 'user');
    await msg(4, 'assistant', [{ type: 'tool_result', content: 'bad', citations: [] }]);
    await msg(5, 'user');
    await msg(6, 'assistant', records([[H1], [true]]));
    const res = await getThreadDocs();
    expect(res.status).toBe(200);
    expect((await json(res)).messages).toEqual([{ message_id: ID(6), message_index: 5, documents: [doc(H1)] }]);
    warn.mockRestore();
  });

  it('orphan rows change nothing', async () => {
    await seedMixedThread();
    const before = await (await getThreadDocs()).text();
    await createToolCallOrphan({ threadId: THREAD_ID, reason: 'error', toolCalls: records([[H1, V2], [true, true]]) });
    expect(await (await getThreadDocs()).text()).toBe(before);
  });
});

describe('GET /api/v2/share/[id]/documents', () => {
  it('returns the documents copied into the snapshot, in the same shape', async () => {
    await seedMixedThread();
    const share = await createThreadSnapshot(THREAD_ID, USER_ID);
    const res = await getShareDocs(share!.id);
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(Object.keys(body)).toEqual(['id', 'messages']);
    expect(body).toEqual({
      id: share!.id,
      messages: [
        { message_index: 1, documents: [doc(V1)] },
        { message_index: 9, documents: [doc(V2), doc(V1), doc(H1)] },
      ],
    });
  });

  it('parity: each entry deep-equals the thread endpoint’s (index and documents)', async () => {
    await seedMixedThread();
    const share = await createThreadSnapshot(THREAD_ID, USER_ID);
    const thread = await json(await getThreadDocs());
    const shared = await json(await getShareDocs(share!.id));
    expect(shared.messages).toEqual(
      thread.messages.map((m: { message_index: number; documents: unknown }) => ({
        message_index: m.message_index,
        documents: m.documents,
      }))
    );
  });

  it('message_index points at the same message in share GET', async () => {
    await seedMixedThread();
    const share = await createThreadSnapshot(THREAD_ID, USER_ID);
    const shareBody = await json(await getShare(share!.id));
    const threadBody = await json(await getThread());
    for (const e of (await json(await getShareDocs(share!.id))).messages) {
      const s = shareBody.messages[e.message_index];
      const t = threadBody.messages[e.message_index];
      expect([s.role, s.content, s.created_at]).toEqual([t.role, t.content, t.created_at]);
    }
  });

  it('the snapshot stores documents, but share GET never emits them', async () => {
    await seedMixedThread();
    const share = await createThreadSnapshot(THREAD_ID, USER_ID);
    expect(Object.keys(share!.content.messages[1])).toEqual(['role', 'content', 'createdAt', 'documents']);
    expect(Object.keys(share!.content.messages[0])).toEqual(['role', 'content', 'createdAt']);
    const raw = await (await getShare(share!.id)).text();
    expect(raw).not.toContain('documents');
    for (const m of JSON.parse(raw).messages) expect(Object.keys(m)).toEqual(['role', 'content', 'created_at']);
  });

  it('a message added after the share was created does not appear', async () => {
    await seedMixedThread();
    const share = await createThreadSnapshot(THREAD_ID, USER_ID);
    await msg(11, 'user');
    await msg(12, 'assistant', records([[NO_RESULTS, H1], [false, true]]));
    const shared = await json(await getShareDocs(share!.id));
    expect(shared.messages.map((m: { message_index: number }) => m.message_index)).toEqual([1, 9]);
    // …while the thread endpoint does show it.
    expect((await json(await getThreadDocs())).messages.at(-1)).toMatchObject({ message_id: ID(12), message_index: 11 });
  });

  it('a pre-168 snapshot (no documents key) returns messages: []', async () => {
    const r = await client.query<{ id: string }>(
      `INSERT INTO shares (thread_id, content) VALUES ($1, $2) RETURNING id`,
      [THREAD_ID, JSON.stringify({ threadName: 'Old', messages: [{ role: 'assistant', content: [{ type: 'text', text: 'old' }], createdAt: at(1).toISOString() }] })]
    );
    expect(await json(await getShareDocs(r.rows[0].id))).toEqual({ id: r.rows[0].id, messages: [] });
  });

  it('an unknown share returns the same 404 as share GET', async () => {
    const unknown = '99999999-9999-9999-9999-999999999999';
    const a = await getShare(unknown);
    const b = await getShareDocs(unknown);
    expect(b.status).toBe(404);
    expect(await b.text()).toBe(await a.text());
  });

  it('share creation succeeds with malformed tool_calls in the thread', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await msg(1, 'assistant', { not: 'an array' });
    await msg(2, 'assistant', records([[V1], [true]]));
    const share = await createThreadSnapshot(THREAD_ID, USER_ID);
    expect(share).toBeDefined();
    expect((await json(await getShareDocs(share!.id))).messages).toEqual([{ message_index: 1, documents: [doc(V1)] }]);
    warn.mockRestore();
  });
});

// Keys that must never serialize: raw tool records, their citability flag,
// record status, replay payload, provenance. Matched as JSON KEYS so document
// text containing these words cannot false-positive.
const FORBIDDEN_KEY = /"(tool_use|tool_result|tool_calls|toolCalls|citations|status|tool_use_id|duration_ms|raw_payload|rawPayload|model_provider|modelProvider|model_id|modelId)":/;

describe('structural safety: no record keys in any serialized body', () => {
  it('FORBIDDEN_KEY is a live scan: matches each known-bad key, not a near-miss', () => {
    for (const bad of ['"citations":[', '"tool_calls":null', '"status":"ok"', '"raw_payload":{}', '"model_id":"x"']) {
      expect(bad).toMatch(FORBIDDEN_KEY);
    }
    for (const near of ['"citationsCount":1', 'status', '"text":"citations: see below"', '"statuses":[]']) {
      expect(near).not.toMatch(FORBIDDEN_KEY);
    }
  });

  it('thread GET, share GET, the stored snapshot and both /documents bodies are clean — with documents present', async () => {
    await seedMixedThread();
    const share = await createThreadSnapshot(THREAD_ID, USER_ID);
    const bodies = [
      await (await getThread()).text(),
      await (await getThreadDocs()).text(),
      await (await getShare(share!.id)).text(),
      await (await getShareDocs(share!.id)).text(),
      JSON.stringify(share!.content),
    ];
    // Not vacuous: documents really are present in the /documents bodies and snapshot.
    expect(bodies[1]).toContain(V1.content);
    expect(bodies[3]).toContain(V1.content);
    expect(bodies[4]).toContain(V1.content);
    for (const b of bodies) expect(b).not.toMatch(FORBIDDEN_KEY);
  });
});

describe('the public share /documents route never reaches tool_calls', () => {
  const ROUTE = resolve(__dirname, '../src/app/api/v2/share/[id]/documents/route.ts');
  // An import of the derivation module or the thread/message helpers.
  const FORBIDDEN_IMPORT = /from\s+['"][^'"]*lib\/db\/(citable-documents|threads)['"]/;

  it('FORBIDDEN_IMPORT is a live scan: matches known-bad imports, not a near-miss', () => {
    expect("import { findCitableDocumentsByThread } from '@/lib/db/citable-documents';").toMatch(FORBIDDEN_IMPORT);
    expect("import { findMessagesByThread } from '../../lib/db/threads';").toMatch(FORBIDDEN_IMPORT);
    expect("import { findShareById } from '@/lib/db/shares';").not.toMatch(FORBIDDEN_IMPORT);
  });

  it('imports neither the derivation module nor the thread helpers, and never names tool_calls', () => {
    const src = readFileSync(ROUTE, 'utf8');
    expect(src).toContain("from '@/lib/db/shares'"); // the scan read the real file
    expect(src).not.toMatch(FORBIDDEN_IMPORT);
    expect(src).not.toMatch(/toolCalls|tool_calls/);
  });
});
