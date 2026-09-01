import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import { readFileSync } from 'fs';
import path from 'path';

// Issue #87: POST /api/v2/feedback is idempotent per (user, message, class).
// Exercised against pglite with the real unique index and the real upsert —
// a mocked test could not prove ON CONFLICT hits the right key or that the
// comment guard survives a bare repeat POST.

const h = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('@/lib/db/index', () => ({
  get db() {
    return h.db;
  },
  closeDb: async () => {},
}));

const mockAuthenticateRequest = vi.fn();
vi.mock('@/lib/auth/middleware', () => ({
  authenticateRequest: (...args: unknown[]) => mockAuthenticateRequest(...args),
  createErrorResponse: (detail: string, status: number) =>
    NextResponse.json({ detail }, { status }),
}));

import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import * as schema from '@/db/schema';
import { POST } from '../src/app/api/v2/feedback/route';

let client: PGlite;

const USER_ID = '11111111-1111-4111-8111-111111111111';
const THREAD_ID = '22222222-2222-4222-8222-222222222222';
const MESSAGE_ID = '33333333-3333-4333-8333-333333333333';

const FEEDBACK_DDL = `
  CREATE TABLE feedback (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    thread_id uuid NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
    message_id uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    feedback_class text NOT NULL,
    comment text,
    created_at timestamp with time zone DEFAULT now()
  );
  CREATE UNIQUE INDEX idx_feedback_user_message_class
    ON feedback (user_id, message_id, feedback_class);
`;

const BASE_DDL = `
  CREATE TABLE users (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email text UNIQUE NOT NULL,
    password_hash text NOT NULL,
    first_name text, last_name text, source text DEFAULT 'web', registered_via text,
    is_admin boolean NOT NULL DEFAULT false, system_key text, session_version integer NOT NULL DEFAULT 0,
    created_at timestamp with time zone DEFAULT now(), updated_at timestamp with time zone DEFAULT now()
  );
  CREATE TABLE threads (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name text, source text DEFAULT 'web', client text,
    created_at timestamp with time zone DEFAULT now(), updated_at timestamp with time zone DEFAULT now()
  );
  CREATE TABLE messages (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    thread_id uuid NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
    role text NOT NULL, content jsonb NOT NULL, agent_name text, source text DEFAULT 'web', client text,
    input_tokens integer, output_tokens integer, thinking_tokens integer, total_tokens integer, raw_payload jsonb, tool_calls jsonb,
    created_at timestamp with time zone DEFAULT now()
  );
`;

beforeAll(async () => {
  client = new PGlite();
  h.db = drizzle(client, { schema });
  await client.exec(BASE_DDL + FEEDBACK_DDL);
  await client.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, 'fb@x.com', 'h')`, [
    USER_ID,
  ]);
  await client.query(`INSERT INTO threads (id, user_id) VALUES ($1, $2)`, [THREAD_ID, USER_ID]);
  await client.query(
    `INSERT INTO messages (id, thread_id, role, content) VALUES ($1, $2, 'assistant', '[]'::jsonb)`,
    [MESSAGE_ID, THREAD_ID]
  );
});

afterAll(async () => {
  await client.close();
});

beforeEach(async () => {
  vi.clearAllMocks();
  mockAuthenticateRequest.mockResolvedValue({ user: { id: USER_ID, email: 'fb@x.com' } });
  await client.query('DELETE FROM feedback');
});

function makeRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost/api/v2/feedback', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t' },
    body: JSON.stringify(body),
  });
}

function post(overrides: Record<string, unknown> = {}) {
  return POST(
    makeRequest({
      thread_id: THREAD_ID,
      message_id: MESSAGE_ID,
      feedback_class: 'thumbs_up',
      ...overrides,
    })
  );
}

async function countFeedback(): Promise<number> {
  const r = await client.query<{ n: number }>('SELECT count(*)::int AS n FROM feedback');
  return r.rows[0].n;
}

describe('upsert round-trip (idempotent per user/message/class)', () => {
  it('two POSTs for the same (user, message, class) yield one row with the same id', async () => {
    const first = await (await post()).json();
    const res2 = await post();
    expect(res2.status).toBe(200);
    const second = await res2.json();

    expect(second.id).toBe(first.id);
    expect(await countFeedback()).toBe(1);
  });

  it('created_at stays first-touch on a repeat POST', async () => {
    const first = await (await post()).json();
    const firstTouch = '2026-01-01T00:00:00.000Z';
    await client.query('UPDATE feedback SET created_at = $1 WHERE id = $2', [
      firstTouch,
      first.id,
    ]);

    const second = await (await post({ comment: 'later thoughts' })).json();
    expect(second.id).toBe(first.id);
    expect(second.created_at).toBe(firstTouch);
  });
});

describe('comment guard', () => {
  it('a bare repeat POST never erases an existing comment', async () => {
    await post({ comment: 'excellent answer' });
    const bare = await (await post()).json();
    expect(bare.comment).toBe('excellent answer');
    expect(await countFeedback()).toBe(1);
  });

  it('an empty-string repeat comment never erases an existing comment', async () => {
    await post({ comment: 'excellent answer' });
    const empty = await (await post({ comment: '' })).json();
    expect(empty.comment).toBe('excellent answer');
  });

  it('bare POST then commented POST: the comment lands on the same row', async () => {
    const first = await (await post()).json();
    expect(first.comment).toBeNull();

    const second = await (await post({ comment: 'chips: helpful, accurate' })).json();
    expect(second.id).toBe(first.id);
    expect(second.comment).toBe('chips: helpful, accurate');
    expect(await countFeedback()).toBe(1);
  });

  it('a newer non-empty comment replaces the old one', async () => {
    await post({ comment: 'first draft' });
    const updated = await (await post({ comment: 'revised opinion' })).json();
    expect(updated.comment).toBe('revised opinion');
  });
});

describe('class coexistence', () => {
  it('thumbs_up and thumbs_down coexist as two rows on one message', async () => {
    const up = await (await post({ feedback_class: 'thumbs_up' })).json();
    const down = await (await post({ feedback_class: 'thumbs_down' })).json();
    expect(down.id).not.toBe(up.id);
    expect(await countFeedback()).toBe(2);
  });

  it('report is independent of thumbs on the same message', async () => {
    await post({ feedback_class: 'thumbs_up' });
    await post({ feedback_class: 'thumbs_down' });
    const report = await (await post({ feedback_class: 'report' })).json();
    expect(report.feedback_class).toBe('report');
    expect(await countFeedback()).toBe(3);

    // And report itself upserts rather than duplicating.
    const again = await (await post({ feedback_class: 'report' })).json();
    expect(again.id).toBe(report.id);
    expect(await countFeedback()).toBe(3);
  });
});

describe('wire contract unchanged (mobile app in the wild)', () => {
  it('success response carries exactly the frozen key set', async () => {
    const res = await post({ comment: 'hi' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual([
      'comment',
      'created_at',
      'feedback_class',
      'id',
      'message_id',
      'thread_id',
    ]);
    expect(body.thread_id).toBe(THREAD_ID);
    expect(body.message_id).toBe(MESSAGE_ID);
    expect(body.feedback_class).toBe('thumbs_up');
  });

  it('404 for a nonexistent message: same status and body as today, no row written', async () => {
    const res = await post({ message_id: '99999999-9999-4999-8999-999999999999' });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ detail: 'Message not found' });
    expect(await countFeedback()).toBe(0);
  });

  it('422 for an invalid feedback_class: same status and body shape as today', async () => {
    const res = await post({ feedback_class: 'wat' });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(Object.keys(body)).toEqual(['detail']);
    expect(await countFeedback()).toBe(0);
  });
});

describe('at-rest guarantee (unique index, not just route behavior)', () => {
  it('a direct duplicate INSERT violates the unique index', async () => {
    await post();
    await expect(
      client.query(
        `INSERT INTO feedback (user_id, thread_id, message_id, feedback_class)
         VALUES ($1, $2, $3, 'thumbs_up')`,
        [USER_ID, THREAD_ID, MESSAGE_ID]
      )
    ).rejects.toThrow(/duplicate key|unique/i);
  });
});

// The migration's hand-written dedup DELETE, executed verbatim from the file —
// survivorship must be: non-empty comment > latest created_at > lowest id.
describe('migration 0006: dedup DELETE then unique index', () => {
  let mig: PGlite;

  const U = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const T = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const M1 = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const M2 = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  const M3 = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
  const M4 = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

  const row = (id: string, msg: string, comment: string | null, createdAt: string) =>
    mig.query(
      `INSERT INTO feedback (id, user_id, thread_id, message_id, feedback_class, comment, created_at)
       VALUES ($1, $2, $3, $4, 'thumbs_up', $5, $6)`,
      [id, U, T, msg, comment, createdAt]
    );

  beforeAll(async () => {
    mig = new PGlite();
    // Same tables, WITHOUT the unique index — the pre-migration state.
    await mig.exec(
      BASE_DDL + FEEDBACK_DDL.replace(/CREATE UNIQUE INDEX[\s\S]*?;/, '')
    );
    await mig.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, 'm@x.com', 'h')`, [U]);
    await mig.query(`INSERT INTO threads (id, user_id) VALUES ($1, $2)`, [T, U]);
    for (const m of [M1, M2, M3, M4]) {
      await mig.query(
        `INSERT INTO messages (id, thread_id, role, content) VALUES ($1, $2, 'assistant', '[]'::jsonb)`,
        [m, T]
      );
    }

    // Group 1 (M1): non-empty comment beats a NEWER bare row.
    await row('00000000-0000-4000-8000-000000000001', M1, 'keep me', '2026-01-01T00:00:00Z');
    await row('00000000-0000-4000-8000-000000000002', M1, null, '2026-02-01T00:00:00Z');
    await row('00000000-0000-4000-8000-000000000003', M1, '', '2026-03-01T00:00:00Z');
    // Group 2 (M2): all bare — latest created_at wins.
    await row('00000000-0000-4000-8000-000000000011', M2, null, '2026-01-01T00:00:00Z');
    await row('00000000-0000-4000-8000-000000000012', M2, null, '2026-02-01T00:00:00Z');
    // Group 3 (M3): full tie — lowest id wins.
    await row('00000000-0000-4000-8000-000000000021', M3, null, '2026-01-01T00:00:00Z');
    await row('00000000-0000-4000-8000-000000000022', M3, null, '2026-01-01T00:00:00Z');
    // M4: no duplicate — must be untouched.
    await row('00000000-0000-4000-8000-000000000031', M4, 'lone row', '2026-01-01T00:00:00Z');
  });

  afterAll(async () => {
    await mig.close();
  });

  it('keeps exactly the best row per group and then builds the index', async () => {
    const migrationSql = readFileSync(
      path.join(__dirname, '../drizzle/0006_feedback_dedupe_upsert.sql'),
      'utf8'
    );
    for (const statement of migrationSql.split('--> statement-breakpoint')) {
      await mig.exec(statement);
    }

    const survivors = await mig.query<{ id: string }>(
      'SELECT id FROM feedback ORDER BY id'
    );
    expect(survivors.rows.map((r) => r.id)).toEqual([
      '00000000-0000-4000-8000-000000000001', // M1: the non-empty comment
      '00000000-0000-4000-8000-000000000012', // M2: latest created_at
      '00000000-0000-4000-8000-000000000021', // M3: lowest id
      '00000000-0000-4000-8000-000000000031', // M4: untouched
    ]);

    // The index the migration just built now rejects a re-duplicate.
    await expect(
      mig.query(
        `INSERT INTO feedback (user_id, thread_id, message_id, feedback_class)
         VALUES ($1, $2, $3, 'thumbs_up')`,
        [U, T, M2]
      )
    ).rejects.toThrow(/duplicate key|unique/i);
  });
});
