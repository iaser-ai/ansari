import React, { useEffect } from 'react';
import { View, type ViewStyle } from 'react-native';
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
import { useColors } from '@/hooks/useColors';
import { DURATION, EASE_IN_OUT, EASE_OUT } from '@/constants/motion';
import { withAlpha } from '@/lib/color';
import { RADIUS, rounded } from '@/constants/radius';

/**
 * Held space, for content that has not arrived yet.
 *
 * The rule these follow is the whole point of them: a placeholder must
 * take *exactly* the room the real thing will take, so that data
 * arriving fills a shape rather than pushing the page around under a
 * reader who has already started reading. Everything here is therefore
 * sized in the units of the type it stands in for — a line's own
 * `lineHeight`, a row's own box — rather than in round numbers that
 * happen to look about right.
 *
 * And they read as unset type on a page, not as a loading widget: paper
 * ink at a low alpha, no spinner, no shimmer sweep, no grey pills. The
 * one thing that moves is a very slow breath of opacity, and reduce
 * motion stills even that.
 */

/**
 * How long a load may run before the reader is told anything at all.
 *
 * The *space* is reserved from the first frame — that is what stops the
 * page moving — but the marks inside it stay invisible for this long,
 * so a load that returns quickly never flashes a placeholder for a few
 * frames on its way to the real content.
 */
export const PLACEHOLDER_GRACE_MS = 220;

/** Half a breath. Slow enough to be felt rather than watched. */
const BREATH_MS = 1500;

/** The ink a mark is drawn in: the page's own, barely laid down. */
function usePlaceholderInk(): string {
  const colors = useColors();
  return withAlpha(colors.foreground, 0.08);
}

/**
 * The group that holds a set of marks. It owns the grace period and the
 * breath, so every mark inside a placeholder breathes together rather
 * than each one on its own clock.
 */
export function Placeholder({
  children,
  style,
  grace = PLACEHOLDER_GRACE_MS,
}: {
  children: React.ReactNode;
  style?: ViewStyle | (ViewStyle | false | undefined)[];
  /**
   * How long this particular load may run before its marks appear.
   *
   * The default suits a load a reader is waiting on, where silence past
   * a fifth of a second reads as nothing happening. A load that is
   * merely furnishing a screen the reader can already use wants longer:
   * marks that appear and are replaced a moment later are a layer
   * loading in, and the reader was not waiting for them.
   */
  grace?: number;
}) {
  const reducedMotion = useReducedMotion();
  // Arrival: nothing at all for the grace period, then the marks ease
  // up. Never a hard cut — the marks are the quietest thing on the page
  // and should not announce themselves.
  const shown = useSharedValue(0);
  // The breath, kept as a separate value so reduce motion can hold it
  // at 1 without touching the arrival.
  const breath = useSharedValue(1);

  useEffect(() => {
    shown.set(
      withDelay(
        grace,
        withTiming(1, { duration: DURATION.enter, easing: EASE_OUT }),
      ),
    );
    return () => cancelAnimation(shown);
  }, [shown, grace]);

  useEffect(() => {
    if (reducedMotion) {
      breath.set(1);
      return;
    }
    breath.set(
      withDelay(
        grace,
        withRepeat(
          withSequence(
            withTiming(0.55, { duration: BREATH_MS, easing: EASE_IN_OUT }),
            withTiming(1, { duration: BREATH_MS, easing: EASE_IN_OUT }),
          ),
          -1,
          false,
        ),
      ),
    );
    return () => cancelAnimation(breath);
  }, [breath, grace, reducedMotion]);

  const fade = useAnimatedStyle(() => ({
    opacity: shown.get() * breath.get(),
  }));

  return (
    <Animated.View
      style={[style as ViewStyle, fade]}
      pointerEvents="none"
      // Nothing here is content. A reader on a screen reader hears the
      // list's own "loading" wording, not a row of empty boxes.
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      aria-hidden
    >
      {children}
    </Animated.View>
  );
}

/**
 * One line of type that has not arrived.
 *
 * `lineHeight` is the real line box — the placeholder occupies it
 * exactly — and the mark inside is drawn at roughly an x-height, centred
 * in that box, so the page's rhythm is right even though the words are
 * missing.
 */
export function PlaceholderLine({
  width,
  lineHeight,
  ink = Math.round(lineHeight * 0.46),
  style,
}: {
  width: number | `${number}%`;
  lineHeight: number;
  /** Height of the mark itself; defaults to about an x-height. */
  ink?: number;
  style?: ViewStyle;
}) {
  const color = usePlaceholderInk();
  return (
    <View style={[{ height: lineHeight, justifyContent: 'center' }, style]}>
      <View
        style={{
          width,
          height: ink,
          ...rounded(Math.min(ink / 2, RADIUS.xxs)),
          backgroundColor: color,
        }}
      />
    </View>
  );
}

/**
 * A mark that stands in for something that is not type — an icon, a
 * timestamp, the block a filled card occupies.
 */
export function PlaceholderMark({
  width,
  height,
  radius,
  style,
}: {
  width: number | `${number}%`;
  height: number;
  radius?: number;
  style?: ViewStyle;
}) {
  const color = usePlaceholderInk();
  return (
    <View
      style={[
        {
          width,
          height,
          ...rounded(radius ?? Math.min(height / 2, RADIUS.xs)),
          backgroundColor: color,
        },
        style,
      ]}
    />
  );
}
