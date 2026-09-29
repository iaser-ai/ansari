// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';

let reducedMotion = false;
vi.mock('react-native-reanimated', () => ({
  useReducedMotion: () => reducedMotion,
}));

import { useRevealedText } from '@/hooks/useRevealedText';

// A hand-driven frame clock: each `frames(n)` fires the pending callbacks
// n times, 16ms apart.
let now = 0;
let queue: Array<{ id: number; cb: FrameRequestCallback }> = [];
let nextId = 1;

beforeEach(() => {
  reducedMotion = false;
  now = 1000;
  queue = [];
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    const id = nextId++;
    queue.push({ id, cb });
    return id;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    queue = queue.filter((f) => f.id !== id);
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function frames(n: number) {
  for (let i = 0; i < n; i += 1) {
    now += 16;
    const due = queue;
    queue = [];
    act(() => {
      for (const f of due) f.cb(now);
    });
  }
}

// Every render's (target, shown) pair — including the ones an effect
// replaces before an assertion could look at `result.current`.
let renders: Array<[string, string]> = [];

function setup(target: string, settled = false) {
  renders = [];
  return renderHook(
    ({ target, settled }) => {
      const shown = useRevealedText(target, settled);
      renders.push([target, shown]);
      return shown;
    },
    { initialProps: { target, settled } },
  );
}

const ANSWER =
  'Khushu is presence of heart in prayer: knowing what you recite, and before whom you stand.';

describe('useRevealedText', () => {
  it('writes a burst out over several frames, not at once', () => {
    const { result } = setup(ANSWER);
    expect(result.current).toBe('');
    frames(3);
    const early = result.current;
    expect(early.length).toBeGreaterThan(0);
    expect(early.length).toBeLessThan(ANSWER.length);
    expect(ANSWER.startsWith(early)).toBe(true);
    frames(120);
    expect(result.current).toBe(ANSWER);
    // Caught up: the clock stops rather than spinning.
    expect(queue).toHaveLength(0);
  });

  it('hurries the remainder once settled', () => {
    const slow = setup(ANSWER, false);
    const fast = setup(ANSWER, true);
    frames(10);
    expect(fast.result.current.length).toBeGreaterThan(
      slow.result.current.length,
    );
  });

  it('keeps going when more text arrives mid-reveal', () => {
    const { result, rerender } = setup(ANSWER.slice(0, 30));
    frames(4);
    const before = result.current.length;
    rerender({ target: ANSWER, settled: false });
    frames(4);
    expect(result.current.length).toBeGreaterThan(before);
    expect(ANSWER.startsWith(result.current)).toBe(true);
  });

  it('pulls back at once when text behind the cursor is revised', () => {
    const { result, rerender } = setup('Establish prayer [1');
    frames(60);
    expect(result.current).toBe('Establish prayer [1');
    // The marker completes and is stripped: the shown text must never
    // carry characters the target no longer has, not even for a render.
    rerender({ target: 'Establish prayer. Be', settled: false });
    expect(result.current).toBe('Establish prayer');
    for (const [target, shown] of renders) {
      expect(target.startsWith(shown)).toBe(true);
    }
    frames(60);
    expect(result.current).toBe('Establish prayer. Be');
  });

  it('resets in the same render when the target is cleared', () => {
    const { result, rerender } = setup(ANSWER);
    frames(20);
    rerender({ target: '', settled: true });
    expect(result.current).toBe('');
    expect(renders.at(-1)).toEqual(['', '']);
    // …and a new turn starts from nothing.
    rerender({ target: 'Next answer', settled: false });
    expect(result.current).toBe('');
    frames(60);
    expect(result.current).toBe('Next answer');
  });

  it('returns the target unpaced with reduced motion on', () => {
    reducedMotion = true;
    const { result, rerender } = setup(ANSWER);
    expect(result.current).toBe(ANSWER);
    rerender({ target: `${ANSWER} More.`, settled: false });
    expect(result.current).toBe(`${ANSWER} More.`);
  });
});
