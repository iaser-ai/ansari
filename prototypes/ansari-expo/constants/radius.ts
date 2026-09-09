import { Platform } from 'react-native';

/**
 * Ansari's corner scale.
 *
 * There used to be one theme radius (14) and about forty literals
 * scattered through the components — 33 on the composer, 22 and 18 in
 * an answer, 24 and 36 on a sheet, 16 and 17 on a toast, 6/8/10 in the
 * rail. Nothing shared a scale, so nothing looked related.
 *
 * The steps below are sized the way iOS sizes corners: a tight radius
 * for something the size of a word, a control radius, a card radius, a
 * sheet radius, and an explicit pill. Pick a step; do not write a
 * number beside one.
 *
 * The other half of why iOS shapes read softer at the same radius is
 * that its corners are *continuous* — a squircle, where the curvature
 * eases into the straight edge instead of meeting it at a hard tangent.
 * `CONTINUOUS` (and the `rounded` helpers that carry it) is how a
 * surface opts into that. It is an iOS-only capability: Android and the
 * web draw the same radii as circular arcs, so nothing changes size or
 * proportion between platforms — only the quality of the curve.
 */
export const RADIUS = {
  /**
   * Smaller than a word: the cap on a skeleton's x-height mark, where
   * anything rounder stops reading as a line of type.
   */
  xxs: 4,
  /**
   * A word-sized corner: the hover control on a rail row, a skeleton
   * mark. Small enough that a larger step would read as a lozenge.
   */
  xs: 6,
  /**
   * The small control: rail rows and icon buttons, a code block inside
   * an answer, the buttons on the error screen.
   */
  sm: 10,
  /** The default control: a filled button, a row on a sheet, a notice. */
  md: 14,
  /** A card: the reader's own question, a suggestion chip, a toast. */
  lg: 18,
  /**
   * A sheet, and anything that wants to read as one — the folio, the
   * history sheet, the source pills at the foot of an answer (where 44
   * of height clamps it back to a stadium).
   */
  xl: 24,
  /** A sheet pulled clear of the bottom edge, reading as a free card. */
  xxl: 36,
  /**
   * A stadium. Larger than any control's half-height, so the platform
   * clamps it to exactly that and the shape follows the box.
   */
  pill: 999,
} as const;

export type RadiusStep = keyof typeof RADIUS;

/**
 * The composer's pill: 42 (the send disc) + 12 above and below.
 *
 * The one exact radius the scale keeps, and it lives here rather than
 * beside the component so it is still a token and not a literal. It is
 * deliberately not `pill`: the field autogrows to a 110pt cap, and a
 * stadium would follow it up and turn a tall composer into a lozenge.
 * 33 keeps the resting bar a perfect pill and a grown one a rounded
 * rectangle.
 */
export const COMPOSER_RADIUS = 33;

/**
 * Continuous curvature, where the platform can draw it.
 *
 * Spread this beside any `borderRadius` that is computed rather than
 * taken from `RADIUS` — a circle sized by half its height, the
 * composer's fixed pill — so every rounded surface in the app opts in
 * the same way.
 */
export const CONTINUOUS: { borderCurve?: 'continuous' } =
  Platform.OS === 'ios' ? { borderCurve: 'continuous' } : {};

/** A rounded box: one step off the scale (or an exact radius), drawn continuous. */
export function rounded(radius: number) {
  return { borderRadius: radius, ...CONTINUOUS };
}

/** The same, for a surface that only rounds its top edge — a sheet. */
export function roundedTop(radius: number) {
  return {
    borderTopLeftRadius: radius,
    borderTopRightRadius: radius,
    ...CONTINUOUS,
  };
}
