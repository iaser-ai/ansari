/**
 * How the ambient palm-shadow layer is composited, in each scheme and on
 * each platform.
 *
 * This is the decision, not the drawing: no React and no React Native
 * imports, so the platform matrix below can be exercised directly by the
 * test suite. `components/AmbientVideo.tsx` turns the answer into style.
 *
 * ---------------------------------------------------------------------
 * The night grade
 *
 * The clip is a palm shadow cast on a near-white wall. By day that needs
 * no help: laid straight onto the paper it darkens where the fronds are,
 * which is what a shadow does. After dark the same footage has to do the
 * same job, and the one thing it must not do is arrive as light.
 *
 * The layer used to invert and screen at night, on the reasoning that a
 * near-white wall painted over charcoal is a grey film. True — but the
 * cure was worse: inversion made the *fronds* the bright part, so the
 * shadow became the most luminous thing on the page. `multiply` is the
 * blend that solves the film without turning the picture inside out.
 * White is its identity, so the wall leaves the page exactly as it found
 * it, and every value below white pulls the page down. No haze, and the
 * shadow stays a shadow.
 *
 * The difficulty is headroom. The page (`night.page`) and the well
 * beneath it (`night.well`) are barely three L* apart, so a night shadow
 * has roughly a third of the range daylight enjoys. There is no room to
 * be tasteful about it: the deepest frond has to spend nearly all of it.
 * ---------------------------------------------------------------------
 */

/** Which of the two clips is on screen. Landscape is desktop web only. */
export type Clip = 'portrait' | 'landscape';

export type Platform = 'web' | 'ios' | 'android';

/**
 * What the layer should do. `omit` means draw nothing at all: it is the
 * answer when the platform cannot darken (see `canBlend`), and drawing
 * the near-white clip there would be the very defect this module exists
 * to remove.
 */
export type AmbientTreatment =
  | { kind: 'omit' }
  | { kind: 'day'; opacity: number }
  | { kind: 'night'; opacity: number; blend: 'multiply'; filter?: string };

/**
 * Where the two clips actually sit, in 0–1 luma, measured off the graded
 * assets rather than guessed:
 *
 *  - `wall` is the bright plateau (~98th percentile, so the handful of
 *    specular pixels above it simply clip to white and stay a no-op).
 *  - `frond` is where the body of the frond pattern bottoms out (~0.5th
 *    percentile). This is the anchor the grade is solved for.
 *  - `min` is the true darkest pixel in the clip. It sits a little below
 *    `frond` — the last half-percent of the shadow's core — and the
 *    grade is allowed to carry it deeper than NIGHT_DEPTH, which is
 *    where the shadow gets its bottom. What it must not do is drive it
 *    to zero: that would flatten the core into a crushed patch and cost
 *    the fronds their detail exactly where the eye looks.
 *
 * All three are stable to a level or two across the clip and match the
 * posters, which is what keeps the still and the video from stepping as
 * one fades over the other.
 *
 * The portrait and landscape clips were graded differently — landscape
 * carries barely two thirds of portrait's contrast — so they cannot
 * share one grade. Anchoring each to its own numbers is what makes the
 * desktop layer read like the phone one instead of a paler copy.
 *
 * Re-exporting the clips invalidates all of this; `ambientNight.test.ts`
 * pins the numbers so that goes noticed rather than shipping.
 */
export const NIGHT_SOURCE: Record<
  Clip,
  { min: number; frond: number; wall: number }
> = {
  portrait: { min: 0.663, frond: 0.706, wall: 0.894 },
  landscape: { min: 0.773, frond: 0.776, wall: 0.91 },
};

/**
 * What the body of the frond pattern — the `frond` anchor — multiplies
 * the page down to. `night.well` is 0.53–0.57 of `night.page` channel
 * for channel, so 0.58 lands that mass of shadow just above the well,
 * the floor of the room and about as far as the page can travel. It
 * reads as ~2.9 L* of shadow, against the ~4.7 L* daylight gets; less
 * than day, but day has the range.
 *
 * The darkest half-percent (`min`) continues past this to roughly the
 * well itself. That tail is the shadow's core and it should be the
 * deepest thing on screen; the test keeps it from going further and
 * crushing.
 */
export const NIGHT_DEPTH = 0.58;

/**
 * Layer opacity at night, and the knob to turn if the shadow wants to be
 * quieter. It scales the whole grade — the grade solves for it, so the
 * deepest frond stays at NIGHT_DEPTH whatever this is set to. Held below
 * 1 so there is somewhere to go in both directions.
 */
export const NIGHT_STRENGTH = 0.6;

/**
 * Strength for the ungraded night path. Multiply can only ever darken,
 * so full opacity is safe here in a way it would not be for a blend that
 * could lift the page; and without the grade to stretch the clip, the
 * pattern needs every bit of the source's own contrast.
 */
export const NIGHT_STRENGTH_UNGRADED = 1;

/** Daylight, unchanged: the clip laid straight onto the paper as ink. */
export const DAY_STRENGTH = 0.3;

/**
 * Whether `mixBlendMode` is honoured, and so whether this layer can
 * darken at all.
 *
 * Web and iOS always can. Android maps the prop onto `android.graphics.
 * BlendMode`, which arrived in API 29 — below that the style is dropped
 * and the layer would composite source-over, painting an opaque
 * near-white wall over the page. The app's floor is lower than 29, so
 * this is a real cohort and the only safe answer there is to draw
 * nothing: there is no way to make a near-white source subtract without
 * a blend mode or a filter, and those devices have neither.
 */
export function canBlend(platform: Platform, apiLevel?: number): boolean {
  if (platform !== 'android') return true;
  return (apiLevel ?? 0) >= 29;
}

/**
 * Whether `filter` is honoured, and so whether the grade below can run.
 *
 * Web runs the whole chain. Android renders it through `RenderEffect`,
 * which needs API 31. iOS reads the prop but implements only
 * `brightness` and `opacity` — a `contrast()` there is silently dropped,
 * and asking for a filter at all makes it hang an extra layer off the
 * view and write `layer.opacity` from props, which would fight the fade
 * the layer animates. So iOS is not asked, and takes the ungraded path.
 */
export function canFilter(platform: Platform, apiLevel?: number): boolean {
  if (platform === 'web') return true;
  if (platform === 'android') return (apiLevel ?? 0) >= 31;
  return false;
}

/**
 * Which surface the video must be decoded into for any of this to reach
 * the moving clip on Android.
 *
 * Everything above composites the layer through its *parent*: the blend
 * mode and the filter are applied by the wrapper the poster and the
 * video sit inside. That only works if the video is actually drawn into
 * the parent's canvas — and expo-video's Android default, `surfaceView`,
 * is not. A SurfaceView owns a separate window surface punched through
 * the view hierarchy; the parent's blend and RenderEffect never touch
 * it. The poster would be graded correctly and then the clip would fade
 * in over it ungraded and near-white: the exact defect, arriving a beat
 * late and only on Android.
 *
 * `textureView` draws into the hierarchy like any other view, so the
 * treatment applies. It costs more power than a SurfaceView, which is
 * why it is not the default, but this clip is a small, muted, heavily
 * compressed loop that is torn down the moment a conversation opens.
 *
 * It is constant per platform on purpose: the prop must not change at
 * runtime, and the scheme can (a reader can flip dark mode with the app
 * open), so it cannot be chosen from the scheme.
 */
export function videoSurfaceType(
  platform: Platform,
): 'textureView' | undefined {
  return platform === 'android' ? 'textureView' : undefined;
}

export type Grade = { brightness: number; contrast: number; css: string };

/**
 * The levels stretch that precedes the multiply.
 *
 * Multiplying the raw clip works, but the wall is only ~0.9, so it also
 * dims the whole page by a tenth for no reason — and the fronds,
 * spending just a fifth of the source's range, barely register. So the
 * clip's narrow slice of white is first stretched across the full scale:
 * the wall to 1.0 (multiply's identity — the page passes through
 * untouched, which is why no warm lift is needed to rescue it) and the
 * deepest frond down to the floor that lands it at NIGHT_DEPTH once the
 * layer's opacity is applied.
 *
 * CSS `contrast(c)` pivots on 0.5 and `brightness(k)` scales from zero,
 * so the pair composes to `v → c·k·v + (1−c)/2` — an affine map with a
 * slope and an offset, which is exactly a levels adjustment. Solving it
 * for the two anchors gives the numbers here. Everything above the wall
 * clips to white and stays a no-op; everything below the frond clips to
 * the floor, and there is nothing below the frond.
 *
 * `brightness` must stay at or below 1: a filter chain clamps to [0,1]
 * between functions, so a brightening first step would crush the wall
 * before the contrast could stretch it, and the map would silently stop
 * meeting its anchors. The test pins this.
 */
export function nightGrade(clip: Clip): Grade {
  const { frond, wall } = NIGHT_SOURCE[clip];
  const floor = 1 - (1 - NIGHT_DEPTH) / NIGHT_STRENGTH;
  const slope = (1 - floor) / (wall - frond);
  const contrast = 2 * slope * wall - 1;
  const brightness = slope / contrast;
  return {
    brightness,
    contrast,
    css: `brightness(${brightness.toFixed(3)}) contrast(${contrast.toFixed(2)})`,
  };
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/**
 * What the composite does to the page at a given source luma: the factor
 * the page is multiplied by, 1 being untouched. Models the browser —
 * brightness, clamp, contrast, clamp, then the layer's own opacity —
 * so the test can check the real end-to-end behaviour rather than the
 * algebra it was derived from. Pass no grade for the ungraded path.
 */
export function pageMultiplier(
  luma: number,
  opacity: number,
  grade?: Grade,
): number {
  let v = clamp01(luma);
  if (grade) {
    v = clamp01(v * grade.brightness);
    v = clamp01((v - 0.5) * grade.contrast + 0.5);
  }
  return 1 - opacity * (1 - v);
}

/**
 * The whole decision, in one place.
 *
 * Daylight is the same everywhere and always draws. Night draws only
 * where it can subtract, and reaches for the grade only where the grade
 * will run — so every path that renders darkens, and the one that cannot
 * renders nothing.
 */
export function ambientTreatment({
  dark,
  clip,
  platform,
  apiLevel,
}: {
  dark: boolean;
  clip: Clip;
  platform: Platform;
  apiLevel?: number;
}): AmbientTreatment {
  if (!dark) return { kind: 'day', opacity: DAY_STRENGTH };
  if (!canBlend(platform, apiLevel)) return { kind: 'omit' };
  if (!canFilter(platform, apiLevel)) {
    return {
      kind: 'night',
      opacity: NIGHT_STRENGTH_UNGRADED,
      blend: 'multiply',
    };
  }
  return {
    kind: 'night',
    opacity: NIGHT_STRENGTH,
    blend: 'multiply',
    filter: nightGrade(clip).css,
  };
}
