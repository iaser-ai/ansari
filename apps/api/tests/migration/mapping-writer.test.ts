import { describe, it, expect, beforeEach } from 'vitest';
import { readFile, mkdir, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  appendMapping,
  writeSummary,
  readMappingFile,
  type UserMapping,
  type ThreadMapping,
  type MigrationSummary,
} from '../../scripts/migrate-users/mapping-writer';

let testCounter = 0;

describe('Mapping writer', () => {
  let testDir: string;
  let filePath: string;

  beforeEach(async () => {
    testCounter++;
    testDir = join(tmpdir(), `mapping-test-${Date.now()}-${testCounter}`);
    await mkdir(testDir, { recursive: true });
    filePath = join(testDir, 'mapping.jsonl');
  });

  it('creates file and appends user mapping entry', async () => {
    const entry: UserMapping = {
      type: 'user',
      mongoId: 'mongo123',
      postgresId: 'pg-uuid-456',
      email: 'test@example.com',
    };

    await appendMapping(filePath, entry);

    const content = await readFile(filePath, 'utf-8');
    const parsed = JSON.parse(content.trim());
    expect(parsed.type).toBe('user');
    expect(parsed.mongoId).toBe('mongo123');
    expect(parsed.postgresId).toBe('pg-uuid-456');
    expect(parsed.email).toBe('test@example.com');
  });

  it('appends multiple entries as separate lines', async () => {
    const user: UserMapping = {
      type: 'user',
      mongoId: 'u1',
      postgresId: 'pg-u1',
      email: 'user1@example.com',
    };
    const thread: ThreadMapping = {
      type: 'thread',
      mongoId: 't1',
      postgresId: 'pg-t1',
      userId: 'pg-u1',
      messageCount: 5,
    };

    await appendMapping(filePath, user);
    await appendMapping(filePath, thread);

    const content = await readFile(filePath, 'utf-8');
    const lines = content.trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).type).toBe('user');
    expect(JSON.parse(lines[1]).type).toBe('thread');
  });

  it('writes summary line', async () => {
    const summary: MigrationSummary = {
      type: 'summary',
      migratedAt: '2026-02-24T12:00:00.000Z',
      users: { total: 10, migrated: 8, skipped: 1, errors: 1 },
      threads: { total: 50, migrated: 48, skipped: 2, errors: 0 },
      messages: { total: 200, migrated: 180, filtered: 20 },
      newsletter: { subscribed: 7, failed: 1 },
    };

    await writeSummary(filePath, summary);

    const content = await readFile(filePath, 'utf-8');
    const parsed = JSON.parse(content.trim());
    expect(parsed.type).toBe('summary');
    expect(parsed.users.migrated).toBe(8);
    expect(parsed.newsletter.subscribed).toBe(7);
  });

  it('readMappingFile parses all entries', async () => {
    const user: UserMapping = {
      type: 'user',
      mongoId: 'u1',
      postgresId: 'pg-u1',
      email: 'user1@example.com',
    };
    const summary: MigrationSummary = {
      type: 'summary',
      migratedAt: '2026-02-24T12:00:00.000Z',
      users: { total: 1, migrated: 1, skipped: 0, errors: 0 },
      threads: { total: 0, migrated: 0, skipped: 0, errors: 0 },
      messages: { total: 0, migrated: 0, filtered: 0 },
      newsletter: { subscribed: 1, failed: 0 },
    };

    await appendMapping(filePath, user);
    await appendMapping(filePath, summary);

    const entries = await readMappingFile(filePath);
    expect(entries).toHaveLength(2);
    expect(entries[0].type).toBe('user');
    expect(entries[1].type).toBe('summary');
  });

  it('creates parent directories if they do not exist', async () => {
    const deepPath = join(testDir, 'deep', 'nested', 'mapping.jsonl');
    const entry: UserMapping = {
      type: 'user',
      mongoId: 'u1',
      postgresId: 'pg-u1',
      email: 'test@example.com',
    };

    await appendMapping(deepPath, entry);

    const content = await readFile(deepPath, 'utf-8');
    expect(JSON.parse(content.trim()).type).toBe('user');
  });
});
