import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ContentBlock } from '../db/schema';
import { extractContentPreview, fillDateRange } from '../lib/db/stats';

// --- Unit tests for pure helpers (no DB mocking needed) ---

describe('extractContentPreview', () => {
  it('extracts text from a text block', () => {
    const content: ContentBlock[] = [{ type: 'text', text: 'Hello world' }];
    expect(extractContentPreview(content)).toBe('Hello world');
  });

  it('truncates text longer than 200 chars with "..."', () => {
    const longText = 'a'.repeat(250);
    const content: ContentBlock[] = [{ type: 'text', text: longText }];
    expect(extractContentPreview(content)).toBe('a'.repeat(200) + '...');
  });

  it('does not add "..." for exactly 200 chars', () => {
    const text = 'b'.repeat(200);
    const content: ContentBlock[] = [{ type: 'text', text }];
    expect(extractContentPreview(content)).toBe(text);
  });

  it('returns "[tool_use]" when first block is tool_use and no text block exists', () => {
    const content: ContentBlock[] = [
      { type: 'tool_use', id: '1', name: 'search_quran', input: {} },
    ];
    expect(extractContentPreview(content)).toBe('[tool_use]');
  });

  it('returns "[tool_result]" when first block is tool_result and no text block exists', () => {
    const content: ContentBlock[] = [
      { type: 'tool_result', tool_use_id: '1', content: 'result data' },
    ];
    expect(extractContentPreview(content)).toBe('[tool_result]');
  });

  it('returns "[document]" when first block is document and no text block exists', () => {
    const content: ContentBlock[] = [
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: '' }, title: 'doc' },
    ];
    expect(extractContentPreview(content)).toBe('[document]');
  });

  it('finds text block even if it is not the first block', () => {
    const content: ContentBlock[] = [
      { type: 'tool_use', id: '1', name: 'search', input: {} },
      { type: 'text', text: 'Found answer' },
    ];
    expect(extractContentPreview(content)).toBe('Found answer');
  });

  it('returns empty string for empty content array', () => {
    expect(extractContentPreview([])).toBe('');
  });

  it('returns empty string for null/undefined content', () => {
    expect(extractContentPreview(null as unknown as ContentBlock[])).toBe('');
    expect(extractContentPreview(undefined as unknown as ContentBlock[])).toBe('');
  });
});

describe('fillDateRange', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('fills missing days with defaults', () => {
    vi.setSystemTime(new Date('2026-03-05T12:00:00Z'));

    const data = [{ date: '2026-03-03', count: 5 }];
    const result = fillDateRange(3, data, { count: 0 });

    expect(result).toEqual([
      { date: '2026-03-03', count: 5 },
      { date: '2026-03-04', count: 0 },
      { date: '2026-03-05', count: 0 },
    ]);
  });

  it('returns correct length for the requested days', () => {
    vi.setSystemTime(new Date('2026-03-10T12:00:00Z'));

    const result = fillDateRange(7, [], { count: 0 });
    expect(result).toHaveLength(7);
    expect(result[0].date).toBe('2026-03-04');
    expect(result[6].date).toBe('2026-03-10');
  });

  it('handles multi-field defaults (threads by source)', () => {
    vi.setSystemTime(new Date('2026-03-02T12:00:00Z'));

    const data = [{ date: '2026-03-01', web: 3, legacy: 1 }];
    const result = fillDateRange(2, data, { web: 0, legacy: 0 });

    expect(result).toEqual([
      { date: '2026-03-01', web: 3, legacy: 1 },
      { date: '2026-03-02', web: 0, legacy: 0 },
    ]);
  });

  it('handles single-day range', () => {
    vi.setSystemTime(new Date('2026-03-02T12:00:00Z'));

    const result = fillDateRange(1, [], { count: 0 });
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ date: '2026-03-02', count: 0 });
  });
});

// --- DB query function tests (mock Drizzle) ---

// Mock the db module
vi.mock('../lib/db', () => {
  const mockDb = {
    select: vi.fn(),
  };
  return {
    db: mockDb,
    schema: {},
    closeDb: vi.fn(),
  };
});

// Mock the schema module
vi.mock('../db/schema', () => ({
  users: { id: 'id', email: 'email', createdAt: 'createdAt', source: 'source' },
  threads: { id: 'id', userId: 'userId', name: 'name', source: 'source', createdAt: 'createdAt' },
  messages: { id: 'id', threadId: 'threadId', role: 'role', content: 'content', agentName: 'agentName', source: 'source', createdAt: 'createdAt' },
  feedback: { id: 'id', feedbackClass: 'feedbackClass', createdAt: 'createdAt' },
}));

describe('getSummaryStats', () => {
  let mockDb: { select: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    vi.clearAllMocks();
    const dbModule = await import('../lib/db');
    mockDb = dbModule.db as unknown as typeof mockDb;
  });

  it('returns all summary counts', async () => {
    const mockFrom = vi.fn();
    const mockWhere = vi.fn();

    mockWhere
      .mockResolvedValueOnce([{ total: 5 }])    // new_users_24h
      .mockResolvedValueOnce([{ total: 20 }])   // new_users_7d
      .mockResolvedValueOnce([{ total: 50 }]);  // new_users_30d

    mockFrom
      .mockResolvedValueOnce([{ total: 100 }])     // total_users (no .where)
      .mockReturnValueOnce({ where: mockWhere })    // new_users_24h
      .mockReturnValueOnce({ where: mockWhere })    // new_users_7d
      .mockReturnValueOnce({ where: mockWhere })    // new_users_30d
      .mockResolvedValueOnce([{ total: 200 }])      // total_threads (no .where)
      .mockResolvedValueOnce([{ total: 1000 }])     // total_messages (no .where)
      .mockResolvedValueOnce([{ total: 30 }]);      // total_feedback (no .where)

    mockDb.select.mockReturnValue({ from: mockFrom });

    const { getSummaryStats } = await import('../lib/db/stats');
    const result = await getSummaryStats();

    expect(result).toEqual({
      total_users: 100,
      new_users_24h: 5,
      new_users_7d: 20,
      new_users_30d: 50,
      total_threads: 200,
      total_messages: 1000,
      total_feedback: 30,
    });
  });
});

describe('getFeedbackSummary', () => {
  let mockDb: { select: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    vi.clearAllMocks();
    const dbModule = await import('../lib/db');
    mockDb = dbModule.db as unknown as typeof mockDb;
  });

  it('returns feedback counts with zero defaults for missing classes', async () => {
    const mockGroupBy = vi.fn().mockResolvedValue([
      { feedbackClass: 'thumbs_up', count: 10 },
      { feedbackClass: 'thumbs_down', count: 3 },
    ]);
    const mockFrom = vi.fn().mockReturnValue({ groupBy: mockGroupBy });
    mockDb.select.mockReturnValue({ from: mockFrom });

    const { getFeedbackSummary } = await import('../lib/db/stats');
    const result = await getFeedbackSummary();

    expect(result).toEqual({
      thumbs_up: 10,
      thumbs_down: 3,
      report: 0,
    });
  });

  it('returns all zeros when no feedback exists', async () => {
    const mockGroupBy = vi.fn().mockResolvedValue([]);
    const mockFrom = vi.fn().mockReturnValue({ groupBy: mockGroupBy });
    mockDb.select.mockReturnValue({ from: mockFrom });

    const { getFeedbackSummary } = await import('../lib/db/stats');
    const result = await getFeedbackSummary();

    expect(result).toEqual({
      thumbs_up: 0,
      thumbs_down: 0,
      report: 0,
    });
  });
});

describe('getRecentMessages', () => {
  let mockDb: { select: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    vi.clearAllMocks();
    const dbModule = await import('../lib/db');
    mockDb = dbModule.db as unknown as typeof mockDb;
  });

  it('transforms DB rows to snake_case with content preview', async () => {
    const createdAt = new Date('2026-03-02T10:30:00Z');
    const mockLimit = vi.fn().mockResolvedValue([
      {
        id: 'msg-1',
        threadId: 'thread-1',
        threadName: 'Zakat Q&A',
        role: 'user',
        content: [{ type: 'text', text: 'What is Zakat?' }],
        agentName: null,
        source: 'web',
        createdAt,
      },
    ]);
    const mockOrderBy = vi.fn().mockReturnValue({ limit: mockLimit });
    const mockLeftJoin = vi.fn().mockReturnValue({ orderBy: mockOrderBy });
    const mockFrom = vi.fn().mockReturnValue({ leftJoin: mockLeftJoin });
    mockDb.select.mockReturnValue({ from: mockFrom });

    const { getRecentMessages } = await import('../lib/db/stats');
    const result = await getRecentMessages(50);

    expect(result).toEqual([
      {
        id: 'msg-1',
        thread_id: 'thread-1',
        thread_name: 'Zakat Q&A',
        role: 'user',
        content_preview: 'What is Zakat?',
        agent_name: null,
        source: 'web',
        created_at: '2026-03-02T10:30:00.000Z',
      },
    ]);
  });

  it('handles null thread name', async () => {
    const createdAt = new Date('2026-03-02T10:30:01Z');
    const mockLimit = vi.fn().mockResolvedValue([
      {
        id: 'msg-2',
        threadId: 'thread-2',
        threadName: null,
        role: 'assistant',
        content: [{ type: 'text', text: 'Zakat is one of the five pillars...' }],
        agentName: 'facilitator',
        source: 'web',
        createdAt,
      },
    ]);
    const mockOrderBy = vi.fn().mockReturnValue({ limit: mockLimit });
    const mockLeftJoin = vi.fn().mockReturnValue({ orderBy: mockOrderBy });
    const mockFrom = vi.fn().mockReturnValue({ leftJoin: mockLeftJoin });
    mockDb.select.mockReturnValue({ from: mockFrom });

    const { getRecentMessages } = await import('../lib/db/stats');
    const result = await getRecentMessages(10);

    expect(result[0].thread_name).toBeNull();
    expect(result[0].agent_name).toBe('facilitator');
  });

  it('extracts content preview from tool_use blocks', async () => {
    const createdAt = new Date('2026-03-02T10:30:02Z');
    const mockLimit = vi.fn().mockResolvedValue([
      {
        id: 'msg-3',
        threadId: 'thread-3',
        threadName: null,
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tu-1', name: 'search_quran', input: {} }],
        agentName: null,
        source: 'web',
        createdAt,
      },
    ]);
    const mockOrderBy = vi.fn().mockReturnValue({ limit: mockLimit });
    const mockLeftJoin = vi.fn().mockReturnValue({ orderBy: mockOrderBy });
    const mockFrom = vi.fn().mockReturnValue({ leftJoin: mockLeftJoin });
    mockDb.select.mockReturnValue({ from: mockFrom });

    const { getRecentMessages } = await import('../lib/db/stats');
    const result = await getRecentMessages(10);

    expect(result[0].content_preview).toBe('[tool_use]');
  });
});

describe('getUsersPerDay', () => {
  let mockDb: { select: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-05T12:00:00Z'));
    vi.clearAllMocks();
    const dbModule = await import('../lib/db');
    mockDb = dbModule.db as unknown as typeof mockDb;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns zero-filled daily counts', async () => {
    const mockOrderBy = vi.fn().mockResolvedValue([
      { date: '2026-03-03', count: 3 },
      { date: '2026-03-05', count: 1 },
    ]);
    const mockGroupBy = vi.fn().mockReturnValue({ orderBy: mockOrderBy });
    const mockWhere = vi.fn().mockReturnValue({ groupBy: mockGroupBy });
    const mockFrom = vi.fn().mockReturnValue({ where: mockWhere });
    mockDb.select.mockReturnValue({ from: mockFrom });

    const { getUsersPerDay } = await import('../lib/db/stats');
    const result = await getUsersPerDay(3);

    expect(result).toEqual([
      { date: '2026-03-03', count: 3 },
      { date: '2026-03-04', count: 0 },
      { date: '2026-03-05', count: 1 },
    ]);
  });

  it('returns all zeros for empty database', async () => {
    const mockOrderBy = vi.fn().mockResolvedValue([]);
    const mockGroupBy = vi.fn().mockReturnValue({ orderBy: mockOrderBy });
    const mockWhere = vi.fn().mockReturnValue({ groupBy: mockGroupBy });
    const mockFrom = vi.fn().mockReturnValue({ where: mockWhere });
    mockDb.select.mockReturnValue({ from: mockFrom });

    const { getUsersPerDay } = await import('../lib/db/stats');
    const result = await getUsersPerDay(3);

    expect(result).toHaveLength(3);
    expect(result.every((r) => r.count === 0)).toBe(true);
  });
});

describe('getThreadsPerDay', () => {
  let mockDb: { select: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-05T12:00:00Z'));
    vi.clearAllMocks();
    const dbModule = await import('../lib/db');
    mockDb = dbModule.db as unknown as typeof mockDb;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('pivots by source and zero-fills', async () => {
    const mockOrderBy = vi.fn().mockResolvedValue([
      { date: '2026-03-03', source: 'web', count: 5 },
      { date: '2026-03-03', source: 'legacy', count: 2 },
      { date: '2026-03-05', source: 'web', count: 1 },
    ]);
    const mockGroupBy = vi.fn().mockReturnValue({ orderBy: mockOrderBy });
    const mockWhere = vi.fn().mockReturnValue({ groupBy: mockGroupBy });
    const mockFrom = vi.fn().mockReturnValue({ where: mockWhere });
    mockDb.select.mockReturnValue({ from: mockFrom });

    const { getThreadsPerDay } = await import('../lib/db/stats');
    const result = await getThreadsPerDay(3);

    expect(result).toEqual([
      { date: '2026-03-03', web: 5, legacy: 2 },
      { date: '2026-03-04', web: 0, legacy: 0 },
      { date: '2026-03-05', web: 1, legacy: 0 },
    ]);
  });
});

describe('getMessagesPerDay', () => {
  let mockDb: { select: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-05T12:00:00Z'));
    vi.clearAllMocks();
    const dbModule = await import('../lib/db');
    mockDb = dbModule.db as unknown as typeof mockDb;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('pivots by role and zero-fills', async () => {
    const mockOrderBy = vi.fn().mockResolvedValue([
      { date: '2026-03-04', role: 'user', count: 10 },
      { date: '2026-03-04', role: 'assistant', count: 8 },
      { date: '2026-03-05', role: 'user', count: 3 },
    ]);
    const mockGroupBy = vi.fn().mockReturnValue({ orderBy: mockOrderBy });
    const mockWhere = vi.fn().mockReturnValue({ groupBy: mockGroupBy });
    const mockFrom = vi.fn().mockReturnValue({ where: mockWhere });
    mockDb.select.mockReturnValue({ from: mockFrom });

    const { getMessagesPerDay } = await import('../lib/db/stats');
    const result = await getMessagesPerDay(3);

    expect(result).toEqual([
      { date: '2026-03-03', user: 0, assistant: 0 },
      { date: '2026-03-04', user: 10, assistant: 8 },
      { date: '2026-03-05', user: 3, assistant: 0 },
    ]);
  });
});
