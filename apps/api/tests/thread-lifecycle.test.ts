import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getOrCreateThread } from '../lib/db/threads';
import { db } from '../lib/db';
import { threads } from '../db/schema/threads';

// Mock the database
vi.mock('../lib/db', () => ({
  db: {
    transaction: vi.fn(),
  },
}));

describe('getOrCreateThread', () => {
  const mockTx = {
    execute: vi.fn().mockResolvedValue(undefined),
    select: vi.fn(),
    insert: vi.fn(),
    delete: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    (db.transaction as any).mockImplementation(async (fn) => fn(mockTx));
  });

  describe('thread expiry logic', () => {
    it('creates new thread when no existing thread exists', async () => {
      // Mock: no existing thread
      mockTx.select.mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockReturnValue({
              limit: vi.fn().mockReturnValue({
                for: vi.fn().mockResolvedValue([]),
              }),
            }),
          }),
        }),
      });

      // Mock: insert new thread
      const newThread = {
        id: 'thread-1',
        userId: 'user-1',
        source: 'whatsapp',
        updatedAt: new Date(),
      };
      mockTx.insert.mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([newThread]),
        }),
      });

      const result = await getOrCreateThread('user-1', 'whatsapp', 3);

      expect(result).toEqual(newThread);
      expect(mockTx.delete).not.toHaveBeenCalled();
      expect(mockTx.insert).toHaveBeenCalled();
    });

    it('reuses existing thread when not expired', async () => {
      // Mock: existing thread that is NOT expired (updated 1 hour ago, expiry is 3 hours)
      const existingThread = {
        id: 'thread-1',
        userId: 'user-1',
        source: 'whatsapp',
        updatedAt: new Date(Date.now() - 1 * 60 * 60 * 1000), // 1 hour ago
      };

      mockTx.select.mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockReturnValue({
              limit: vi.fn().mockReturnValue({
                for: vi.fn().mockResolvedValue([existingThread]),
              }),
            }),
          }),
        }),
      });

      const result = await getOrCreateThread('user-1', 'whatsapp', 3);

      expect(result).toEqual(existingThread);
      expect(mockTx.delete).not.toHaveBeenCalled();
      expect(mockTx.insert).not.toHaveBeenCalled();
    });

    it('deletes expired thread and creates new one', async () => {
      // Mock: existing thread that IS expired (updated 4 hours ago, expiry is 3 hours)
      const expiredThread = {
        id: 'thread-old',
        userId: 'user-1',
        source: 'whatsapp',
        updatedAt: new Date(Date.now() - 4 * 60 * 60 * 1000), // 4 hours ago
      };

      mockTx.select.mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockReturnValue({
              limit: vi.fn().mockReturnValue({
                for: vi.fn().mockResolvedValue([expiredThread]),
              }),
            }),
          }),
        }),
      });

      // Mock: delete old thread
      mockTx.delete.mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      });

      // Mock: insert new thread
      const newThread = {
        id: 'thread-new',
        userId: 'user-1',
        source: 'whatsapp',
        updatedAt: new Date(),
      };
      mockTx.insert.mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([newThread]),
        }),
      });

      const result = await getOrCreateThread('user-1', 'whatsapp', 3);

      expect(result).toEqual(newThread);
      expect(mockTx.delete).toHaveBeenCalled();
      expect(mockTx.insert).toHaveBeenCalled();
    });

    it('always creates new thread when expiryHours is 0', async () => {
      // Mock: existing thread (even if recently updated)
      const existingThread = {
        id: 'thread-old',
        userId: 'user-1',
        source: 'whatsapp',
        updatedAt: new Date(), // Just now
      };

      mockTx.select.mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockReturnValue({
              limit: vi.fn().mockReturnValue({
                for: vi.fn().mockResolvedValue([existingThread]),
              }),
            }),
          }),
        }),
      });

      // Mock: delete old thread
      mockTx.delete.mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      });

      // Mock: insert new thread
      const newThread = {
        id: 'thread-new',
        userId: 'user-1',
        source: 'whatsapp',
        updatedAt: new Date(),
      };
      mockTx.insert.mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([newThread]),
        }),
      });

      const result = await getOrCreateThread('user-1', 'whatsapp', 0);

      expect(result).toEqual(newThread);
      expect(mockTx.delete).toHaveBeenCalled();
      expect(mockTx.insert).toHaveBeenCalled();
    });

    it('takes the per-user advisory lock before selecting a thread', async () => {

      mockTx.select.mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockReturnValue({
              limit: vi.fn().mockReturnValue({
                for: vi.fn().mockResolvedValue([]),
              }),
            }),
          }),
        }),
      });

      const newThread = {
        id: 'thread-1',
        userId: 'user-1',
        source: 'whatsapp',
        updatedAt: new Date(),
      };

      mockTx.insert.mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([newThread]),
        }),
      });

      await getOrCreateThread('user-1', 'whatsapp', 3);

      expect(mockTx.execute).toHaveBeenCalledTimes(1);
      expect(mockTx.execute.mock.invocationCallOrder[0]).toBeLessThan(mockTx.select.mock.invocationCallOrder[0]!);
    });
  });

  describe('thread selection', () => {
    it('queries threads by userId and source', async () => {
      const mockWhere = vi.fn().mockReturnValue({
        orderBy: vi.fn().mockReturnValue({
          limit: vi.fn().mockReturnValue({
            for: vi.fn().mockResolvedValue([]),
          }),
        }),
      });

      const mockFrom = vi.fn().mockReturnValue({
        where: mockWhere,
      });

      mockTx.select.mockReturnValue({
        from: mockFrom,
      });

      mockTx.insert.mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ id: 'thread-1' }]),
        }),
      });

      await getOrCreateThread('user-1', 'whatsapp', 3);

      expect(mockFrom).toHaveBeenCalled();
      expect(mockWhere).toHaveBeenCalled();
    });

    it('orders threads by updatedAt descending', async () => {
      const mockOrderBy = vi.fn().mockReturnValue({
        limit: vi.fn().mockReturnValue({
          for: vi.fn().mockResolvedValue([]),
        }),
      });

      const mockWhere = vi.fn().mockReturnValue({
        orderBy: mockOrderBy,
      });

      const mockFrom = vi.fn().mockReturnValue({
        where: mockWhere,
      });

      mockTx.select.mockReturnValue({
        from: mockFrom,
      });

      mockTx.insert.mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ id: 'thread-1' }]),
        }),
      });

      await getOrCreateThread('user-1', 'whatsapp', 3);

      expect(mockOrderBy).toHaveBeenCalled();
    });
  });
});