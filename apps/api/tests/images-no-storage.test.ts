import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { randomBytes } from 'node:crypto';

/**
 * Image bytes are never stored — spec 211.
 *
 * Drives the ACTUAL chat route and the ACTUAL facilitator against pglite,
 * mocking only the boundaries: auth, the Gemini/Inkling transports, the search
 * tools, thread naming and Sentry. After a successful turn (with a tool round,
 * so `tool_calls` and `raw_payload` are populated) and a failed turn (so a
 * `tool_call_orphans` row is written), every column of every row is scanned
 * for any 64-character window of the image's base64. The scan itself is
 * negative-tested (lessons-critical): it must flag a planted row and must not
 * flag a placeholder.
 */

type AnyEvent = { type: string; data?: unknown; response?: unknown };

const h = vi.hoisted(() => ({
  db: null as unknown,
  scripts: [] as Array<() => AsyncGenerator<AnyEvent>>,
  geminiMessages: [] as unknown[],
  geminiHistories: [] as unknown[],
}));

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
    new Response(JSON.stringify({ error: message }), { status }),
}));

vi.mock('@/lib/ai/thread-naming', () => ({ maybeGenerateThreadName: vi.fn() }));

vi.mock('@sentry/nextjs', () => ({
  setTag: vi.fn(),
  captureException: vi.fn(),
  captureMessage: vi.fn(),
  addBreadcrumb: vi.fn(),
}));

vi.mock('@/lib/config', () => ({
  config: {
    gemini: { model: 'primary-model', fallbackModel: 'fallback-model' },
    inkling: { model: 'inkling' },
    primaryBackend: 'gemini',
  },
}));

function doneResponse(text: string, toolCalls: Array<{ name: string; args: unknown }> = []) {
  return {
    text,
    toolCalls,
    rawPayload: { role: 'model', parts: text ? [{ text }] : [] },
    allParts: text ? [{ text }] : toolCalls.map((c) => ({ functionCall: c })),
    hasThinking: false,
    usage: { promptTokenCount: 1, candidatesTokenCount: 1, thoughtsTokenCount: 0, totalTokenCount: 2 },
    finishReason: 'STOP',
  };
}

const toolRound = () =>
  async function* (): AsyncGenerator<AnyEvent> {
    yield { type: 'tool_call', data: { name: 'search_quran', args: { query: 'q' } } };
    yield { type: 'done', response: doneResponse('', [{ name: 'search_quran', args: { query: 'q' } }]) };
  };
const textRound = (text: string) =>
  async function* (): AsyncGenerator<AnyEvent> {
    yield { type: 'text', data: text };
    yield { type: 'done', response: doneResponse(text) };
  };
const throwingRound = () =>
  // eslint-disable-next-line require-yield
  async function* (): AsyncGenerator<AnyEvent> {
    throw new Error('vertex 500');
  };

vi.mock('@/lib/ai/gemini-client', () => ({
  streamGemini: vi.fn((message: unknown, options: { history?: unknown[] }) => {
    h.geminiMessages.push(message);
    h.geminiHistories.push(structuredClone(options.history ?? []));
    const script = h.scripts.shift();
    return (script ?? textRound('default'))();
  }),
}));

vi.mock('@/lib/ai/inkling-client', () => ({
  isInklingConfigured: () => false,
  streamInkling: vi.fn(),
}));

vi.mock('@/lib/tools', () => ({
  getGeminiToolDescriptions: () => [{ name: 'search_quran' }],
  createToolMap: () =>
    new Map([
      [
        'search_quran',
        {
          run: async () => ({
            content: 'result',
            documents: [
              {
                type: 'document',
                source: { type: 'text', media_type: 'text/plain', data: 'verse' },
                title: 'Al-Baqarah 2:255',
                context: 'Quran',
                citations: { enabled: true },
              },
            ],
          }),
        },
      ],
    ]),
}));

import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import * as schema from '@/db/schema';
import { imageUnavailableNote } from '@/lib/facilitator/agent';
import { POST as chatPost } from '../src/app/api/v2/threads/[id]/chat/route';

let client: PGlite;

const USER_ID = '11111111-1111-1111-1111-111111111111';
const THREAD_ID = '22222222-2222-2222-2222-222222222222';
const ctx = { params: Promise.resolve({ id: THREAD_ID }) };

// A distinctive payload: a real PNG signature followed by random bytes, so any
// stored fragment of it is unambiguous.
const IMAGE_B64 = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  randomBytes(3000),
]).toString('base64');

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
  await client.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3)`, [
    USER_ID,
    'images@example.com',
    'x',
  ]);
});

afterAll(async () => {
  await client.close();
});

beforeEach(async () => {
  vi.clearAllMocks();
  h.scripts = [];
  h.geminiMessages = [];
  h.geminiHistories = [];
  mockAuthenticateRequest.mockResolvedValue({ user: { id: USER_ID } });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  await client.exec('DELETE FROM threads');
  await client.query(`INSERT INTO threads (id, user_id) VALUES ($1, $2)`, [THREAD_ID, USER_ID]);
});

function chatReq(body: unknown): NextRequest {
  return new NextRequest(`http://localhost/api/v2/threads/${THREAD_ID}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function send(body: unknown): Promise<string> {
  const res = await chatPost(chatReq(body), ctx);
  expect(res.status).toBe(200);
  return res.text();
}

/** Every row of both tables, every column, as one string per row. */
async function dumpRows(): Promise<string[]> {
  const m = await client.query('SELECT * FROM messages');
  const o = await client.query('SELECT * FROM tool_call_orphans');
  return [...m.rows, ...o.rows].map((r) => JSON.stringify(r));
}

/** Rows containing any 64-char window of the payload (step 16 keeps it cheap). */
function rowsLeaking(rows: string[], payload: string): string[] {
  const windows: string[] = [];
  for (let i = 0; i + 64 <= payload.length; i += 16) windows.push(payload.slice(i, i + 64));
  return rows.filter((row) => windows.some((w) => row.includes(w)));
}

/** Orphans are written after the stream closes; wait for the write to land. */
async function waitForOrphans(n: number) {
  for (let i = 0; i < 50; i++) {
    const r = await client.query('SELECT count(*)::int AS c FROM tool_call_orphans');
    if ((r.rows[0] as { c: number }).c >= n) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('orphan row never landed');
}

describe('the leak scan is live (negative-tested)', () => {
  it('flags a planted row carrying the payload, and not a placeholder', () => {
    const planted = JSON.stringify({ content: [{ type: 'image', data: IMAGE_B64.slice(100, 200) }] });
    const placeholder = JSON.stringify({ content: [{ type: 'image', status: 'not_stored', media_type: 'image/png' }] });
    expect(rowsLeaking([planted, placeholder], IMAGE_B64)).toEqual([planted]);
  });
});

describe('image bytes never reach the database (spec 211)', () => {
  it('successful image turn with a tool round: placeholder stored, no bytes anywhere', async () => {
    h.scripts = [toolRound(), textRound('This is Ayat al-Kursi.')];

    const sse = await send({ message: 'What is this?', images: [{ media_type: 'image/png', data: IMAGE_B64 }] });

    expect(sse).toContain('"type":"done"');
    // The model did see the image, on the current turn.
    expect(h.geminiMessages[0]).toEqual([
      { text: 'What is this?' },
      { inlineData: { mimeType: 'image/png', data: IMAGE_B64 } },
    ]);
    const rows = await dumpRows();
    expect(rows).toHaveLength(2); // user + assistant (with tool_calls and raw_payload)
    expect(rowsLeaking(rows, IMAGE_B64)).toEqual([]);
    const user = await client.query(`SELECT content FROM messages WHERE role = 'user'`);
    expect((user.rows[0] as { content: unknown }).content).toEqual([
      { type: 'text', text: 'What is this?' },
      { type: 'image', status: 'not_stored', media_type: 'image/png' },
    ]);
  });

  it('failed image turn after a tool round: orphan row written, no bytes anywhere', async () => {
    h.scripts = [toolRound(), throwingRound()];

    const sse = await send({ message: 'What is this?', images: [{ media_type: 'image/png', data: IMAGE_B64 }] });

    expect(sse).toContain('"type":"error"');
    await waitForOrphans(1);
    const rows = await dumpRows();
    expect(rows).toHaveLength(2); // user + orphan
    expect(rowsLeaking(rows, IMAGE_B64)).toEqual([]);
  });

  it('the next turn tells the model the image is gone and re-sends no bytes', async () => {
    h.scripts = [textRound('This is Ayat al-Kursi.')];
    await send({ message: 'What is this?', images: [{ media_type: 'image/png', data: IMAGE_B64 }] });
    h.scripts = [textRound('Surah al-Baqarah.')];
    h.geminiHistories = [];

    await send({ message: 'Which surah?' });

    const history = h.geminiHistories[0];
    expect(history).toEqual([
      { role: 'user', parts: [{ text: 'What is this?' }, { text: imageUnavailableNote(1) }] },
      { role: 'model', parts: [{ text: 'This is Ayat al-Kursi.' }] },
    ]);
    expect(JSON.stringify(history)).not.toContain(IMAGE_B64.slice(0, 64));
  });
});
