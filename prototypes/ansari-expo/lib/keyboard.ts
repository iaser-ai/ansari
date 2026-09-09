/**
 * Reading the on-screen keyboard out of a browser viewport.
 *
 * A browser never announces its keyboard. What it does is shrink the
 * *visual* viewport — the part of the page the reader can see — while
 * the layout viewport keeps its full height, so the keyboard is only
 * ever the difference between the two. Every other thing that shortens
 * the visual viewport looks identical from here, which is why this is
 * arithmetic with rules rather than a subtraction: see the tests beside
 * this file for the cases each rule exists to reject.
 */

/**
 * The shallowest band that can be a keyboard.
 *
 * A collapsing URL bar, a find-in-page strip and an autofill suggestion
 * bar all shorten the viewport by a few dozen points, and none of them
 * is a keyboard the composer should climb onto. The shortest phone
 * keyboards run to around 200pt, so this sits well clear of the
 * browser's own furniture without missing a real one.
 */
export const KEYBOARD_MIN = 140;

export type ViewportReading = {
  /** The layout viewport's height — `window.innerHeight`. */
  innerHeight: number;
  /** The visual viewport's height. */
  viewportHeight: number;
  /**
   * How far the visual viewport has been scrolled down inside it.
   *
   * Deliberately no part of the arithmetic below, though it is the
   * reading a caller needs in order to place the shell. See the note
   * on the function.
   */
  offsetTop: number;
  /** The visual viewport's zoom factor. */
  scale: number;
};

/**
 * How tall the on-screen keyboard is, in CSS pixels, or 0 when nothing
 * that can be called a keyboard is up.
 *
 * The keyboard's height is the whole of what the visual viewport lost,
 * and a pan is not part of it. iOS does two separate things when a
 * field near the foot of the page is focused: it shortens the visual
 * viewport by the keyboard, and it scrolls that viewport down inside
 * the layout one to lift the field clear. Netting the pan off the
 * shrink looks reasonable — the app is no longer *under* the keyboard
 * once it has been panned — but it makes the answer fall back to zero
 * at precisely the moment the keyboard is fully up, so a reader
 * watching the app collapse for the keyboard sees it spring back open
 * again halfway through.
 *
 * The pan still matters, of course — a browser that has panned the
 * composer clear has answered the keyboard on the app's behalf. It is
 * simply not this function's business: the caller holds the two
 * measures side by side and takes the difference, which it can only do
 * if this one is whole.
 */
export function keyboardOverlap(reading: ViewportReading): number {
  // A pinch also shrinks the visual viewport, and a reader who has
  // zoomed in has not asked the composer to move.
  if (reading.scale > 1.01) return 0;
  const covered = reading.innerHeight - reading.viewportHeight;
  if (!Number.isFinite(covered) || covered < KEYBOARD_MIN) return 0;
  return Math.round(covered);
}
