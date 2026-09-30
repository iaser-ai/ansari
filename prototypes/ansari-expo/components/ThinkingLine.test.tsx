// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';

// Render through react-native-web: reanimated's animated wrappers are
// stood in for with plain ones, and its animation builders with no-ops.
vi.mock('react-native-reanimated', async () => {
  const { Text, View } = await import('react-native');
  const chain = (): unknown =>
    new Proxy({}, { get: () => () => chain() });
  return {
    default: { View, Text },
    FadeIn: chain(),
    ReduceMotion: { System: 'system' },
    Easing: { bezier: () => () => 0 },
    cubicBezier: () => 'ease-out',
    cancelAnimation: () => {},
    useReducedMotion: () => false,
    useSharedValue: (initial: number) => {
      let value = initial;
      return { get: () => value, set: (v: number) => (value = v) };
    },
    useAnimatedStyle: (fn: () => object) => fn(),
    withRepeat: (a: unknown) => a,
    withSequence: (a: unknown) => a,
    withTiming: (v: unknown) => v,
  };
});
vi.mock('@/components/AnsariMarkPulse', () => ({ AnsariMarkPulse: () => null }));

import { ThinkingLine } from '@/components/ThinkingLine';
import type { TraceEntry } from '@/lib/chat-trace';

afterEach(cleanup);

const row = () => screen.getByLabelText(/sources\./);

describe('ThinkingLine — the source row (issue #204)', () => {
  it('names all four sources once, under "Searching", before any search starts', () => {
    render(<ThinkingLine />);
    expect(row().textContent).toBe("SearchingQur'an·Hadith·Tafsir·Fiqh");
    expect(row().getAttribute('aria-label')).toBe(
      "Searching sources. Qur'an not searched, Hadith not searched, Tafsir not searched, Fiqh not searched.",
    );
  });

  it('keeps the same shape however many queries run — no line per query', () => {
    const trace: TraceEntry[] = [
      { tool: 'quran', query: 'a', resultCount: 3, pending: false },
      { tool: 'quran', query: 'b', resultCount: 2, pending: false },
      { tool: 'quran', query: 'c', resultCount: 0, pending: false },
      { tool: 'hadith', pending: true },
    ];
    render(<ThinkingLine trace={trace} />);
    expect(row().textContent).toBe("SearchingQur'an·Hadith·Tafsir·Fiqh");
    expect(row().getAttribute('aria-label')).toBe(
      "Searching sources. Qur'an done, Hadith searching, Tafsir not searched, Fiqh not searched.",
    );
  });

  it('reads "Reading" once every search is in', () => {
    render(
      <ThinkingLine
        trace={[{ tool: 'mawsuah', query: 'riba', resultCount: 4, pending: false }]}
      />,
    );
    expect(row().textContent?.startsWith('Reading')).toBe(true);
    expect(row().getAttribute('aria-label')).toContain('Fiqh done');
  });
});
