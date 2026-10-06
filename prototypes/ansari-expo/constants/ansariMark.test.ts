import { describe, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({ Platform: { OS: 'web' } }));

const { ANSARI_MARK_PATH, ANSARI_MARK_SHAPES, ANSARI_MARK_VIEWBOX } =
  await import('./ansariMark');

/** Every absolute (x, y) pair a path visits, plus the bare V/H targets. */
function points(d: string) {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const [, command, args] of d.matchAll(/([MLCVHZ])([^MLCVHZ]*)/g)) {
    const numbers = args
      .trim()
      .split(/[\s,]+/)
      .filter(Boolean)
      .map(Number);
    if (command === 'V') ys.push(...numbers);
    else if (command === 'H') xs.push(...numbers);
    else numbers.forEach((n, i) => (i % 2 === 0 ? xs : ys).push(n));
  }
  return { xs, ys };
}

describe('the Ansari mark', () => {
  it('names its three pieces top to bottom', () => {
    expect(ANSARI_MARK_SHAPES.map((shape) => shape.name)).toEqual([
      'diamond',
      'band',
      'wave',
    ]);
  });

  // The pulse lights the pieces in array order and means "down the mark":
  // a shape listed out of visual order would run the wave backwards.
  it('lists the pieces in the order they sit down the artwork', () => {
    const tops = ANSARI_MARK_SHAPES.map((shape) =>
      Math.min(...points(shape.d).ys),
    );
    expect(tops).toEqual([...tops].sort((a, b) => a - b));
    expect(new Set(tops).size).toBe(tops.length);
  });

  it('keeps every piece inside its viewBox', () => {
    for (const shape of ANSARI_MARK_SHAPES) {
      const { xs, ys } = points(shape.d);
      expect(xs.length).toBeGreaterThan(0);
      expect(Math.min(...xs)).toBeGreaterThanOrEqual(0);
      expect(Math.max(...xs)).toBeLessThanOrEqual(ANSARI_MARK_VIEWBOX.width);
      expect(Math.min(...ys)).toBeGreaterThanOrEqual(0);
      expect(Math.max(...ys)).toBeLessThanOrEqual(ANSARI_MARK_VIEWBOX.height);
    }
  });

  it('draws the whole silhouette as exactly its three pieces', () => {
    expect(ANSARI_MARK_PATH).toBe(
      ANSARI_MARK_SHAPES.map((shape) => shape.d).join(' '),
    );
  });
});
