/**
 * Shared pglite fixture for the migrate-users suites (issue #131). Hand-written DDL
 * mirroring drizzle/0000–0008 for the tables the port touches or cascades into. Per the
 * #70 / spec-73 lessons this DDL drifts like a schema copy — re-grep it after every
 * develop merge that adds a column.
 *
 * Each test file still does its own `vi.hoisted` + `vi.mock('@/lib/db/index', ...)`
 * (vi.mock is per-file); this module only provides the client + DDL.
 */
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import * as schema from '@/db/schema';

export const MIGRATION_DDL = `
  CREATE TABLE users (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email text UNIQUE NOT NULL,
    password_hash text NOT NULL,
    first_name text,
    last_name text,
    source text DEFAULT 'web',
    registered_via text,
    is_admin boolean NOT NULL DEFAULT false,
    system_key text,
    session_version integer NOT NULL DEFAULT 0,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
  );
  CREATE UNIQUE INDEX idx_users_system_key ON users (system_key);
  CREATE TABLE threads (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name text,
    source text DEFAULT 'web',
    client text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
  );
  CREATE INDEX idx_threads_user ON threads (user_id, updated_at);
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
  CREATE INDEX idx_messages_thread ON messages (thread_id, created_at);
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
  CREATE INDEX idx_tool_call_orphans_thread ON tool_call_orphans (thread_id, created_at);
  CREATE TABLE feedback (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    thread_id uuid NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
    message_id uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    feedback_class text NOT NULL,
    comment text,
    created_at timestamp with time zone DEFAULT now()
  );
  CREATE UNIQUE INDEX idx_feedback_user_message_class ON feedback (user_id, message_id, feedback_class);
`;

export const TRUNCATE_ALL = `DELETE FROM feedback; DELETE FROM tool_call_orphans; DELETE FROM messages; DELETE FROM threads; DELETE FROM users;`;

export async function createMigrationDb() {
  const client = new PGlite();
  await client.exec(MIGRATION_DDL);
  const db = drizzle(client, { schema });
  return { client, db };
}

export type MigrationDb = Awaited<ReturnType<typeof createMigrationDb>>['db'];

export async function count(client: PGlite, table: 'users' | 'threads' | 'messages' | 'feedback'): Promise<number> {
  const r = await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`);
  return r.rows[0].n;
}

// Already allowlisted in .gitleaks.toml (tests/migration/bcrypt-compat.test.ts): a
// bcrypt hash of the literal 'testpassword123', not a real credential.
export const FAKE_BCRYPT_HASH = '$2b$12$qr31iYHUYhv/HngLaSEgpePzhlT7HIfUmh32ZdoZ5eKLtS0Wl8Vgi';
