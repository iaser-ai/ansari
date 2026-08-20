/**
 * Thread Auto-Naming Tests (Spec 3, Phase 1)
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { GeminiResponse } from '../lib/ai/gemini-client';

// Mock callGemini
const mockCallGemini = vi.fn();
vi.mock('../lib/ai/gemini-client', () => ({
  callGemini: (...args: unknown[]) => mockCallGemini(...args),
}));

// Mock thread DB operations
const mockFindMessagesByThread = vi.fn();
const mockUpdateThread = vi.fn();
vi.mock('../lib/db/threads', () => ({
  findMessagesByThread: (...args: unknown[]) => mockFindMessagesByThread(...args),
  updateThread: (...args: unknown[]) => mockUpdateThread(...args),
}));

// Set environment variables before importing modules that use config
beforeEach(() => {
  vi.clearAllMocks();
  process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
  process.env.JWT_SECRET = 'test-secret-key-for-testing-purposes-only-32chars';
  process.env.GEMINI_API_KEY = 'test-gemini-key';
  process.env.KALEMAT_API_KEY = 'test-kalemat-key';
  process.env.USUL_API_TOKEN = 'test-usul-token';
});

describe('maybeGenerateThreadName (Spec 3)', () => {
  it('generates a name when thread has exactly 1 message (first message)', async () => {
    mockFindMessagesByThread.mockResolvedValue([{ id: 'msg-1' }]);
    mockCallGemini.mockResolvedValue({ text: 'Islamic Prayer Times Question' } as GeminiResponse);
    mockUpdateThread.mockResolvedValue({});

    const { maybeGenerateThreadName } = await import('../lib/ai/thread-naming');
    await maybeGenerateThreadName('thread-1', 'user-1', 'What are the prayer times in NYC?');

    expect(mockCallGemini).toHaveBeenCalledWith(
      expect.stringContaining('What are the prayer times in NYC?'),
    );
    expect(mockUpdateThread).toHaveBeenCalledWith('thread-1', 'user-1', {
      name: 'Islamic Prayer Times Question',
    });
  });

  it('skips naming when thread has more than 1 message', async () => {
    mockFindMessagesByThread.mockResolvedValue([{ id: 'msg-1' }, { id: 'msg-2' }]);

    const { maybeGenerateThreadName } = await import('../lib/ai/thread-naming');
    await maybeGenerateThreadName('thread-1', 'user-1', 'Follow-up question');

    expect(mockCallGemini).not.toHaveBeenCalled();
  });

  it('swallows errors from callGemini without rejecting', async () => {
    mockFindMessagesByThread.mockResolvedValue([{ id: 'msg-1' }]);
    mockCallGemini.mockRejectedValue(new Error('API rate limit'));

    const { maybeGenerateThreadName } = await import('../lib/ai/thread-naming');

    // Should not throw
    await expect(
      maybeGenerateThreadName('thread-1', 'user-1', 'test message'),
    ).resolves.toBeUndefined();

    expect(mockUpdateThread).not.toHaveBeenCalled();
  });

  it('strips surrounding quotes from generated title', async () => {
    mockFindMessagesByThread.mockResolvedValue([{ id: 'msg-1' }]);
    mockCallGemini.mockResolvedValue({ text: '"Prayer Times in New York"' } as GeminiResponse);
    mockUpdateThread.mockResolvedValue({});

    const { maybeGenerateThreadName } = await import('../lib/ai/thread-naming');
    await maybeGenerateThreadName('thread-1', 'user-1', 'test');

    expect(mockUpdateThread).toHaveBeenCalledWith('thread-1', 'user-1', {
      name: 'Prayer Times in New York',
    });
  });

  it('does not update thread if cleaned title is empty', async () => {
    mockFindMessagesByThread.mockResolvedValue([{ id: 'msg-1' }]);
    mockCallGemini.mockResolvedValue({ text: '""' } as GeminiResponse);
    mockUpdateThread.mockResolvedValue({});

    const { maybeGenerateThreadName } = await import('../lib/ai/thread-naming');
    await maybeGenerateThreadName('thread-1', 'user-1', 'test');

    expect(mockUpdateThread).not.toHaveBeenCalled();
  });
});
