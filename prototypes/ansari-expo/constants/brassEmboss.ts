/**
 * The numbers the brass emblem is struck with — shared by the live
 * emblem (`AnsariMarkBrass`) and the script that bakes the same emblem
 * into the app icons (`scripts/build-icons.mjs`), so the tile on a home
 * screen and the mark in the rail are one piece of metal.
 *
 * Plain data, no imports: the icon script loads this file under bare
 * Node, where neither React Native nor the `@/` alias exists.
 *
 * Every length is in the artwork's own units (`ANSARI_MARK_VIEWBOX`),
 * tuned for the rail's real size — a 32 px tall mark. At that size one
 * unit of the artwork's 246-unit space is about an eighth of a pixel,
 * which is why the offsets look so small: the dark edge sits four tenths
 * of a pixel down-right, the contact shadow half a pixel, and the
 * highlight is a sliver about a third of a pixel wide. Anything larger
 * stops being an emboss and becomes an outline with a drop shadow.
 */

/**
 * Room around the artwork for the shadow and the edge lights to render
 * into — the mark touches every side of its own viewBox, so without
 * bleed the shadow would be sliced off at the edge.
 */
export const BRASS_BLEED = 14;

/** The size every offset below is quoted at: the rail's mark. */
export const BRASS_BASE_HEIGHT = 32;

/** Contact shadow: hugging the mark, not floating under it. */
export const BRASS_SHADOW = {
  dx: 3.8,
  dy: 4.7,
  blur: 3.1,
  opacity: { light: 0.28, dark: 0.38 },
} as const;

/** The lower-right dark-brass edge. */
export const BRASS_EDGE = {
  offset: 2.9,
  opacity: { light: 0.55, dark: 0.5 },
} as const;

/** The upper-left edge highlight. */
export const BRASS_HIGHLIGHT = {
  width: 2.8,
  opacity: { light: 0.85, dark: 0.5 },
} as const;

/** Grain: cell size as a frequency in the artwork's own units. */
export const BRASS_GRAIN = {
  frequency: 0.04,
  opacity: 0.05,
  /**
   * Below this the mark is too small for the grain to be anything but
   * noise on the gradient, so the texture pass is dropped.
   */
  minHeight: 26,
} as const;

/**
 * Upper-left to lower-right, with a single narrow highlight zone near
 * the top and a warm muted middle: satin brass, not a chrome mirror with
 * a hard specular band. Each stop names a rung of `brass.light`/`.dark`.
 */
export const BRASS_GRADIENT = [
  { offset: 0, tone: 'warm' },
  { offset: 0.13, tone: 'highlight' },
  { offset: 0.27, tone: 'warm' },
  { offset: 0.58, tone: 'mid' },
  { offset: 0.86, tone: 'deep' },
  { offset: 1, tone: 'deep' },
] as const;

/**
 * How much of the rail's relief survives at `height`, as a multiplier on
 * the lengths above.
 *
 * A larger emblem cannot simply carry the relief along: scaled with the
 * mark, a half-pixel contact shadow becomes a pixel and a half of grime
 * under the artwork. Nor can it stay frozen in pixels — a large piece of
 * metal with a hairline shadow reads as a flat sticker. So the relief
 * grows with the square root of the mark, which is roughly how a real
 * emboss behaves: a bigger stamping is struck deeper, but nothing like
 * proportionally. Because the drawing is already scaled by `height`,
 * dividing the unit offsets by the square root of the growth leaves the
 * relief growing by that same square root in pixels. Clamped so a very
 * small emblem does not end up with an offset wider than its own strokes.
 */
export function brassRelief(height: number) {
  return Math.min(Math.sqrt(BRASS_BASE_HEIGHT / height), 1.25);
}
