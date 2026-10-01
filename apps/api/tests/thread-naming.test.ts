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
  describe('title length cap (issue #67)', () => {
    async function nameFor(response: string, question = 'What is the ruling on combining prayers while travelling?') {
      mockFindMessagesByThread.mockResolvedValue([{ id: 'msg-1' }]);
      mockCallGemini.mockResolvedValue({ text: response } as GeminiResponse);
      mockUpdateThread.mockResolvedValue({});
      const { maybeGenerateThreadName } = await import('../lib/ai/thread-naming');
      await maybeGenerateThreadName('thread-1', 'user-1', question);
      return mockUpdateThread.mock.calls[0][2].name as string;
    }

    it('caps a single-line response far longer than requested, on a word boundary with an ellipsis', async () => {
      const long = 'Travellers may combine the Dhuhr and Asr prayers according to the majority of scholars while journeying';
      const name = await nameFor(long);

      expect(name.length).toBeLessThanOrEqual(60);
      expect(name.endsWith('…')).toBe(true);
      // Word boundary: everything before the ellipsis is a whole-word prefix of the response.
      const body = name.slice(0, -1);
      expect(long.startsWith(body)).toBe(true);
      expect(long[body.length]).toBe(' ');
    });

    it('falls back to a truncated user question when the response is an answer, not a title', async () => {
      const answer = 'Line one of a long answer.\n\nSecond paragraph of the answer.';
      const name = await nameFor(answer, 'What is the ruling on combining prayers while travelling?');

      expect(name).toBe('What is the ruling on combining prayers while travelling?');
      expect(name).not.toContain('answer');
    });

    it('falls back to a capped user question when the response is over 3x the cap', async () => {
      const answer = 'word '.repeat(60).trim();
      const question = 'Please explain in great detail the history of the compilation of the Quran across the caliphates';
      const name = await nameFor(answer, question);

      expect(name.length).toBeLessThanOrEqual(60);
      expect(name.startsWith('Please explain in great detail')).toBe(true);
      expect(name).not.toContain('word word');
    });

    it('leaves a well-formed short title untouched', async () => {
      expect(await nameFor('Combining Prayers While Travelling')).toBe('Combining Prayers While Travelling');
    });

    it('does not split a surrogate pair when truncating', async () => {
      const name = await nameFor('😀'.repeat(100), 'q');
      expect(Array.from(name).length).toBeLessThanOrEqual(60);
      expect(name).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
    });
  });
});
