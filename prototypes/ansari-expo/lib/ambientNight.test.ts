/**
 * The ambient palm-shadow layer must never lighten the page.
 *
 * This layer once inverted and screen-blended at night, which made the
 * frond pattern the brightest thing on a charcoal page — a shadow drawn
 * as light. The rules below are the ones that failure broke, and they
 * are checked against the *composited* result rather than the algebra
 * that produced it, so a retune that looks reasonable but stops
 * subtracting still fails here.
 *
 * The platform matrix matters as much as the arithmetic: the two style
 * props this depends on land on different platforms at different
 * versions, and both are dropped silently when they are unsupported.
 */
import { describe, expect, it } from 'vitest';
import {
  ambientTreatment,
  canBlend,
  canFilter,
  nightGrade,
  pageMultiplier,
  videoSurfaceType,
  DAY_STRENGTH,
  NIGHT_DEPTH,
  NIGHT_SOURCE,
  NIGHT_STRENGTH,
  NIGHT_STRENGTH_UNGRADED,
  type Clip,
  type Platform,
} from './ambientNight';

const CLIPS: Clip[] = ['portrait', 'landscape'];

/** Every platform/version the app can actually run on. */
const TARGETS: { platform: Platform; apiLevel?: number; label: string }[] = [
  { platform: 'web', label: 'web' },
  { platform: 'ios', label: 'iOS' },
  { platform: 'android', apiLevel: 24, label: 'Android 24' },
  { platform: 'android', apiLevel: 28, label: 'Android 28' },
  { platform: 'android', apiLevel: 29, label: 'Android 29' },
  { platform: 'android', apiLevel: 30, label: 'Android 30' },
  { platform: 'android', apiLevel: 31, label: 'Android 31' },
  { platform: 'android', apiLevel: 34, label: 'Android 34' },
];

describe('the night layer never lightens the page', () => {
  for (const target of TARGETS) {
    for (const clip of CLIPS) {
      it(`subtracts or draws nothing on ${target.label} (${clip})`, () => {
        const t = ambientTreatment({ dark: true, clip, ...target });
        if (t.kind === 'omit') return;
        expect(t.kind).toBe('night');
        if (t.kind !== 'night') return; // narrows for TS; expect() above already failed the test
        expect(t.blend, 'only multiply is safe here').toBe('multiply');
        const grade = t.filter ? nightGrade(clip) : undefined;
        // Walk the whole source range, not just the anchors: multiply
        // must return a factor of at most 1 at every value, or some band
        // of the clip is adding light.
        for (let luma = 0; luma <= 1.0001; luma += 0.01) {
          const m = pageMultiplier(luma, t.opacity, grade);
          expect(m <= 1 + 1e-9, `luma ${luma.toFixed(2)} lifted the page (x${m.toFixed(3)})`).toBe(true);
        }
      });
    }
  }
});

describe('a platform that cannot subtract draws nothing', () => {
  // mixBlendMode maps onto android.graphics.BlendMode, added in API 29.
  // Below that the prop is dropped and the near-white clip would paint
  // straight over the page — brighter than anything else on screen.
  it('omits the night layer below Android 29', () => {
    for (const apiLevel of [21, 24, 26, 28]) {
      const t = ambientTreatment({
        dark: true,
        clip: 'portrait',
        platform: 'android',
        apiLevel,
      });
      expect(t, `API ${apiLevel}`).toEqual({ kind: 'omit' });
    }
  });

  it('draws the night layer from Android 29 up', () => {
    for (const apiLevel of [29, 30, 31, 34]) {
      const t = ambientTreatment({
        dark: true,
        clip: 'portrait',
        platform: 'android',
        apiLevel,
      });
      expect(t.kind, `API ${apiLevel}`).toBe('night');
    }
  });

  it('never omits daylight — it needs no blend mode at all', () => {
    for (const target of [
      ...TARGETS,
      { platform: 'android' as const, apiLevel: 21 },
    ]) {
      const t = ambientTreatment({ dark: false, clip: 'portrait', ...target });
      expect(t).toEqual({ kind: 'day', opacity: DAY_STRENGTH });
    }
  });

  it('reports the two capabilities separately', () => {
    // They are not the same gate: Android 29 and 30 can blend but cannot
    // filter, and iOS can blend but implements only brightness/opacity.
    expect(canBlend('android', 29) && !canFilter('android', 29)).toBe(true);
    expect(canBlend('ios') && !canFilter('ios')).toBe(true);
    expect(canBlend('web') && canFilter('web')).toBe(true);
    expect(canBlend('android', 28)).toBe(false);
  });
});

describe('the treatment actually reaches the moving clip', () => {
  // The blend and the filter are worn by the *parent* of the poster and
  // the video. On Android that only reaches the video if the video is
  // drawn into the parent's canvas — expo-video's default SurfaceView
  // owns a separate window surface and is composited past both, so the
  // poster would be graded and then the clip would fade in over it
  // ungraded and near-white. Pure arithmetic cannot catch that; this is
  // the constraint that keeps the wiring honest.
  it('never lets Android decode into a SurfaceView', () => {
    expect(videoSurfaceType('android')).toBe('textureView');
  });

  it('leaves web and iOS to their own defaults', () => {
    expect(videoSurfaceType('web')).toBe(undefined);
    expect(videoSurfaceType('ios')).toBe(undefined);
  });

  it('is constant per platform, so the scheme cannot change it', () => {
    // The prop must not change at runtime and a reader can flip dark
    // mode with the app open, so it cannot be derived from the scheme.
    expect(videoSurfaceType('android')).toBe(videoSurfaceType('android'));
    for (const apiLevel of [28, 29, 31, 34]) {
      const t = ambientTreatment({
        dark: true,
        clip: 'portrait',
        platform: 'android',
        apiLevel,
      });
      // Whether or not the layer draws, the surface answer is the same.
      expect(videoSurfaceType('android'), `API ${apiLevel} (${t.kind})`).toBe('textureView');
    }
  });
});

describe('the grade hits the tones it was measured against', () => {
  for (const clip of CLIPS) {
    it(`leaves the page untouched where the wall is (${clip})`, () => {
      const grade = nightGrade(clip);
      const m = pageMultiplier(NIGHT_SOURCE[clip].wall, NIGHT_STRENGTH, grade);
      expect(Math.abs(m - 1) < 1e-6, `wall multiplied the page by ${m} — it must be multiply's identity`).toBe(true);
    });

    it(`sinks the deepest frond to NIGHT_DEPTH (${clip})`, () => {
      const grade = nightGrade(clip);
      const m = pageMultiplier(NIGHT_SOURCE[clip].frond, NIGHT_STRENGTH, grade);
      expect(Math.abs(m - NIGHT_DEPTH) < 1e-6, `frond landed at ${m}`).toBe(true);
    });

    it(`brightens nothing before the contrast runs (${clip})`, () => {
      // A filter chain clamps to [0,1] between functions. A brightness
      // above 1 would crush the wall to white before the contrast could
      // stretch it, and the anchors above would quietly stop holding.
      expect(nightGrade(clip).brightness <= 1).toBe(true);
    });

    it(`bottoms out at the well, not past it (${clip})`, () => {
      // The darkest half-percent sits below the `frond` anchor, so it
      // lands deeper than NIGHT_DEPTH — that tail is the shadow's core
      // and should be the deepest thing on screen. The band below keeps
      // it near night.well rather than letting it run toward black,
      // and keeps the two clips in the same neighbourhood so the
      // desktop layer reads like the phone one rather than a paler or
      // heavier copy.
      const grade = nightGrade(clip);
      const deepest = pageMultiplier(
        NIGHT_SOURCE[clip].min,
        NIGHT_STRENGTH,
        grade,
      );
      expect(deepest < NIGHT_DEPTH, `the core (x${deepest.toFixed(3)}) must be deeper than the frond mass`).toBe(true);
      expect(deepest > 0.45, `the core ran past the well toward black (x${deepest.toFixed(3)})`).toBe(true);
    });

    it(`keeps detail in the darkest fronds (${clip})`, () => {
      // A filter chain clamps at 0. If the grade drove the clip's
      // darkest pixels to zero, the core of every frond would flatten
      // into one crushed patch — the pattern loses its shape exactly
      // where the eye goes, and the flat region bands against the
      // page's gradient. Nothing in the source may reach the floor.
      const grade = nightGrade(clip);
      const { min } = NIGHT_SOURCE[clip];
      const graded =
        1 - (1 - pageMultiplier(min, NIGHT_STRENGTH, grade)) / NIGHT_STRENGTH;
      expect(graded > 0.02, `darkest pixel clamped to the floor (${graded})`).toBe(true);
    });
  }
});

describe('the ungraded path is quieter, never brighter', () => {
  it('still darkens the wall rather than lifting it', () => {
    const wall = NIGHT_SOURCE.portrait.wall;
    const m = pageMultiplier(wall, NIGHT_STRENGTH_UNGRADED);
    expect(m < 1, 'the wall must not add light').toBe(true);
    expect(m > 0.85, `the wall dimmed too far (x${m.toFixed(3)})`).toBe(true);
  });

  it('keeps the fronds clearly below the wall', () => {
    const { frond, wall } = NIGHT_SOURCE.portrait;
    const atWall = pageMultiplier(wall, NIGHT_STRENGTH_UNGRADED);
    const atFrond = pageMultiplier(frond, NIGHT_STRENGTH_UNGRADED);
    expect(atFrond < atWall - 0.1, 'the pattern would not read').toBe(true);
  });

  it('is shallower than the graded path, as documented', () => {
    const raw = pageMultiplier(
      NIGHT_SOURCE.portrait.frond,
      NIGHT_STRENGTH_UNGRADED,
    );
    expect(raw > NIGHT_DEPTH).toBe(true);
  });
});
