import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { NextRequest } from 'next/server';

/**
 * Byte-identity pin for thread GET and share GET (spec 168).
 *
 * Citable documents are served ONLY by the dedicated `/documents` endpoints;
 * thread GET and share GET must not move by a single byte — released mobile
 * builds parse them. The fixtures under tests/fixtures/documents-contract/ were
 * captured from the UNMODIFIED handlers before any spec-168 serving code
 * existed, for a thread that includes an answer whose tool records DO derive
 * documents. They must never be regenerated to make a failure pass.
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
import { createMessage } from '@/lib/db/threads';
import { createThreadSnapshot } from '@/lib/db/shares';
import { GET as threadGet } from '../src/app/api/v2/threads/[id]/route';
import { GET as shareGet } from '../src/app/api/v2/share/[id]/route';

let client: PGlite;

const USER_ID = '11111111-1111-1111-1111-111111111111';
const THREAD_ID = '22222222-2222-2222-2222-222222222222';
const SHARE_ID = '33333333-3333-3333-3333-333333333333';
const FIXED_NOW = new Date('2026-09-24T00:00:00.000Z');
const FIXTURE_DIR = resolve(__dirname, 'fixtures/documents-contract');

const at = (s: number) => new Date(Date.UTC(2026, 8, 1, 12, 0, s));

// Pre-168 shape: no per-result citability.
const LEGACY_RECORDS: ToolCallRecord[] = [
  { type: 'tool_use', id: 'tool_1_1_aaaaa', name: 'search_quran', input: { query: 'sabr' } },
  {
    type: 'tool_result',
    tool_use_id: 'tool_1_1_aaaaa',
    content: { results: [{ title: 'Quran 2:153', context: 'Retrieved from the Holy Quran', content: 'O you who believe, seek help through patience and prayer.' }], summary: 'Please see the Quran verses below.' },
    status: 'ok',
    duration_ms: 300,
  },
];

// Post-168 shape: a citable hit plus a zero-result notice. Cast because the
// fixture was captured before the type gained `citations`.
const CITABLE_RECORDS = [
  { type: 'tool_use', id: 'tool_2_1_bbbbb', name: 'search_hadith', input: { query: 'patience' } },
  {
    type: 'tool_result',
    tool_use_id: 'tool_2_1_bbbbb',
    content: { results: [{ title: 'Sahih Muslim - Chapter 1: Patience, Hadith 2999', context: 'Retrieved from hadith collections', content: 'How wonderful is the affair of the believer.' }], summary: 'Please see the hadith references below.' },
    status: 'ok',
    duration_ms: 410,
    citations: [{ enabled: true }],
  },
  { type: 'tool_use', id: 'tool_2_2_ccccc', name: 'search_tafsir', input: { query: 'patience' } },
  {
    type: 'tool_result',
    tool_use_id: 'tool_2_2_ccccc',
    content: { results: [{ title: 'No Results', context: 'Tafsir Encyclopedia Search', content: 'No results found.' }], summary: 'No tafsir found for this query.' },
    status: 'ok',
    duration_ms: 220,
    citations: [{ enabled: false }],
  },
] as unknown as ToolCallRecord[];

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
    CREATE TABLE shares (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      thread_id uuid NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      content jsonb NOT NULL,
      created_at timestamp with time zone DEFAULT now()
    );
  `);
  await client.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3)`, [USER_ID, 'f@example.com', 'x']);
  await client.query(
    `INSERT INTO threads (id, user_id, name, created_at, updated_at) VALUES ($1, $2, $3, $4, $4)`,
    [THREAD_ID, USER_ID, 'Patience', at(0).toISOString()]
  );

  // createMessage bumps threads.updated_at to `new Date()` — pin it.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(FIXED_NOW);
  const base = { threadId: THREAD_ID, agentName: 'facilitator' as const };
  await createMessage({ id: '44444444-0000-0000-0000-000000000001', threadId: THREAD_ID, role: 'user', content: [{ type: 'text', text: 'What is sabr?' }], createdAt: at(1) });
  await createMessage({ ...base, id: '44444444-0000-0000-0000-000000000002', role: 'assistant', content: [{ type: 'text', text: 'Sabr is patience.' }], createdAt: at(2) });
  await createMessage({ id: '44444444-0000-0000-0000-000000000003', threadId: THREAD_ID, role: 'user', content: [{ type: 'text', text: 'Cite the Quran.' }], createdAt: at(3) });
  await createMessage({ ...base, id: '44444444-0000-0000-0000-000000000004', role: 'assistant', content: [{ type: 'text', text: 'Seek help through patience and prayer (2:153).' }], toolCalls: LEGACY_RECORDS, createdAt: at(4) });
  await createMessage({ id: '44444444-0000-0000-0000-000000000005', threadId: THREAD_ID, role: 'user', content: [{ type: 'text', text: 'And hadith?' }], createdAt: at(5) });
  await createMessage({ ...base, id: '44444444-0000-0000-0000-000000000006', role: 'assistant', content: [{ type: 'text', text: 'The affair of the believer is wonderful.' }], toolCalls: CITABLE_RECORDS, createdAt: at(6) });
  vi.useRealTimers();

  const share = await createThreadSnapshot(THREAD_ID, USER_ID);
  await client.query(`UPDATE shares SET id = $1, created_at = $2 WHERE id = $3`, [SHARE_ID, FIXED_NOW.toISOString(), share!.id]);
  mockAuthenticateRequest.mockResolvedValue({ user: { id: USER_ID } });
});

afterAll(async () => {
  await client.close();
});

const fixture = (name: string) => readFileSync(resolve(FIXTURE_DIR, name), 'utf8');

describe('thread GET and share GET are byte-identical to the pre-168 handlers', () => {
  it('thread GET, including an answer whose records derive documents', async () => {
    const res = await threadGet(
      new NextRequest(`http://localhost/api/v2/threads/${THREAD_ID}`, { method: 'GET' }),
      { params: Promise.resolve({ id: THREAD_ID }) }
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(fixture('thread-get.json'));
  });

  it('share GET, including an answer whose records derive documents', async () => {
    const res = await shareGet(
      new NextRequest(`http://localhost/api/v2/share/${SHARE_ID}`, { method: 'GET' }),
      { params: Promise.resolve({ id: SHARE_ID }) }
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(fixture('share-get.json'));
  });
});
