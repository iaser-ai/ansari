/**
 * The web has no keyboard event, so the composer's whole knowledge of
 * the keyboard is the arithmetic in `lib/keyboard.ts`. Every case here
 * is a shape a real phone browser reports; getting one wrong means
 * either a composer that stays buried under the keyboard or one that
 * jumps up the page for a URL bar.
 *
 */
import { describe, expect, it } from 'vitest';
import { keepFootInView, keyboardOverlap, KEYBOARD_MIN } from './keyboard';

const AT_REST = {
  innerHeight: 844,
  viewportHeight: 844,
  offsetTop: 0,
  scale: 1,
};

describe('keyboardOverlap', () => {
  it('is nothing with the keyboard away', () => {
    expect(keyboardOverlap(AT_REST)).toBe(0);
  });

  it('is the covered band with the keyboard up', () => {
    // iOS Safari, portrait: the visual viewport loses the keyboard's
    // height and the layout viewport keeps its own.
    expect(keyboardOverlap({ ...AT_REST, viewportHeight: 508 })).toBe(336);
  });

  it('is not reduced by iOS panning the viewport', () => {
    // Focusing a field near the foot of the page makes iOS shift the
    // visual viewport down inside the layout one as well as shortening
    // it. The pan is not part of the keyboard's height, and netting it
    // off would send the reading back to nothing at exactly the moment
    // the keyboard finished arriving.
    expect(keyboardOverlap({ ...AT_REST, viewportHeight: 508, offsetTop: 120 })).toBe(336);
    expect(keyboardOverlap({ ...AT_REST, viewportHeight: 508, offsetTop: 336 })).toBe(336);
  });

  it('ignores the browser collapsing its own chrome', () => {
    // A URL bar sliding away is a shorter viewport too, and the
    // composer must not read it as somewhere to climb.
    expect(keyboardOverlap({ ...AT_REST, viewportHeight: 844 - 60 })).toBe(0);
    expect(keyboardOverlap({ ...AT_REST, viewportHeight: 844 - (KEYBOARD_MIN - 1) })).toBe(0);
    expect(keyboardOverlap({ ...AT_REST, viewportHeight: 844 - KEYBOARD_MIN })).toBe(KEYBOARD_MIN);
  });

  it('ignores a pinch', () => {
    // Zooming in shrinks the visual viewport exactly as a keyboard
    // does. A reader reading closely has not asked for the page to be
    // rearranged under them.
    expect(keyboardOverlap({ ...AT_REST, viewportHeight: 300, scale: 2.5 })).toBe(0);
  });

  it('never reports a negative band', () => {
    // Android reports a visual viewport a point or two taller than the
    // layout one at some chrome heights.
    expect(keyboardOverlap({ ...AT_REST, viewportHeight: 846 })).toBe(0);
  });
});

describe('keepFootInView', () => {
  // A thread 600 tall, scrolled 40 short of its end, shortened to 280
  // by a keyboard.
  const SHORTENED = { previousHeight: 600, height: 280, offset: 1000, atBottom: true };

  it('hands back exactly the height the list lost', () => {
    // Not a snap to the very end: the reader keeps their distance from
    // it, so nothing moves by more than the keyboard did.
    expect(keepFootInView(SHORTENED)).toBe(1320);
  });

  it('leaves a reader in the middle of the thread where they are', () => {
    expect(keepFootInView({ ...SHORTENED, atBottom: false })).toBeNull();
  });

  it('does nothing when the list grew or held its height', () => {
    // A growing list is clamped by the browser; the keyboard leaving
    // needs no help.
    expect(keepFootInView({ ...SHORTENED, height: 600 })).toBeNull();
    expect(keepFootInView({ ...SHORTENED, height: 700 })).toBeNull();
  });

  it('does nothing before the list has ever been measured', () => {
    expect(keepFootInView({ ...SHORTENED, previousHeight: 0 })).toBeNull();
  });
});
