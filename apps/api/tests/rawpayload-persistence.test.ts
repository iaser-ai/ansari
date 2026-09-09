import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

/**
 * rawPayload persistence round-trip against a REAL database (issue #70).
 *
 * The whole point of the fix is that the final model turn's Content survives
 * jsonb persistence and comes back verbatim for turn 2+ — so these tests run
 * the ACTUAL route handler and the ACTUAL db helpers against pglite, mocking
 * only the boundaries (auth, facilitator, thread-naming, Sentry). Per
 * lessons-critical.md: transactional/persistence behavior is tested against a
 * real DB, not mocks.
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

import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import * as schema from '@/db/schema';
import type { Content } from '@google/genai';
import { createMessage, findMessagesByThread } from '@/lib/db/threads';
import { POST as threadPost } from '../src/app/api/v2/threads/[id]/route';

let client: PGlite;

const USER_ID = '11111111-1111-1111-1111-111111111111';
const THREAD_ID = '22222222-2222-2222-2222-222222222222';

// A realistic final model turn: Arabic text + an opaque thought signature —
// the exact shape whose loss forces the text-only fallback today.
const RAW_PAYLOAD: Content = {
  role: 'model',
  parts: [
    { text: 'الصبر نصف الإيمان، كما ورد في الأثر.' },
    { text: 'Patience is half of faith.', thoughtSignature: 'c2lnbmF0dXJlLWJsb2I=' },
  ],
};

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
  `);
  await client.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3)`, [
    USER_ID,
    'sabr@example.com',
    'x',
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

async function drain(res: Response): Promise<void> {
  const reader = res.body?.getReader();
  if (!reader) return;
  for (;;) {
    const { done } = await reader.read();
    if (done) break;
  }
}

function postReq(content: string): NextRequest {
  return new NextRequest(`http://localhost/api/v2/threads/${THREAD_ID}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  });
}

const ctx = { params: Promise.resolve({ id: THREAD_ID }) };

function facilitatorEmitting(text: string, rawPayload: Content | null) {
  return async function* () {
    yield { type: 'text' as const, data: text };
    yield {
      type: 'done' as const,
      data: '',
      usage: { promptTokenCount: 3, candidatesTokenCount: 5, thoughtsTokenCount: 1, totalTokenCount: 9 },
      rawPayload,
    };
  };
}

describe('db helpers round-trip raw_payload jsonb (real pglite)', () => {
  it('persists and reads back a signature-bearing Content verbatim, incl. non-ASCII', async () => {
    await createMessage({
      threadId: THREAD_ID,
      role: 'assistant',
      content: [{ type: 'text', text: 'answer' }],
      rawPayload: RAW_PAYLOAD,
    });

    const rows = await findMessagesByThread(THREAD_ID);
    expect(rows).toHaveLength(1);
    expect(rows[0].rawPayload).toEqual(RAW_PAYLOAD);
  });

  it('stores NULL when no rawPayload is given (user messages, legacy shape)', async () => {
    await createMessage({
      threadId: THREAD_ID,
      role: 'user',
      content: [{ type: 'text', text: 'question' }],
    });

    const rows = await findMessagesByThread(THREAD_ID);
    expect(rows[0].rawPayload).toBeNull();
  });
});

describe('POST /api/v2/threads/[id] — persist on turn 1, replay on turn 2 (real route + pglite)', () => {
  it('writes the done event rawPayload to the assistant row', async () => {
    mockRunFacilitator.mockImplementation(() => facilitatorEmitting('Sabr is patience.', RAW_PAYLOAD)());

    const res = await threadPost(postReq('What is sabr?'), ctx);
    expect(res.status).toBe(200);
    await drain(res);

    const rows = await findMessagesByThread(THREAD_ID);
    const assistant = rows.find((r) => r.role === 'assistant');
    expect(assistant).toBeDefined();
    // content stays the aggregate streamed text (unchanged behavior)...
    expect(assistant?.content).toEqual([{ type: 'text', text: 'Sabr is patience.' }]);
    // ...and the payload landed, byte-faithful through jsonb.
    expect(assistant?.rawPayload).toEqual(RAW_PAYLOAD);
  });

  it('hands the stored rawPayload back to the facilitator on the next turn', async () => {
    mockRunFacilitator.mockImplementation(() => facilitatorEmitting('Sabr is patience.', RAW_PAYLOAD)());
    await drain(await threadPost(postReq('What is sabr?'), ctx));

    mockRunFacilitator.mockImplementation(() => facilitatorEmitting('As I said before…', null)());
    await drain(await threadPost(postReq('Say more'), ctx));

    // Turn 2's messageHistory carries the persisted payload on the assistant turn —
    // the condition for convertToGeminiHistory's rawPayload branch.
    const turn2History = mockRunFacilitator.mock.calls[1][0] as Array<{
      role: string;
      rawPayload?: Content | null;
    }>;
    const assistantTurn = turn2History.find((m) => m.role === 'assistant');
    expect(assistantTurn?.rawPayload).toEqual(RAW_PAYLOAD);
    // And the user turns still carry none.
    expect(turn2History.filter((m) => m.role === 'user').every((m) => m.rawPayload === null)).toBe(true);
  });

  it('a null done rawPayload (guard-rejected or legacy) persists NULL, not junk', async () => {
    mockRunFacilitator.mockImplementation(() => facilitatorEmitting('Answer.', null)());

    await drain(await threadPost(postReq('question'), ctx));

    const rows = await findMessagesByThread(THREAD_ID);
    const assistant = rows.find((r) => r.role === 'assistant');
    expect(assistant?.rawPayload).toBeNull();
  });
});
