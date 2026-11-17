import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

/**
 * Thread history notices as the clients read them back — issue #400.
 *
 * The web app re-reads the thread after every answer, and the legacy mobile app on
 * reopening it, so the warning and the block must be in what thread GET returns,
 * in the frozen shape: `content` a bare string. Run through the real POST and GET
 * handlers and the real db helpers against pglite; only auth, thread naming and
 * the model are stubbed.
 */

const h = vi.hoisted(() => ({ db: null as unknown }));

vi.mock('@/lib/db/index', () => ({
  get db() {
    return h.db;
  },
  closeDb: async () => {},
}));

const mockAuthenticate = vi.fn();
vi.mock('@/lib/error-response', () => ({
  createErrorResponse: (message: string, status: number) =>
    new Response(JSON.stringify({ error: message }), {
      status,
      headers: { 'Content-Type': 'application/json' },
    }),
}));
vi.mock('@/lib/auth/require-user', () => ({
  requireUser: (...a: unknown[]) => mockAuthenticate(...a),
}));

vi.mock('@/lib/ai/thread-naming', () => ({ maybeGenerateThreadName: vi.fn() }));
const mockRunFacilitator = vi.fn();
vi.mock('@/lib/facilitator/agent', () => ({
  runFacilitator: (...args: unknown[]) => mockRunFacilitator(...args),
}));
vi.mock('@sentry/nextjs', () => ({ setTag: vi.fn(), captureException: vi.fn(), captureMessage: vi.fn() }));

import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import * as schema from '@/db/schema';
import { resetEnvCache } from '@/lib/config';
import { HISTORY_BLOCK_MESSAGE, HISTORY_WARNING_MESSAGE } from '@/lib/facilitator/history-limit';
import { GET as threadGet, POST as threadPost } from '../src/app/api/v2/threads/[id]/route';
import { POST as chatPost } from '../src/app/api/v2/threads/[id]/chat/route';

let client: PGlite;

const USER_ID = '11111111-1111-1111-1111-111111111111';
const THREAD_ID = '22222222-2222-2222-2222-222222222222';
const ANSWER = 'Sabr means patience.';
const MESSAGE_KEYS = ['agent_name', 'content', 'created_at', 'id', 'role', 'source'];

const routeContext = { params: Promise.resolve({ id: THREAD_ID }) };

function post(url: string, body: unknown): NextRequest {
  return new NextRequest(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** Send one message through the SSE route and read the stream to its end. */
async function chat(message: string): Promise<string> {
  const response = await chatPost(post(`http://localhost/api/v2/threads/${THREAD_ID}/chat`, { message }), routeContext);
  expect(response.status).toBe(200);
  return response.text();
}

/** The thread as a client reads it: the parsed GET body's messages. */
async function storedMessages(): Promise<Array<Record<string, unknown>>> {
  const response = await threadGet(new NextRequest(`http://localhost/api/v2/threads/${THREAD_ID}`), routeContext);
  expect(response.status).toBe(200);
  return (await response.json()).messages;
}

const answersOf = (messages: Array<Record<string, unknown>>) =>
  messages.filter((m) => m.role === 'assistant').map((m) => m.content);

beforeAll(async () => {
  client = new PGlite();
  h.db = drizzle(client, { schema });
  await client.exec(`
    CREATE TABLE users (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      email text UNIQUE NOT NULL,
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
});

afterAll(async () => {
  await client.close();
});

beforeEach(async () => {
  vi.clearAllMocks();
  // Warn from 100 and block from 200 estimated tokens: 400 and 800 bytes of text.
  vi.stubEnv('THREAD_HISTORY_WARN_TOKENS', '100');
  vi.stubEnv('THREAD_HISTORY_BLOCK_TOKENS', '200');
  resetEnvCache();
  mockAuthenticate.mockResolvedValue({ user: { id: USER_ID, email: 'u@example.com' } });
  mockRunFacilitator.mockImplementation(async function* () {
    yield { type: 'text' as const, data: ANSWER };
    yield { type: 'done' as const, data: '' };
  });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  await client.exec('DELETE FROM users');
  await client.query('INSERT INTO users (id, email) VALUES ($1, $2)', [USER_ID, 'u@example.com']);
  await client.query('INSERT INTO threads (id, user_id) VALUES ($1, $2)', [THREAD_ID, USER_ID]);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  resetEnvCache();
});

describe('a thread growing past both thresholds, as thread GET returns it', () => {
  it('short: the answer alone. Long: answer and warning. Too long: the block message. Always a bare string', async () => {
    // Turn 1, a short thread.
    await chat('What is sabr?');
    expect(answersOf(await storedMessages())).toEqual([ANSWER]);

    // Turn 2 takes the history past 100 estimated tokens: answered, with the warning.
    const warned = await chat('a'.repeat(500));
    expect(warned).toContain(JSON.stringify(`\n\n${HISTORY_WARNING_MESSAGE}`));
    expect(mockRunFacilitator).toHaveBeenCalledTimes(2);
    const WARNED_ANSWER = `${ANSWER}\n\n${HISTORY_WARNING_MESSAGE}`;
    expect(answersOf(await storedMessages()).sort()).toEqual([ANSWER, WARNED_ANSWER].sort());

    // Turn 3 takes it past 200: no model call, and the block message is the answer.
    const blocked = await chat('b'.repeat(400));
    expect(blocked).toContain(JSON.stringify(HISTORY_BLOCK_MESSAGE));
    expect(blocked).toContain('"type":"done"');
    expect(blocked).not.toContain('"type":"error"');
    expect(mockRunFacilitator).toHaveBeenCalledTimes(2);

    // Turn 4, on the raw-text route the legacy mobile app uses: still blocked.
    const raw = await threadPost(post(`http://localhost/api/v2/threads/${THREAD_ID}`, { content: 'And now?' }), routeContext);
    expect(await raw.text()).toBe(HISTORY_BLOCK_MESSAGE);
    expect(mockRunFacilitator).toHaveBeenCalledTimes(2);

    // What a client reads back: four questions, four answers, every one a bare string
    // under the six frozen keys. The thread never ends on an unanswered question, which
    // is what the web app would turn into its retry row.
    const messages = await storedMessages();
    expect(messages).toHaveLength(8);
    for (const message of messages) {
      expect(Object.keys(message).sort()).toEqual(MESSAGE_KEYS);
      expect(typeof message.content).toBe('string');
    }
    expect(messages.filter((m) => m.role === 'user')).toHaveLength(4);
    expect(answersOf(messages).sort()).toEqual(
      [ANSWER, WARNED_ANSWER, HISTORY_BLOCK_MESSAGE, HISTORY_BLOCK_MESSAGE].sort()
    );
  });

  it('a block message is stored as a plain assistant row: one text block, no usage, no payload, no model', async () => {
    await chat('c'.repeat(800));

    const { rows } = await client.query<Record<string, unknown>>(
      `SELECT content, agent_name, input_tokens, output_tokens, thinking_tokens, total_tokens,
              raw_payload, tool_calls, model_provider, model_id
       FROM messages WHERE role = 'assistant'`
    );
    expect(rows).toEqual([
      {
        content: [{ type: 'text', text: HISTORY_BLOCK_MESSAGE }],
        agent_name: 'facilitator',
        input_tokens: null,
        output_tokens: null,
        thinking_tokens: null,
        total_tokens: null,
        raw_payload: null,
        tool_calls: null,
        model_provider: null,
        model_id: null,
      },
    ]);
    expect(mockRunFacilitator).not.toHaveBeenCalled();
  });
});
