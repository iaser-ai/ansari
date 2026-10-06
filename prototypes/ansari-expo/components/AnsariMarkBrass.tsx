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
import {
  BRASS_BASE_HEIGHT,
  BRASS_BLEED,
  BRASS_EDGE,
  BRASS_GRADIENT,
  BRASS_GRAIN,
  BRASS_HIGHLIGHT,
  BRASS_SHADOW,
  brassRelief,
} from '@/constants/brassEmboss';

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
 * The numbers it is struck with live in `constants/brassEmboss.ts`,
 * shared with the script that bakes this same emblem into the app's
 * icons, along with why they are so small and how they grow with size.
 */

const { width: VB_W, height: VB_H } = ANSARI_MARK_VIEWBOX;

/**
 * The rendered box grows by the bleed on every side and a matching
 * negative margin pulls it back, so the mark keeps the exact size and
 * position it has in the brand row.
 */
const BLEED = BRASS_BLEED;

export function AnsariMarkBrass({
  height = BRASS_BASE_HEIGHT,
}: {
  height?: number;
}) {
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

  const relief = brassRelief(height);
  const tone = dark ? 'dark' : 'light';

  // The grain leans on filter primitives react-native-svg only
  // implements on web; on native they warn and draw nothing, so they
  // are never emitted there and the gradient stack carries the metal on
  // its own.
  const textured = Platform.OS === 'web' && height >= BRASS_GRAIN.minHeight;

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

        <LinearGradient id={bodyId} x1="0" y1="0" x2="1" y2="1">
          {BRASS_GRADIENT.map((stop) => (
            <Stop
              key={stop.offset}
              offset={String(stop.offset)}
              stopColor={metal[stop.tone]}
            />
          ))}
        </LinearGradient>

        <Filter id={shadowId}>
          <FeGaussianBlur stdDeviation={BRASS_SHADOW.blur * relief} />
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
            x={BRASS_HIGHLIGHT.width * relief}
            y={BRASS_HIGHLIGHT.width * relief}
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
                baseFrequency={BRASS_GRAIN.frequency / relief}
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
      <G filter={`url(#${shadowId})`} opacity={BRASS_SHADOW.opacity[tone]}>
        <Use
          href={`#${markId}`}
          x={BRASS_SHADOW.dx * relief}
          y={BRASS_SHADOW.dy * relief}
          fill={metal.shadow}
        />
      </G>

      <Use
        href={`#${markId}`}
        x={BRASS_EDGE.offset * relief}
        y={BRASS_EDGE.offset * relief}
        fill={metal.deep}
        opacity={BRASS_EDGE.opacity[tone]}
      />

      <Use href={`#${markId}`} fill={`url(#${bodyId})`} />

      {textured && (
        <G clipPath={`url(#${clipId})`} opacity={BRASS_GRAIN.opacity}>
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
          opacity={BRASS_HIGHLIGHT.opacity[tone]}
        />
      </G>
    </Svg>
  );
}
