import { describe, expect, it } from 'vitest';
import {
  advanceReveal,
  commonPrefixLength,
  REVEAL,
  revealSlice,
} from '@/lib/reveal';

const TICK = 32;

/** Ticks until the cursor reaches `length`, or Infinity if it never does. */
function ticksToDrain(start: number, length: number, settled: boolean) {
  let position = start;
  for (let ticks = 1; ticks <= 10_000; ticks += 1) {
    position = advanceReveal(position, length, TICK, settled);
    if (position >= length) return ticks;
  }
  return Infinity;
}

describe('advanceReveal', () => {
  it('types at the base rate when the backlog is small', () => {
    const next = advanceReveal(0, 10, 100, false);
    expect(next).toBeCloseTo((REVEAL.baseCps * 100) / 1000);
  });

  it('scales with elapsed time', () => {
    const one = advanceReveal(0, 10, 20, false);
    const two = advanceReveal(0, 10, 40, false);
    expect(two).toBeCloseTo(one * 2);
  });

  it('speeds up to drain a large backlog', () => {
    const backlog = 2000;
    const step = advanceReveal(0, backlog, TICK, false);
    expect(step).toBeCloseTo(
      (backlog / REVEAL.catchUpSeconds) * (TICK / 1000),
    );
    expect(step).toBeGreaterThan((REVEAL.baseCps * TICK) / 1000);
  });

  it('drains any backlog within a bounded time while streaming', () => {
    for (const backlog of [5, 45, 300, 2000]) {
      const ms = ticksToDrain(0, backlog, false) * TICK;
      // Exponential down to the base-rate floor, then linear across it.
      const floor = REVEAL.baseCps * REVEAL.catchUpSeconds;
      const bound =
        1000 *
          (REVEAL.catchUpSeconds * Math.log(Math.max(1, backlog / floor)) +
            REVEAL.catchUpSeconds) +
        2 * TICK;
      expect(ms).toBeLessThanOrEqual(bound);
    }
  });

  it('finishes quickly once the stream has settled', () => {
    for (const backlog of [5, 75, 300]) {
      expect(ticksToDrain(0, backlog, true) * TICK).toBeLessThanOrEqual(400);
    }
    expect(ticksToDrain(0, 75, true)).toBeLessThan(ticksToDrain(0, 75, false));
  });

  it('never passes the target, even over a long gap', () => {
    expect(advanceReveal(0, 50, 60_000, false)).toBe(50);
    expect(advanceReveal(50, 50, TICK, false)).toBe(50);
    expect(advanceReveal(80, 50, TICK, false)).toBe(50);
  });

  it('stands still when no time has passed', () => {
    expect(advanceReveal(3, 50, 0, false)).toBe(3);
    expect(advanceReveal(3, 50, -5, false)).toBe(3);
    expect(advanceReveal(3, 50, NaN, false)).toBe(3);
  });

  it('keeps the lag bounded across a bursty stream and ends promptly', () => {
    // 3000 characters arriving in bursts of up to 400 at irregular gaps —
    // roughly 150 characters a second, the order of a fast model.
    const bursts = [
      [0, 120], [400, 400], [450, 30], [1400, 380], [1500, 20], [2600, 400],
      [2700, 400], [3900, 250], [4000, 300], [5200, 400], [6000, 300],
    ];
    const total = bursts.reduce((sum, [, n]) => sum + n, 0);
    const end = bursts[bursts.length - 1][0];
    let arrived = 0;
    let position = 0;
    let next = 0;
    let maxLag = 0;
    let doneAt = Infinity;
    for (let t = 0; t <= end + 5000; t += TICK) {
      while (next < bursts.length && bursts[next][0] <= t) {
        arrived += bursts[next][1];
        next += 1;
      }
      const settled = next === bursts.length;
      position = advanceReveal(position, arrived, TICK, settled);
      if (!settled) maxLag = Math.max(maxLag, arrived - position);
      if (settled && position >= total && doneAt === Infinity) doneAt = t;
    }
    // Never more than one burst behind: the backlog is caught up on,
    // not queued.
    expect(maxLag).toBeLessThanOrEqual(400 + 400);
    expect(doneAt - end).toBeLessThanOrEqual(600);
  });
});

describe('revealSlice', () => {
  it('cuts at the floor of the cursor', () => {
    expect(revealSlice('Bismillah', 3.9)).toBe('Bis');
    expect(revealSlice('Bismillah', 0)).toBe('');
    expect(revealSlice('Bismillah', 99)).toBe('Bismillah');
    expect(revealSlice('Bismillah', -2)).toBe('');
  });

  it('never ends between the halves of a surrogate pair', () => {
    const text = 'a🌙b';
    // 'a' + high surrogate would be half an emoji.
    expect(revealSlice(text, 2)).toBe('a');
    expect(revealSlice(text, 3)).toBe('a🌙');
    expect(revealSlice(text, 4)).toBe(text);
  });

  it('cuts through Arabic and markdown like any other text', () => {
    expect(revealSlice('**السلام** عليكم', 5)).toBe('**الس');
  });
});

describe('commonPrefixLength', () => {
  it('is the full length when the target only grows', () => {
    expect(commonPrefixLength('Establish', 'Establish prayer')).toBe(9);
  });

  it('falls back to where a stripped marker was', () => {
    // "…prayer [1]" completes and its marker is stripped behind the cursor.
    expect(commonPrefixLength('Establish prayer [1', 'Establish prayer. Be')).toBe(
      16,
    );
  });

  it('falls back when a Citations section is cut', () => {
    const shown = 'Be humble.\n\nCitations';
    const target = 'Be humble.';
    expect(commonPrefixLength(shown, target)).toBe(target.length);
  });

  it('handles empty strings', () => {
    expect(commonPrefixLength('', 'abc')).toBe(0);
    expect(commonPrefixLength('abc', '')).toBe(0);
  });
});
