/**
 * SHARED: append-only JSONL record of source-id → target-id mappings. Written after
 * each user's transaction commits; read back by `delete-readonly` to decide which
 * accounts the migration created (and may therefore remove).
 *
 * Part of a PARTIAL PORT — see scripts/migrate-users/README.md.
 */
import { appendFile, readFile } from 'fs/promises';
import { existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';

export interface UserMapping {
  type: 'user';
  mongoId: string;
  postgresId: string;
  email: string;
}

export interface ThreadMapping {
  type: 'thread';
  mongoId: string;
  postgresId: string;
  userId: string;
  messageCount: number;
}

export interface MigrationSummary {
  type: 'summary';
  migratedAt: string;
  users: { total: number; migrated: number; skipped: number; errors: number };
  threads: { total: number; migrated: number; skipped: number; errors: number };
  messages: { total: number; migrated: number; filtered: number };
  newsletter: { subscribed: number; failed: number };
}

export type MappingEntry = UserMapping | ThreadMapping | MigrationSummary;

function ensureDir(filePath: string): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

export async function appendMapping(filePath: string, entry: MappingEntry): Promise<void> {
  ensureDir(filePath);
  // 0600: the file pairs emails with account ids.
  await appendFile(filePath, JSON.stringify(entry) + '\n', { mode: 0o600 });
}

export async function writeSummary(filePath: string, summary: MigrationSummary): Promise<void> {
  await appendMapping(filePath, summary);
}

export async function readMappingFile(filePath: string): Promise<MappingEntry[]> {
  const content = await readFile(filePath, 'utf-8');
  return content
    .trim()
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as MappingEntry);
}
