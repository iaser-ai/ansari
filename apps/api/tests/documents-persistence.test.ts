import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

/**
 * Issue #66 — `messages.documents` at the storage layer (real pglite, real
 * createMessage):
 *  - a citable documents array round-trips verbatim (non-ASCII included);
 *  - a turn with nothing citable stores SQL NULL, never '[]'::jsonb — both the
 *    absent and the empty case, via documentsOrNull;
 *  - the history-replay helper (findMessagesByThread) projects documents OUT,
 *    so document text can never be fed back to the model on turn 2+, while the
 *    thread-view helper (getThreadWithMessages) selects them for thread GET.
 */

const h = vi.hoisted(() => ({ db: null as unknown }));

vi.mock('@/lib/db/index', () => ({
  get db() {
    return h.db;
  },
  closeDb: async () => {},
}));

import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import * as schema from '@/db/schema';
import { messages } from '@/db/schema';
import { documentsOrNull, type DocumentContentBlock } from '@/db/schema/messages';
import { createMessage, findMessagesByThread, getThreadWithMessages } from '@/lib/db/threads';

let client: PGlite;
let db: ReturnType<typeof drizzle<typeof schema>>;

const USER_ID = '11111111-1111-1111-1111-111111111111';
const THREAD_ID = '22222222-2222-2222-2222-222222222222';

const DOCUMENTS: DocumentContentBlock[] = [
  {
    type: 'document',
    source: { type: 'text', media_type: 'text/plain', data: 'إِنَّ اللَّهَ مَعَ الصَّابِرِينَ' },
    title: 'Quran 2:153',
    context: 'Ayah text',
  },
  {
    type: 'document',
    source: { type: 'text', media_type: 'text/plain', data: 'Actions are judged by intentions…' },
    title: 'Sahih al-Bukhari 1',
  },
];

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
    'documents@example.com',
    'x',
  ]);
});


afterAll(async () => {
  await client.close();
});

beforeEach(async () => {
  await client.exec('DELETE FROM threads');
  await client.query(`INSERT INTO threads (id, user_id) VALUES ($1, $2)`, [THREAD_ID, USER_ID]);
});

async function rawDocumentsColumn(): Promise<{ is_null: boolean; value: unknown }[]> {
  const result = await client.query<{ is_null: boolean; value: unknown }>(
    `SELECT documents IS NULL AS is_null, documents AS value FROM messages`
  );
  return result.rows;
}

describe('documentsOrNull', () => {
  it('maps absent and empty to null and passes a populated array through', () => {
    expect(documentsOrNull(undefined)).toBeNull();
    expect(documentsOrNull(null)).toBeNull();
    expect(documentsOrNull([])).toBeNull();
    expect(documentsOrNull(DOCUMENTS)).toBe(DOCUMENTS);
  });
});

describe('messages.documents round-trip (real pglite)', () => {
  it('persists a documents array and reads it back verbatim', async () => {
    await createMessage({
      threadId: THREAD_ID,
      role: 'assistant',
      content: [{ type: 'text', text: 'الجواب…' }],
      documents: documentsOrNull(DOCUMENTS),
    });

    const rows = await db.select().from(messages);
    expect(rows).toHaveLength(1);
    expect(rows[0].documents).toEqual(DOCUMENTS);
    // Kept out of content: the existing message shape is unchanged.
    expect(rows[0].content).toEqual([{ type: 'text', text: 'الجواب…' }]);
  });

  it('stores SQL NULL (not []) when the documents field is omitted', async () => {
    await createMessage({
      threadId: THREAD_ID,
      role: 'assistant',
      content: [{ type: 'text', text: 'no retrieval' }],
    });

    expect(await rawDocumentsColumn()).toEqual([{ is_null: true, value: null }]);
  });

  it('stores SQL NULL (not []) for an empty documents list', async () => {
    await createMessage({
      threadId: THREAD_ID,
      role: 'assistant',
      content: [{ type: 'text', text: 'nothing citable' }],
      documents: documentsOrNull([]),
    });

    expect(await rawDocumentsColumn()).toEqual([{ is_null: true, value: null }]);
  });
});

describe('history-replay projection excludes documents', () => {
  it('findMessagesByThread returns no documents key and no document text', async () => {
    await createMessage({
      threadId: THREAD_ID,
      role: 'assistant',
      content: [{ type: 'text', text: 'answer' }],
      rawPayload: { role: 'model', parts: [{ text: 'answer' }] },
      documents: DOCUMENTS,
    });

    const rows = await findMessagesByThread(THREAD_ID);
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0])).not.toContain('documents');
    const serialized = JSON.stringify(rows);
    for (const doc of DOCUMENTS) {
      expect(serialized).not.toContain(doc.source.data);
    }
    expect(rows[0].rawPayload).toEqual({ role: 'model', parts: [{ text: 'answer' }] });
  });
});

describe('thread-view projection includes documents', () => {
  it('getThreadWithMessages returns documents while findMessagesByThread still does not', async () => {
    await createMessage({ threadId: THREAD_ID, role: 'user', content: [{ type: 'text', text: 'question' }] });
    await createMessage({
      threadId: THREAD_ID,
      role: 'assistant',
      content: [{ type: 'text', text: 'answer' }],
      documents: DOCUMENTS,
    });

    const view = await getThreadWithMessages(THREAD_ID, USER_ID);
    expect(view?.messages.map((m) => m.documents)).toEqual([null, DOCUMENTS]);
    // No other internal column rides along with the view projection.
    expect(Object.keys(view!.messages[1])).not.toContain('toolCalls');
    expect(Object.keys(view!.messages[1])).not.toContain('modelProvider');

    const replay = await findMessagesByThread(THREAD_ID);
    for (const m of replay) {
      expect(Object.keys(m)).not.toContain('documents');
    }
  });
});
