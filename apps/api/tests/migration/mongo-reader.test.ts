import { describe, it, expect, vi, beforeEach } from 'vitest';
import { writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { ObjectId } from 'mongodb';
import {
  parseExtendedJsonId,
  parseExtendedJsonDate,
  deduplicateUsers,
  readUsersFromFile,
} from '../../scripts/migrate-users/source/mongo-reader';
import type { SourceUser } from '../../scripts/migrate-users/types';

describe('Extended JSON parsing', () => {
  describe('parseExtendedJsonId', () => {
    it('parses $oid format', () => {
      expect(parseExtendedJsonId({ $oid: '507f1f77bcf86cd799439011' }))
        .toBe('507f1f77bcf86cd799439011');
    });

    it('passes through plain string', () => {
      expect(parseExtendedJsonId('507f1f77bcf86cd799439011'))
        .toBe('507f1f77bcf86cd799439011');
    });

    it('parses native MongoDB ObjectId', () => {
      const oid = new ObjectId('507f1f77bcf86cd799439011');
      expect(parseExtendedJsonId(oid)).toBe('507f1f77bcf86cd799439011');
    });

    it('parses ObjectId-like objects with toHexString', () => {
      const oidLike = { toHexString: () => 'abcdef1234567890abcdef12' };
      expect(parseExtendedJsonId(oidLike)).toBe('abcdef1234567890abcdef12');
    });

    it('throws on invalid input', () => {
      expect(() => parseExtendedJsonId(123)).toThrow('Cannot parse ID');
      expect(() => parseExtendedJsonId(null)).toThrow('Cannot parse ID');
    });
  });

  describe('parseExtendedJsonDate', () => {
    it('parses $date format', () => {
      const result = parseExtendedJsonDate({ $date: '2024-01-15T10:30:00.000Z' });
      expect(result).toBeInstanceOf(Date);
      expect(result.toISOString()).toBe('2024-01-15T10:30:00.000Z');
    });

    it('parses plain date string', () => {
      const result = parseExtendedJsonDate('2024-01-15T10:30:00.000Z');
      expect(result).toBeInstanceOf(Date);
      expect(result.toISOString()).toBe('2024-01-15T10:30:00.000Z');
    });

    it('passes through Date objects', () => {
      const date = new Date('2024-01-15T10:30:00.000Z');
      expect(parseExtendedJsonDate(date)).toBe(date);
    });

    it('throws on invalid input', () => {
      expect(() => parseExtendedJsonDate(123)).toThrow('Cannot parse date');
      expect(() => parseExtendedJsonDate(null)).toThrow('Cannot parse date');
    });
  });
});

describe('Email deduplication', () => {
  it('keeps most recently created user per email', () => {
    const users: SourceUser[] = [
      {
        mongoId: 'old',
        email: 'user@example.com',
        passwordHash: '$2b$12$old',
        firstName: 'Old',
        lastName: 'User',
        source: 'web',
        createdAt: new Date('2023-01-01'),
        updatedAt: new Date('2023-01-01'),
      },
      {
        mongoId: 'new',
        email: 'user@example.com',
        passwordHash: '$2b$12$new',
        firstName: 'New',
        lastName: 'User',
        source: 'web',
        createdAt: new Date('2024-06-01'),
        updatedAt: new Date('2024-06-01'),
      },
    ];

    const result = deduplicateUsers(users);
    expect(result).toHaveLength(1);
    expect(result[0].mongoId).toBe('new');
  });

  it('preserves distinct emails', () => {
    const users: SourceUser[] = [
      {
        mongoId: 'a',
        email: 'alice@example.com',
        passwordHash: '$2b$12$a',
        firstName: 'Alice',
        lastName: null,
        source: null,
        createdAt: new Date('2024-01-01'),
        updatedAt: new Date('2024-01-01'),
      },
      {
        mongoId: 'b',
        email: 'bob@example.com',
        passwordHash: '$2b$12$b',
        firstName: 'Bob',
        lastName: null,
        source: null,
        createdAt: new Date('2024-01-01'),
        updatedAt: new Date('2024-01-01'),
      },
    ];

    const result = deduplicateUsers(users);
    expect(result).toHaveLength(2);
  });
});

describe('readUsersFromFile', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `migration-test-${Date.now()}`);
    await mkdir(testDir, { recursive: true });
  });

  it('parses Extended JSON format', async () => {
    const data = [
      {
        _id: { $oid: '507f1f77bcf86cd799439011' },
        email: 'user@example.com',
        password_hash: '$2b$12$hashhashhashhashhashhashhashhash',
        first_name: 'John',
        last_name: 'Doe',
        source: 'web',
        created_at: { $date: '2024-01-15T10:30:00.000Z' },
        updated_at: { $date: '2024-06-20T15:45:00.000Z' },
        threads: [],
      },
    ];

    const filePath = join(testDir, 'users.json');
    await writeFile(filePath, JSON.stringify(data));

    const result = await readUsersFromFile(filePath);
    expect(result).toHaveLength(1);
    expect(result[0].mongoId).toBe('507f1f77bcf86cd799439011');
    expect(result[0].email).toBe('user@example.com');
    expect(result[0].passwordHash).toBe('$2b$12$hashhashhashhashhashhashhashhash');
    expect(result[0].firstName).toBe('John');
    expect(result[0].lastName).toBe('Doe');
    expect(result[0].source).toBe('web');
    expect(result[0].createdAt.toISOString()).toBe('2024-01-15T10:30:00.000Z');
    expect(result[0].updatedAt.toISOString()).toBe('2024-06-20T15:45:00.000Z');
  });

  it('parses plain string format', async () => {
    const data = [
      {
        _id: '507f1f77bcf86cd799439011',
        email: 'user@example.com',
        password_hash: '$2b$12$hashhashhashhashhashhashhashhash',
        first_name: 'Jane',
        last_name: null,
        source: 'android',
        created_at: '2024-03-10T08:00:00.000Z',
        updated_at: '2024-03-10T08:00:00.000Z',
      },
    ];

    const filePath = join(testDir, 'users.json');
    await writeFile(filePath, JSON.stringify(data));

    const result = await readUsersFromFile(filePath);
    expect(result).toHaveLength(1);
    expect(result[0].mongoId).toBe('507f1f77bcf86cd799439011');
    expect(result[0].firstName).toBe('Jane');
    expect(result[0].lastName).toBeNull();
  });

  it('normalizes email to lowercase', async () => {
    const data = [
      {
        _id: 'abc123',
        email: 'User@Example.COM',
        password_hash: '$2b$12$hash',
        created_at: '2024-01-01T00:00:00.000Z',
      },
    ];

    const filePath = join(testDir, 'users.json');
    await writeFile(filePath, JSON.stringify(data));

    const result = await readUsersFromFile(filePath);
    expect(result[0].email).toBe('user@example.com');
  });

  it('filters by email', async () => {
    const data = [
      {
        _id: 'a1',
        email: 'alice@example.com',
        password_hash: '$2b$12$hash',
        created_at: '2024-01-01T00:00:00.000Z',
      },
      {
        _id: 'b2',
        email: 'bob@example.com',
        password_hash: '$2b$12$hash',
        created_at: '2024-01-01T00:00:00.000Z',
      },
    ];

    const filePath = join(testDir, 'users.json');
    await writeFile(filePath, JSON.stringify(data));

    const result = await readUsersFromFile(filePath, 'alice@example.com');
    expect(result).toHaveLength(1);
    expect(result[0].email).toBe('alice@example.com');
  });

  it('skips users without email', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const data = [
      {
        _id: 'no-email',
        password_hash: '$2b$12$hash',
        created_at: '2024-01-01T00:00:00.000Z',
      },
      {
        _id: 'has-email',
        email: 'valid@example.com',
        password_hash: '$2b$12$hash',
        created_at: '2024-01-01T00:00:00.000Z',
      },
    ];

    const filePath = join(testDir, 'users.json');
    await writeFile(filePath, JSON.stringify(data));

    const result = await readUsersFromFile(filePath);
    expect(result).toHaveLength(1);
    expect(result[0].email).toBe('valid@example.com');
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('no email'));
    warnSpy.mockRestore();
  });

  it('skips users without password hash', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const data = [
      {
        _id: 'no-hash',
        email: 'nopass@example.com',
        created_at: '2024-01-01T00:00:00.000Z',
      },
      {
        _id: 'has-hash',
        email: 'valid@example.com',
        password_hash: '$2b$12$hash',
        created_at: '2024-01-01T00:00:00.000Z',
      },
    ];

    const filePath = join(testDir, 'users.json');
    await writeFile(filePath, JSON.stringify(data));

    const result = await readUsersFromFile(filePath);
    expect(result).toHaveLength(1);
    expect(result[0].email).toBe('valid@example.com');
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('no password hash'));
    warnSpy.mockRestore();
  });

  it('deduplicates by email keeping most recent', async () => {
    const data = [
      {
        _id: 'old-id',
        email: 'dupe@example.com',
        password_hash: '$2b$12$old',
        created_at: '2023-01-01T00:00:00.000Z',
      },
      {
        _id: 'new-id',
        email: 'dupe@example.com',
        password_hash: '$2b$12$new',
        created_at: '2024-06-01T00:00:00.000Z',
      },
    ];

    const filePath = join(testDir, 'users.json');
    await writeFile(filePath, JSON.stringify(data));

    const result = await readUsersFromFile(filePath);
    expect(result).toHaveLength(1);
    expect(result[0].mongoId).toBe('new-id');
    expect(result[0].passwordHash).toBe('$2b$12$new');
  });

  it('parses embedded threads and messages', async () => {
    const data = [
      {
        _id: { $oid: 'user1' },
        email: 'user@example.com',
        password_hash: '$2b$12$hash',
        created_at: { $date: '2024-01-01T00:00:00.000Z' },
        updated_at: { $date: '2024-01-01T00:00:00.000Z' },
        threads: [
          {
            _id: { $oid: 'thread1' },
            name: 'Test Thread',
            created_at: { $date: '2024-02-01T08:00:00.000Z' },
            updated_at: { $date: '2024-02-01T09:00:00.000Z' },
            messages: [
              {
                id: 'msg1',
                role: 'user',
                content: 'Hello',
                created_at: { $date: '2024-02-01T08:00:00.000Z' },
              },
              {
                id: 'msg2',
                role: 'assistant',
                content: [{ type: 'text', text: 'Response' }],
                created_at: { $date: '2024-02-01T08:01:00.000Z' },
              },
            ],
          },
        ],
      },
    ];

    const filePath = join(testDir, 'users.json');
    await writeFile(filePath, JSON.stringify(data));

    const result = await readUsersFromFile(filePath);
    expect(result).toHaveLength(1);
    expect(result[0].threads).toHaveLength(1);

    const thread = result[0].threads![0];
    expect(thread.mongoId).toBe('thread1');
    expect(thread.name).toBe('Test Thread');
    expect(thread.messages).toHaveLength(2);
    expect(thread.messages[0].role).toBe('user');
    expect(thread.messages[0].content).toBe('Hello');
    expect(thread.messages[1].content).toEqual([{ type: 'text', text: 'Response' }]);
  });

  it('handles user with no threads field', async () => {
    const data = [
      {
        _id: 'user1',
        email: 'user@example.com',
        password_hash: '$2b$12$hash',
        created_at: '2024-01-01T00:00:00.000Z',
      },
    ];

    const filePath = join(testDir, 'users.json');
    await writeFile(filePath, JSON.stringify(data));

    const result = await readUsersFromFile(filePath);
    expect(result).toHaveLength(1);
    expect(result[0].threads).toBeUndefined();
  });
});
