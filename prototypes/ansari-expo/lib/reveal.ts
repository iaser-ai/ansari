/**
 * The pace at which a streaming answer is written onto the page.
 *
 * Text arrives in whatever chunks the backend happens to flush — a word,
 * then half a paragraph, then nothing for a second — and drawn as it
 * arrives, the answer lurches. So what is shown is decoupled from what
 * has arrived: the cleaned text is the target, and a cursor walks towards
 * it at a steady typing speed.
 *
 * Steady, but never behind for long. The speed is the larger of a base
 * rate and whatever it takes to drain the current backlog within a short
 * window, so a burst is caught up on rather than queued: the lag can never
 * grow past roughly (arrival rate × window), however long the answer runs.
 * Once the stream has finished there is nothing left to pace against, and
 * the rest is written out quickly so the persisted answer can take over.
 *
 * Pure and React-free; `hooks/useRevealedText.ts` drives it on a frame
 * clock. The cursor is fractional so that a slow rate over short frames
 * still adds up, and it is only rounded when a slice is cut.
 */

export const REVEAL = {
  /** Characters per second when the backlog is small: an unhurried typist. */
  baseCps: 90,
  /**
   * While streaming, the backlog shrinks with this time constant: the rate is
   * backlog / window, so the lag holds at about (arrival rate × window) and a
   * burst decays exponentially rather than being queued.
   */
  catchUpSeconds: 0.5,
  /**
   * Once the stream has finished, the same with a shorter time constant, and
   * never slower than `settledCps`, so the last few characters do not
   * trickle. A drain is logarithmic in the backlog, not a fixed time: the
   * ~75 characters a fast stream leaves behind take ~0.2 s, and the rare
   * 2000-character backlog (one huge final chunk) ~0.7 s.
   */
  settleSeconds: 0.15,
  settledCps: 360,
} as const;

/**
 * Where the cursor is after `dtMs` more milliseconds of writing towards a
 * target `targetLength` characters long. `settled` is true once no more
 * text is coming.
 */
export function advanceReveal(
  position: number,
  targetLength: number,
  dtMs: number,
  settled: boolean,
): number {
  if (position >= targetLength) return targetLength;
  if (!(dtMs > 0)) return Math.max(0, position);
  const backlog = targetLength - position;
  // Recomputed every tick, so the drain is exponential down to the floor
  // rate and linear from there (see REVEAL for the resulting times).
  const rate = Math.max(
    settled ? REVEAL.settledCps : REVEAL.baseCps,
    backlog / (settled ? REVEAL.settleSeconds : REVEAL.catchUpSeconds),
  );
  return Math.min(targetLength, Math.max(0, position) + (rate * dtMs) / 1000);
}

/**
 * The part of `target` the cursor has reached. Never ends between the two
 * halves of a surrogate pair — half an emoji draws as a replacement glyph.
 * Partial markdown needs no such care: the parser already degrades any
 * construct that has not closed yet (lib/markdown.ts).
 */
export function revealSlice(target: string, position: number): string {
  let end = Math.min(target.length, Math.max(0, Math.floor(position)));
  if (end > 0 && end < target.length) {
    const code = target.charCodeAt(end - 1);
    if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  }
  return target.slice(0, end);
}

/**
 * How much of what is already shown still holds for a new target.
 *
 * The cleaned stream is not append-only: a `[1]` completes and is stripped,
 * a "Citations:" heading is recognised and everything under it cut, a held
 * tail turns out to be prose (lib/citations.ts). Text behind the cursor
 * can change, so the cursor falls back to where the two still agree.
 */
export function commonPrefixLength(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a.charCodeAt(i) === b.charCodeAt(i)) i += 1;
  return i;
}
