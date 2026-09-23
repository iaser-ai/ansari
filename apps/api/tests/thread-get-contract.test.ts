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
import type { DocumentContentBlock } from '@/db/schema/messages';
import { createMessage, createToolCallOrphan } from '@/lib/db/threads';
import { createThreadSnapshot } from '@/lib/db/shares';
import { GET as threadGet } from '../src/app/api/v2/threads/[id]/route';
import { GET as shareGet } from '../src/app/api/v2/share/[id]/route';

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
// Provenance columns (issue #99) must never serialize either — same structural
// exclusion (messageReadColumns / share projection), same live-scan discipline.
const PROVENANCE_KEY_PATTERN = /model_provider|modelProvider|model_id|modelId/;

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
    // Populated so the no-serialize assertions below are live (issue #99).
    modelProvider: 'inkling',
    modelId: 'tinker://sft-dpo-bf16',
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

describe('PROVENANCE_KEY_PATTERN is a live scan (negative-tested per lessons-critical)', () => {
  it('matches each known-bad key and not a near-miss', () => {
    for (const bad of ['model_provider', 'modelProvider', 'model_id', 'modelId']) {
      expect(JSON.stringify({ [bad]: 'gemini' })).toMatch(PROVENANCE_KEY_PATTERN);
    }
    // Near-misses: a bare `model`/`id`/`provider` key, or provider VALUES in
    // ordinary content, must not trip the scan.
    expect(JSON.stringify({ model: 'x', id: 1, provider: 'y', content: 'the gemini model id' })).not.toMatch(
      PROVENANCE_KEY_PATTERN
    );
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
    // No tool, payload, or provenance key anywhere in the serialized bytes.
    expect(raw).not.toMatch(TOOL_KEY_PATTERN);
    expect(raw).not.toMatch(PROVENANCE_KEY_PATTERN);
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
  it('serializes no tool, payload, or provenance keys with the columns populated', async () => {
    await seedConversation();
    const share = await createThreadSnapshot(THREAD_ID, USER_ID);
    expect(share).toBeDefined();
    const raw = JSON.stringify(share!.content);
    expect(raw).not.toMatch(TOOL_KEY_PATTERN);
    expect(raw).not.toMatch(PROVENANCE_KEY_PATTERN);
    expect(share!.content.messages.map((m) => Object.keys(m))).toEqual([
      ['role', 'content', 'createdAt'],
      ['role', 'content', 'createdAt'],
    ]);
  });
});

// ---------------------------------------------------------------------------
// Issue #66 — citable documents: an additive `documents` sibling key on the
// owning message ONLY. The exact-key assertions above stay untouched; the
// document-bearing cases get their own pinned lists (order included).
// ---------------------------------------------------------------------------

const DOC_MESSAGE_KEYS = [...MESSAGE_KEYS, 'documents'];
const DOC_SNAPSHOT_KEYS = ['role', 'content', 'createdAt', 'documents'];

// Source text carries `<`, `&` and quotes: returned strings must equal the
// persisted strings exactly — no escaping or transformation on the way out.
const DOCUMENTS: DocumentContentBlock[] = [
  {
    type: 'document',
    source: {
      type: 'text',
      media_type: 'text/plain',
      data: 'إِنَّ اللَّهَ مَعَ الصَّابِرِينَ — "patience" & <sabr> \'2:153\'',
    },
    title: 'Quran 2:153',
    context: 'Ayah text',
  },
  {
    type: 'document',
    source: { type: 'text', media_type: 'text/plain', data: 'Actions are judged by intentions…' },
    title: 'Sahih al-Bukhari 1',
  },
];

async function seedDocumentedAnswer() {
  await createMessage({ threadId: THREAD_ID, role: 'user', content: [{ type: 'text', text: 'What is sabr?' }] });
  await createMessage({
    threadId: THREAD_ID,
    role: 'assistant',
    content: [{ type: 'text', text: 'Sabr is patience.' }],
    agentName: 'facilitator',
    rawPayload: { role: 'model', parts: [{ text: 'Sabr is patience.' }] },
    toolCalls: RECORDS,
    modelProvider: 'gemini',
    modelId: 'gemini-2.5-pro',
    documents: DOCUMENTS,
  });
}

describe('GET /api/v2/threads/[id] — documents (issue #66)', () => {
  it('returns documents on the documented assistant message only, verbatim and in order', async () => {
    await seedDocumentedAnswer();

    const res = await threadGet(getReq(), ctx);
    expect(res.status).toBe(200);
    const raw = await res.text();
    const body = JSON.parse(raw);

    expect(Object.keys(body)).toEqual(TOP_LEVEL_KEYS);
    const [user, assistant] = body.messages;
    expect(Object.keys(user)).toEqual(MESSAGE_KEYS);
    expect(Object.keys(assistant)).toEqual(DOC_MESSAGE_KEYS);
    // content is still a bare string for a single-text answer.
    expect(assistant.content).toBe('Sabr is patience.');
    expect(assistant.documents).toEqual(DOCUMENTS);
    expect(assistant.documents[0].source.data).toBe(DOCUMENTS[0].source.data);
    // The frozen-contract scans still find nothing with every internal column populated.
    expect(raw).not.toMatch(TOOL_KEY_PATTERN);
    expect(raw).not.toMatch(PROVENANCE_KEY_PATTERN);
  });

  it('a mixed thread: only the documented answer carries the key', async () => {
    await seedDocumentedAnswer();
    await createMessage({ threadId: THREAD_ID, role: 'user', content: [{ type: 'text', text: 'Thanks' }] });
    await createMessage({
      threadId: THREAD_ID,
      role: 'assistant',
      content: [{ type: 'text', text: 'You are welcome.' }],
      agentName: 'facilitator',
    });

    const body = JSON.parse(await (await threadGet(getReq(), ctx)).text());
    expect(body.messages.map((m: object) => Object.keys(m))).toEqual([
      MESSAGE_KEYS,
      DOC_MESSAGE_KEYS,
      MESSAGE_KEYS,
      MESSAGE_KEYS,
    ]);
    expect(body.messages[1].documents).toEqual(DOCUMENTS);
  });
});

describe('GET /api/v2/threads/[id] — document-less threads are byte-identical to pre-#66', () => {
  // Deterministic rows (fixed ids and timestamps) inserted by SQL, so the
  // serialized response can be compared to a fixture. LEGACY_FIXTURE was
  // captured by running this exact seed through the UNMODIFIED (pre-#66) GET
  // handler. Rows cover: a user message, a no-tool answer (documents NULL), a
  // legacy row written before the column existed (NULL), and a hand-inserted
  // '[]' row (which documentsOrNull never writes, but must still emit no key).
  const LEGACY_FIXTURE =
    '{"thread_id":"22222222-2222-2222-2222-222222222222","thread_name":"Sabr","source":"web","created_at":"2026-01-01T00:00:00.000Z","updated_at":"2026-01-01T00:05:00.000Z","messages":[{"id":"a0000000-0000-0000-0000-000000000001","role":"user","content":"What is sabr?","agent_name":null,"source":"web","created_at":"2026-01-01T00:01:00.000Z"},{"id":"a0000000-0000-0000-0000-000000000002","role":"assistant","content":"Sabr is patience.","agent_name":"facilitator","source":"web","created_at":"2026-01-01T00:02:00.000Z"},{"id":"a0000000-0000-0000-0000-000000000003","role":"user","content":"And shukr?","agent_name":null,"source":"web","created_at":"2026-01-01T00:03:00.000Z"},{"id":"a0000000-0000-0000-0000-000000000004","role":"assistant","content":"Shukr is gratitude.","agent_name":"facilitator","source":"web","created_at":"2026-01-01T00:04:00.000Z"}]}';

  async function seedDeterministic() {
    await client.exec(`
      UPDATE threads SET created_at = '2026-01-01T00:00:00Z', updated_at = '2026-01-01T00:05:00Z';
      INSERT INTO messages (id, thread_id, role, content, agent_name, source, created_at) VALUES
        ('a0000000-0000-0000-0000-000000000001', '${THREAD_ID}', 'user',
          '[{"type":"text","text":"What is sabr?"}]', NULL, 'web', '2026-01-01T00:01:00Z'),
        ('a0000000-0000-0000-0000-000000000002', '${THREAD_ID}', 'assistant',
          '[{"type":"text","text":"Sabr is patience."}]', 'facilitator', 'web', '2026-01-01T00:02:00Z'),
        ('a0000000-0000-0000-0000-000000000003', '${THREAD_ID}', 'user',
          '[{"type":"text","text":"And shukr?"}]', NULL, 'web', '2026-01-01T00:03:00Z');
      INSERT INTO messages (id, thread_id, role, content, agent_name, source, documents, created_at) VALUES
        ('a0000000-0000-0000-0000-000000000004', '${THREAD_ID}', 'assistant',
          '[{"type":"text","text":"Shukr is gratitude."}]', 'facilitator', 'web', '[]'::jsonb, '2026-01-01T00:04:00Z');
    `);
  }

  it('serializes exactly the pre-change bytes, with no documents key anywhere', async () => {
    await seedDeterministic();
    const raw = await (await threadGet(getReq(), ctx)).text();
    expect(raw).toBe(LEGACY_FIXTURE);
    expect(raw).not.toContain('documents');
  });
});

describe('share — documents in snapshot and share GET (issue #66)', () => {
  const shareCtx = (id: string) => ({ params: Promise.resolve({ id }) });
  const shareReq = (id: string) => new NextRequest(`http://localhost/api/v2/share/${id}`, { method: 'GET' });

  it('a share created now snapshots documents and share GET returns them on the same message', async () => {
    await seedDocumentedAnswer();
    const share = await createThreadSnapshot(THREAD_ID, USER_ID);
    expect(share).toBeDefined();
    expect(share!.content.messages.map((m) => Object.keys(m))).toEqual([
      ['role', 'content', 'createdAt'],
      DOC_SNAPSHOT_KEYS,
    ]);

    const res = await shareGet(shareReq(share!.id), shareCtx(share!.id));
    expect(res.status).toBe(200);
    const raw = await res.text();
    const body = JSON.parse(raw);
    expect(Object.keys(body.messages[0])).toEqual(['role', 'content', 'created_at']);
    expect(Object.keys(body.messages[1])).toEqual(['role', 'content', 'created_at', 'documents']);
    expect(body.messages[1].content).toBe('Sabr is patience.');
    expect(body.messages[1].documents).toEqual(DOCUMENTS);
    expect(raw).not.toMatch(TOOL_KEY_PATTERN);
    expect(raw).not.toMatch(PROVENANCE_KEY_PATTERN);
  });

  it('a pre-#66 snapshot (no documents key) returns no documents key', async () => {
    const SHARE_ID = '33333333-3333-3333-3333-333333333333';
    const legacySnapshot = {
      threadName: 'Sabr',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'What is sabr?' }], createdAt: '2026-01-01T00:01:00.000Z' },
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'Sabr is patience.' }],
          createdAt: '2026-01-01T00:02:00.000Z',
        },
      ],
    };
    await client.query(`INSERT INTO shares (id, thread_id, content) VALUES ($1, $2, $3)`, [
      SHARE_ID,
      THREAD_ID,
      JSON.stringify(legacySnapshot),
    ]);

    const raw = await (await shareGet(shareReq(SHARE_ID), shareCtx(SHARE_ID))).text();
    const body = JSON.parse(raw);
    for (const m of body.messages) {
      expect(Object.keys(m)).toEqual(['role', 'content', 'created_at']);
    }
    expect(raw).not.toContain('documents');
  });
});
