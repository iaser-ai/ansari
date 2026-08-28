import { describe, expect, it } from 'vitest';
import { timeAgo } from '@/lib/time';

describe('timeAgo', () => {
  it('returns "" for a missing or unparseable value (the by-design empty fill)', () => {
    // apps/api omits timestamps when null; the adapter fills '' — this must not
    // render as "NaNd".
    expect(timeAgo('')).toBe('');
    expect(timeAgo('not-a-date')).toBe('');
  });

  it('formats recent timestamps compactly', () => {
    expect(timeAgo(new Date().toISOString())).toBe('now');
    expect(timeAgo(new Date(Date.now() - 5 * 60_000).toISOString())).toBe('5m');
    expect(timeAgo(new Date(Date.now() - 3 * 3_600_000).toISOString())).toBe('3h');
    expect(timeAgo(new Date(Date.now() - 2 * 86_400_000).toISOString())).toBe('2d');
  });
});
