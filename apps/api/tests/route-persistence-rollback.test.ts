import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

// Issue #20 (PR #26): the first real Executor consumers. Both ingestion routes
// wrap thread-creation + inbound-message persistence in db.transaction, so a
// partial failure cannot orphan a thread. Exercised through the ACTUAL route
// boundary against pglite: a CHECK constraint on messages.content (sentinel
// '__BOOM__') forces the message insert to fail mid-transaction, and the tests
// assert neither thread nor messages remain.

const h = vi.hoisted(() => ({ db: null as unknown }));

vi.mock('@/lib/db/index', () => ({
  get db() {
    return h.db;
  },
  closeDb: async () => {},
}));

const SYSTEM_USER_ID = '44444444-4444-4444-4444-444444444444';
vi.mock('@/lib/db/users', () => ({
  getOrCreateSystemUser: async () => ({
    id: '44444444-4444-4444-4444-444444444444',
    email: 'system@system.ansari.chat',
    passwordHash: 'nologin',
  }),
}));

const mockRunFacilitator = vi.fn();
vi.mock('@/lib/facilitator/agent', () => ({
  runFacilitator: (...args: unknown[]) => mockRunFacilitator(...args),
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

const API_KEY = 'rollback-test-leaderboard-key-at-least-32-chars';
vi.mock('@/lib/config', () => ({
  config: { leaderboard: { apiKey: 'rollback-test-leaderboard-key-at-least-32-chars' } },
}));

vi.mock('@/lib/ai/inkling-client', () => ({
  isInklingConfigured: () => false,
}));

import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import * as schema from '@/db/schema';
import { POST as mcpPost } from '../src/app/api/v2/mcp-complete/route';
import { POST as chatPost } from '../src/app/api/v1/chat/completions/route';

let client: PGlite;

async function* facilitatorEmits(text: string) {
  yield { type: 'text' as const, data: text };
  yield { type: 'done' as const, data: '', usage: undefined };
}

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
      content jsonb NOT NULL CHECK (content::text NOT LIKE '%__BOOM__%'),
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
  `);
  await client.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3)`, [
    SYSTEM_USER_ID,
    'system@system.ansari.chat',
    'nologin',
  ]);
});

afterAll(async () => {
  await client.close();
});

beforeEach(async () => {
  vi.clearAllMocks();
  mockRunFacilitator.mockImplementation(() => facilitatorEmits('A fine answer.'));
  await client.exec('DELETE FROM threads');
});

async function countRows(table: 'threads' | 'messages'): Promise<number> {
  const result = await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`);
  return result.rows[0].n;
}

describe('POST /api/v2/mcp-complete — atomic inbound persistence', () => {
  function makeRequest(messages: Array<{ role: string; content: string }>): NextRequest {
    return new NextRequest('http://localhost/api/v2/mcp-complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages }),
    });
  }

  it('persists thread + inbound messages when nothing fails (harness sanity)', async () => {
    const res = await mcpPost(
      makeRequest([
        { role: 'user', content: 'first question' },
        { role: 'assistant', content: 'earlier answer' },
        { role: 'user', content: 'follow-up' },
      ])
    );
    expect(res.status).toBe(200);
    expect(await countRows('threads')).toBe(1);
    // 3 inbound + 1 assistant response
    expect(await countRows('messages')).toBe(4);
  });

  it('a failed inbound-message insert leaves NO thread and NO messages behind', async () => {
    const res = await mcpPost(
      makeRequest([
        { role: 'user', content: 'this one persists fine' },
        { role: 'user', content: 'this one hits the constraint __BOOM__' },
      ])
    );
    // The route treats DB persistence as fatal: 500, and the facilitator never ran.
    expect(res.status).toBe(500);
    expect(mockRunFacilitator).not.toHaveBeenCalled();
    // The transaction rolled back the thread AND the first (successful) insert.
    expect(await countRows('threads')).toBe(0);
    expect(await countRows('messages')).toBe(0);
  });
});

describe('POST /v1/chat/completions — atomic inbound persistence', () => {
  function makeRequest(messages: Array<{ role: string; content: string }>): NextRequest {
    return new NextRequest('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        authorization: `Bearer ${API_KEY}`,
      },
      body: JSON.stringify({ model: 'ansari-facilitator', messages }),
    });
  }

  it('persists thread + inbound messages when nothing fails (harness sanity)', async () => {
    const res = await chatPost(
      makeRequest([
        { role: 'user', content: 'first question' },
        { role: 'user', content: 'second question' },
      ])
    );
    expect(res.status).toBe(200);
    expect(await countRows('threads')).toBe(1);
    // 2 inbound + 1 assistant response
    expect(await countRows('messages')).toBe(3);
  });

  it('a failed inbound-message insert leaves NO thread and NO messages behind (logging is non-fatal)', async () => {
    const res = await chatPost(
      makeRequest([
        { role: 'user', content: 'this one persists fine' },
        { role: 'user', content: 'this one hits the constraint __BOOM__' },
      ])
    );
    // DB logging is non-fatal on this route: the caller still gets their answer…
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.choices[0].message.content).toBe('A fine answer.');
    // …but the transaction rolled back the thread AND the first insert, and no
    // assistant message was attached to a partial log (threadId stayed undefined).
    expect(await countRows('threads')).toBe(0);
    expect(await countRows('messages')).toBe(0);
  });
});
