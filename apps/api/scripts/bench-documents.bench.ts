import { it, expect, vi } from 'vitest';
import { NextRequest } from 'next/server';

/**
 * Read-cost benchmark for GET /api/v2/threads/{id}/documents (spec 168).
 *
 * Compares the real /documents handler against the real, unmodified thread GET
 * handler on the same pglite thread, in one process. Not part of the test
 * suite; run with:
 *   pnpm vitest run --config scripts/vitest.bench.config.ts
 *
 * Fixture: 50 messages (25 user, 25 assistant). Every assistant row carries
 * spec-168-shaped tool_calls (1-3 rounds, 5-10 results per call) sized to
 * match staging: stored (pg_column_size) median around 5.6 KB, JSON text
 * median around 12.7 KB. About a third of rows add a notice or a legacy record.
 * The script ASSERTS the sizes and that documents were really returned before
 * reporting, so it cannot time a trivial path.
 */

const h = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('@/lib/db/index', () => ({
  get db() {
    return h.db;
  },
  closeDb: async () => {},
}));
vi.mock('@/lib/auth/middleware', () => ({
  authenticateRequest: async () => ({ user: { id: USER_ID } }),
  createErrorResponse: (message: string, status: number) => new Response(JSON.stringify({ error: message }), { status }),
}));
vi.mock('@/lib/ai/thread-naming', () => ({ maybeGenerateThreadName: vi.fn() }));
vi.mock('@/lib/facilitator/agent', () => ({ runFacilitator: vi.fn() }));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));

import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import * as schema from '@/db/schema';
import type { ToolCallRecord } from '@/db/schema';
import { createMessage } from '@/lib/db/threads';
import { GET as threadGet } from '../src/app/api/v2/threads/[id]/route';
import { GET as threadDocsGet } from '../src/app/api/v2/threads/[id]/documents/route';

const USER_ID = '11111111-1111-1111-1111-111111111111';
const THREAD_ID = '22222222-2222-2222-2222-222222222222';

// Deterministic PRNG so runs are comparable.
let seed = 168;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const pick = <T>(xs: T[]) => xs[Math.floor(rand() * xs.length)];
const int = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));

const AR = 'الصبر الصلاة الذين آمنوا استعينوا بالله إن مع العسر يسرا والعاقبة للمتقين قال رسول الله صلى عليه وسلم المؤمن أمره كله خير'.split(' ');
const EN = 'patience prayer believers seek help Allah hardship ease reward righteous messenger said affair of the believer is good in every matter gratitude trial scholars ruling evidence chapter narrated'.split(' ');
const words = (pool: string[], n: number) => Array.from({ length: n }, () => pick(pool)).join(' ');

function entry(tool: string) {
  const text =
    tool === 'search_quran'
      ? JSON.stringify({ ar: words(AR, int(15, 45)), en: words(EN, int(20, 60)) })
      : `${words(EN, int(40, 160))} ${words(AR, int(10, 40))}`;
  return { title: `${tool} ${int(1, 114)}:${int(1, 286)} ${words(EN, 3)}`, context: `Retrieved from ${tool}`, content: text };
}

let toolSeq = 0;
function assistantRecords(i: number): ToolCallRecord[] {
  const out: ToolCallRecord[] = [];
  const rounds = int(1, 3);
  for (let r = 0; r < rounds; r++) {
    const tool = pick(['search_quran', 'search_hadith', 'search_mawsuah', 'search_tafsir_encyclopedia']);
    const id = `tool_${++toolSeq}`;
    const results = Array.from({ length: int(5, 10) }, () => entry(tool));
    out.push({ type: 'tool_use', id, name: tool, input: { query: words(EN, 3) } });
    out.push({
      type: 'tool_result',
      tool_use_id: id,
      content: { results, summary: 'Please see the references below.' },
      status: 'ok',
      duration_ms: int(200, 3000),
      citations: results.map(() => ({ enabled: true })),
    });
  }
  if (i % 3 === 0) {
    const id = `tool_${++toolSeq}`;
    out.push({ type: 'tool_use', id, name: 'search_hadith', input: { query: 'q' } });
    const legacy = i % 6 === 0;
    out.push({
      type: 'tool_result',
      tool_use_id: id,
      content: legacy
        ? { results: [entry('search_hadith')], summary: 's' }
        : { results: [{ title: 'No Results', context: 'Hadith Search', content: 'No results found.' }], summary: 'No hadith found.' },
      status: 'ok',
      duration_ms: 300,
      ...(legacy ? {} : { citations: [{ enabled: false }] }),
    });
  }
  return out;
}

const quantile = (xs: number[], q: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
};

it('thread /documents vs thread GET: latency on a staging-sized 50-message thread', async () => {
  const client = new PGlite();
  h.db = drizzle(client, { schema });
  await client.exec(`
    CREATE TABLE users (id uuid PRIMARY KEY, email text UNIQUE NOT NULL, password_hash text NOT NULL,
      created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now());
    CREATE TABLE threads (id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id), name text,
      source text DEFAULT 'web', client text, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now());
    CREATE TABLE messages (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), thread_id uuid NOT NULL REFERENCES threads(id),
      role text NOT NULL, content jsonb NOT NULL, agent_name text, source text DEFAULT 'web', client text,
      input_tokens integer, output_tokens integer, thinking_tokens integer, total_tokens integer,
      raw_payload jsonb, tool_calls jsonb, model_provider text, model_id text, created_at timestamptz DEFAULT now());
    CREATE INDEX idx_messages_thread ON messages (thread_id, created_at);
  `);
  await client.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, 'b@example.com', 'x')`, [USER_ID]);
  await client.query(`INSERT INTO threads (id, user_id, name) VALUES ($1, $2, 'bench')`, [THREAD_ID, USER_ID]);

  for (let i = 0; i < 25; i++) {
    const t = (s: number) => new Date(Date.UTC(2026, 8, 1, 12, 0, 0) + (2 * i + s) * 1000);
    await createMessage({ threadId: THREAD_ID, role: 'user', content: [{ type: 'text', text: words(EN, 12) }], createdAt: t(0) });
    await createMessage({
      threadId: THREAD_ID,
      role: 'assistant',
      content: [{ type: 'text', text: words(EN, 250) }],
      agentName: 'facilitator',
      toolCalls: assistantRecords(i),
      createdAt: t(1),
    });
  }

  // Guard: the fixture really is staging-sized (not an empty or trivial path).
  const sizes = await client.query<{ stored: number; text: number }>(
    `SELECT pg_column_size(tool_calls) AS stored, octet_length(tool_calls::text) AS text FROM messages WHERE tool_calls IS NOT NULL`
  );
  const stored = sizes.rows.map((r) => Number(r.stored));
  const text = sizes.rows.map((r) => Number(r.text));
  const medStored = quantile(stored, 0.5);
  const medText = quantile(text, 0.5);
  expect(stored).toHaveLength(25);
  expect(medStored).toBeGreaterThan(3_500);
  expect(medStored).toBeLessThan(9_000);
  expect(medText).toBeGreaterThan(9_000);
  expect(medText).toBeLessThan(18_000);

  const ctx = { params: Promise.resolve({ id: THREAD_ID }) };
  const reqOf = (p: string) => new NextRequest(`http://localhost${p}`, { method: 'GET' });
  const variants = {
    threadGet: async () => (await threadGet(reqOf(`/api/v2/threads/${THREAD_ID}`), ctx)).text(),
    documents: async () => (await threadDocsGet(reqOf(`/api/v2/threads/${THREAD_ID}/documents`), ctx)).text(),
  };

  // Guard: derivation actually ran and returned documents.
  const docsBody = JSON.parse(await variants.documents());
  expect(docsBody.messages.length).toBe(25);
  const docCount = docsBody.messages.reduce((n: number, m: { documents: unknown[] }) => n + m.documents.length, 0);
  expect(docCount).toBeGreaterThan(25 * 5);

  const WARMUP = 20;
  const N = 200;
  for (let i = 0; i < WARMUP; i++) {
    await variants.threadGet();
    await variants.documents();
  }
  const times: Record<keyof typeof variants, number[]> = { threadGet: [], documents: [] };
  const bytes: Record<keyof typeof variants, number> = { threadGet: 0, documents: 0 };
  for (let i = 0; i < N; i++) {
    // Alternate order each iteration to cancel drift.
    const order: Array<keyof typeof variants> = i % 2 === 0 ? ['threadGet', 'documents'] : ['documents', 'threadGet'];
    for (const v of order) {
      const t0 = performance.now();
      const body = await variants[v]();
      times[v].push(performance.now() - t0);
      bytes[v] = Buffer.byteLength(body);
    }
  }

  const row = (v: keyof typeof variants) => ({
    median_ms: +quantile(times[v], 0.5).toFixed(3),
    p95_ms: +quantile(times[v], 0.95).toFixed(3),
    response_bytes: bytes[v],
  });
  const report = {
    fixture: {
      assistant_rows: 25,
      stored_bytes_median: medStored,
      stored_bytes_p95: quantile(stored, 0.95),
      text_bytes_median: medText,
      text_bytes_p95: quantile(text, 0.95),
      documents_returned: docCount,
    },
    thread_get: row('threadGet'),
    thread_documents: row('documents'),
    ratio_median: +(quantile(times.documents, 0.5) / quantile(times.threadGet, 0.5)).toFixed(2),
    ratio_p95: +(quantile(times.documents, 0.95) / quantile(times.threadGet, 0.95)).toFixed(2),
  };
  console.log(`BENCH ${JSON.stringify(report, null, 2)}`);
  await client.close();
});
