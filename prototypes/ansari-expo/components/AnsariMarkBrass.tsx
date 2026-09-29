import React, { useId } from 'react';
import { Platform } from 'react-native';
import Svg, {
  ClipPath,
  Defs,
  FeColorMatrix,
  FeGaussianBlur,
  FeTurbulence,
  Filter,
  G,
  LinearGradient,
  Mask,
  Path,
  Rect,
  Stop,
  Use,
} from 'react-native-svg';
import { brass } from '@/constants/colors';
import { useScheme } from '@/hooks/useScheme';
import {
  ANSARI_MARK_ASPECT_RATIO,
  ANSARI_MARK_DECORATIVE_PROPS,
  ANSARI_MARK_PATH,
  ANSARI_MARK_VIEWBOX,
} from '@/constants/ansariMark';

/**
 * The Ansari mark struck as a brass emblem — the same artwork as
 * `AnsariWordmark`, lit from the upper left and raised off the page.
 * The desktop rail wears it small in its corner; the phone hero wears
 * it large, crowning the greeting.
 *
 * The whole effect is stacked copies of ONE silhouette (a `<Defs>`
 * template every layer `<Use>`s), because an emboss only holds together
 * if the shadow, the body and the edge lights share a curve for curve
 * identical outline.
 *
 * Everything below is tuned for the rail's real size — a 32 px tall
 * mark. At that size one unit of the artwork's 142-unit space is under
 * a quarter of a pixel, which is why the offsets look so small: the
 * dark edge sits four tenths of a pixel down-right, the contact shadow
 * half a pixel, and the highlight is a sliver about a third of a pixel
 * wide. Anything larger stops being an emboss and becomes an outline
 * with a drop shadow.
 *
 * The phone's hero wears the same emblem three times that size, and the
 * relief cannot simply come along for the ride: scaled with the mark, a
 * half-pixel contact shadow becomes a pixel and a half of grime under
 * the artwork. Nor can it stay frozen in pixels — a large piece of
 * metal with a hairline shadow reads as a flat sticker. So the relief
 * grows with the square root of the mark, which is roughly how a real
 * emboss behaves: a bigger stamping is struck deeper, but nothing like
 * proportionally.
 */

const { width: VB_W, height: VB_H } = ANSARI_MARK_VIEWBOX;

/**
 * Room around the artwork for the shadow and the edge lights to render
 * into — the mark touches every side of its own viewBox, so without
 * bleed the shadow would be sliced off at the edge. The rendered box
 * grows by this much and a matching negative margin pulls it back, so
 * the mark keeps the exact size and position it has in the brand row.
 */
const BLEED = 8;

/** The size every offset below is quoted at: the rail's mark. */
const BASE_HEIGHT = 32;

/** Contact shadow: hugging the mark, not floating under it. */
const SHADOW_DX = 2.2;
const SHADOW_DY = 2.7;
const SHADOW_BLUR = 1.8;

/** The lower-right dark-brass edge, and the upper-left edge highlight. */
const EDGE_OFFSET = 1.7;
const HIGHLIGHT_WIDTH = 1.6;

/** Grain cell size, as a frequency in the artwork's own units. */
const GRAIN_FREQUENCY = 0.07;

/**
 * Below this the mark is too small for the grain to be anything but
 * noise on the gradient, so the texture pass is dropped.
 */
const MIN_TEXTURED_HEIGHT = 26;

export function AnsariMarkBrass({ height = BASE_HEIGHT }: { height?: number }) {
  const dark = useScheme() === 'dark';
  const metal = dark ? brass.dark : brass.light;

  // Two emblems on one screen must not share definition ids, or the
  // second instance's gradients and masks bleed into the first. React's
  // id contains colons, which are not valid inside a url(#…) reference.
  const uid = useId().replace(/[^a-zA-Z0-9]/g, '');
  const markId = `ansariBrassMark${uid}`;
  const bodyId = `ansariBrassBody${uid}`;
  const shadowId = `ansariBrassShadow${uid}`;
  const highlightId = `ansariBrassHighlight${uid}`;
  const grainId = `ansariBrassGrain${uid}`;
  const clipId = `ansariBrassClip${uid}`;

  const scale = height / VB_H;
  const bleedPx = BLEED * scale;

  // How much of the rail's relief survives at this size, in the
  // artwork's units. Because the whole drawing is already scaled by
  // `height`, dividing the offsets by the square root of the growth
  // leaves the relief growing by that same square root in pixels.
  // Clamped so a very small emblem does not end up with an offset
  // wider than its own strokes.
  const relief = Math.min(Math.sqrt(BASE_HEIGHT / height), 1.25);

  // The grain leans on filter primitives react-native-svg only
  // implements on web; on native they warn and draw nothing, so they
  // are never emitted there and the gradient stack carries the metal on
  // its own.
  const textured = Platform.OS === 'web' && height >= MIN_TEXTURED_HEIGHT;

  return (
    <Svg
      width={height * ANSARI_MARK_ASPECT_RATIO + bleedPx * 2}
      height={height + bleedPx * 2}
      viewBox={`${-BLEED} ${-BLEED} ${VB_W + BLEED * 2} ${VB_H + BLEED * 2}`}
      style={{ margin: -bleedPx }}
      {...ANSARI_MARK_DECORATIVE_PROPS}
    >
      <Defs>
        {/* The one silhouette. Left unfilled so each `Use` colours it. */}
        <Path id={markId} d={ANSARI_MARK_PATH} />

        {/* Upper-left to lower-right, with a single narrow highlight
            zone near the top and a warm muted middle: satin brass, not
            a chrome mirror with a hard specular band. */}
        <LinearGradient id={bodyId} x1="0" y1="0" x2="1" y2="1">
          <Stop offset="0" stopColor={metal.warm} />
          <Stop offset="0.13" stopColor={metal.highlight} />
          <Stop offset="0.27" stopColor={metal.warm} />
          <Stop offset="0.58" stopColor={metal.mid} />
          <Stop offset="0.86" stopColor={metal.deep} />
          <Stop offset="1" stopColor={metal.deep} />
        </LinearGradient>

        <Filter id={shadowId}>
          <FeGaussianBlur stdDeviation={SHADOW_BLUR * relief} />
        </Filter>

        {/* The mark minus a copy of itself nudged down-right: what is
            left is a hairline along the upper-left contours. Drawn this
            way the highlight can only ever appear inside the mark, so
            it reads as light catching a raised edge instead of as a
            pale duplicate peeking out from behind. */}
        <Mask
          id={highlightId}
          maskUnits="userSpaceOnUse"
          x={-BLEED}
          y={-BLEED}
          width={VB_W + BLEED * 2}
          height={VB_H + BLEED * 2}
        >
          <Use href={`#${markId}`} fill="#FFFFFF" />
          <Use
            href={`#${markId}`}
            x={HIGHLIGHT_WIDTH * relief}
            y={HIGHLIGHT_WIDTH * relief}
            fill="#000000"
          />
        </Mask>

        {textured && (
          <>
            {/* Low-frequency mottle, flattened to grey so it varies the
                metal's lightness without tinting it. */}
            <Filter id={grainId}>
              {/* Grain cells follow the relief: frozen in the
                  artwork's units they would blow up into a mottle on
                  the hero's emblem, and frozen in pixels they would
                  vanish into a fine sand. */}
              <FeTurbulence
                type="fractalNoise"
                baseFrequency={GRAIN_FREQUENCY / relief}
                numOctaves={2}
                seed={11}
              />
              <FeColorMatrix
                type="matrix"
                values="0.33 0.33 0.33 0 0 0.33 0.33 0.33 0 0 0.33 0.33 0.33 0 0 0 0 0 0 1"
              />
            </Filter>
            <ClipPath id={clipId}>
              <Path d={ANSARI_MARK_PATH} />
            </ClipPath>
          </>
        )}
      </Defs>

      {/* Back to front. */}
      <G filter={`url(#${shadowId})`} opacity={dark ? 0.38 : 0.28}>
        <Use
          href={`#${markId}`}
          x={SHADOW_DX * relief}
          y={SHADOW_DY * relief}
          fill={metal.shadow}
        />
      </G>

      <Use
        href={`#${markId}`}
        x={EDGE_OFFSET * relief}
        y={EDGE_OFFSET * relief}
        fill={metal.deep}
        opacity={dark ? 0.5 : 0.55}
      />

      <Use href={`#${markId}`} fill={`url(#${bodyId})`} />

      {textured && (
        <G clipPath={`url(#${clipId})`} opacity={0.05}>
          <Rect
            x={-BLEED}
            y={-BLEED}
            width={VB_W + BLEED * 2}
            height={VB_H + BLEED * 2}
            filter={`url(#${grainId})`}
          />
        </G>
      )}

      <G mask={`url(#${highlightId})`}>
        <Use
          href={`#${markId}`}
          fill={metal.glint}
          opacity={dark ? 0.5 : 0.85}
        />
      </G>
    </Svg>
  );
}
