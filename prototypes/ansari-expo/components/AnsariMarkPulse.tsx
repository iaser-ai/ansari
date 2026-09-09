import React, { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, {
  cancelAnimation,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';
import Svg, { Path } from 'react-native-svg';
import { brass } from '@/constants/colors';
import { useScheme } from '@/hooks/useScheme';
import { DURATION, EASE_IN_OUT } from '@/constants/motion';
import {
  ANSARI_MARK_ASPECT_RATIO,
  ANSARI_MARK_DECORATIVE_PROPS,
  ANSARI_MARK_SHAPES,
  ANSARI_MARK_VIEWBOX,
} from '@/constants/ansariMark';

/**
 * The mark, waiting.
 *
 * Wherever the app has to say "this is coming", it says it in its own
 * voice rather than with the platform's spinner: the three pieces of
 * the symbol take the light one after another, top to bottom, and the
 * wave runs down the mark again. Nothing moves — the mark is struck
 * where it stands, and only the light on it changes — so it reads as a
 * held object catching the light rather than as a widget spinning.
 *
 * The whole mark is one ink: the same brass it is struck from
 * everywhere else, day and night. Nothing about the pulse changes
 * colour — a piece is simply nearer to or further from the light, and
 * the dim end still sits well above nothing, so at every moment of the
 * loop all three pieces are drawn and the silhouette reads as the logo.
 *
 * Every piece is a separate layer over one shared coordinate space
 * rather than an animated fill inside a single drawing: an animated SVG
 * attribute is the one thing in this stack that cannot be relied on to
 * behave the same way on web as on the phones, while an opacity on a
 * view is the same animation everywhere and runs off the JS thread.
 */

/** The lag from one piece's pulse to the next. */
const STAGGER = DURATION.state;
/** A piece taking the light, and losing it — an exit runs quicker. */
const RISE = DURATION.enter;
const FALL = DURATION.exit;
/**
 * One turn of the wave. Long enough that the last piece has gone dim
 * (STAGGER * 2 + RISE + FALL = 940ms) before the star lights again, so
 * the loop breathes instead of chattering — and the rest is what makes
 * the repeat seamless, since every piece both starts and ends the turn
 * at DIM.
 */
const PERIOD = DURATION.enter * 4;
const REST = PERIOD - RISE - FALL;

/** The two ends of the pulse: unlit metal, and metal in full light. */
const DIM = 0.35;
const LIT = 1;

/** Reduced motion: the wave held at its middle, and left there. */
const STILL_LIGHT = (DIM + LIT) / 2;

/**
 * One piece's share of the wave. Each is on its own clock, offset by
 * `delay` — they are started in the same frame off one effect each, and
 * a repeat that returns to exactly where it began cannot drift out of
 * step with the others however long it runs.
 */
function useLitPiece(delay: number, still: boolean) {
  const lit = useSharedValue(still ? STILL_LIGHT : DIM);

  useEffect(() => {
    if (still) {
      lit.set(STILL_LIGHT);
      return;
    }
    lit.set(DIM);
    lit.set(
      withDelay(
        delay,
        withRepeat(
          withSequence(
            withTiming(LIT, { duration: RISE, easing: EASE_IN_OUT }),
            withTiming(DIM, { duration: FALL, easing: EASE_IN_OUT }),
            withTiming(DIM, { duration: REST }),
          ),
          -1,
          false,
        ),
      ),
    );
    return () => cancelAnimation(lit);
  }, [lit, delay, still]);

  return useAnimatedStyle(() => ({ opacity: lit.get() }));
}

export function AnsariMarkPulse({ height = 16 }: { height?: number }) {
  const dark = useScheme() === 'dark';
  const still = useReducedMotion();

  // Three pieces, three clocks, named rather than mapped: the artwork
  // hands its shapes over in a different order than the eye reads them,
  // and the whole point of the effect is the order.
  const star = useLitPiece(0, still);
  const band = useLitPiece(STAGGER, still);
  const arcs = useLitPiece(STAGGER * 2, still);
  const wave = [star, band, arcs];

  const width = height * ANSARI_MARK_ASPECT_RATIO;
  const viewBox = `0 0 ${ANSARI_MARK_VIEWBOX.width} ${ANSARI_MARK_VIEWBOX.height}`;
  // The one ink the mark is drawn in, taken off the same metal the
  // emblem is struck from: its body midtone by day, and the paler rung
  // after dark, so the mark carries the same weight against either page.
  const ink = dark ? brass.dark.highlight : brass.light.mid;

  return (
    <View
      style={{ width, height }}
      aria-hidden
      {...ANSARI_MARK_DECORATIVE_PROPS}
    >
      {ANSARI_MARK_SHAPES.map((shape, index) => (
        <Animated.View
          key={shape.name}
          style={[StyleSheet.absoluteFill, wave[index]]}
        >
          <Svg width={width} height={height} viewBox={viewBox}>
            <Path d={shape.d} fill={ink} />
          </Svg>
        </Animated.View>
      ))}
    </View>
  );
}
