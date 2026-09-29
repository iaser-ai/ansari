import React from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  View,
  type ViewStyle,
} from 'react-native';
import { Feather } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import Animated, {
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import colors, { brass, night, stone } from '@/constants/colors';
import { useScheme } from '@/hooks/useScheme';
import { withAlpha } from '@/lib/color';
import { isHovered } from '@/lib/web';
import { rounded } from '@/constants/radius';

/**
 * Send: a quiet disc until there is a question, then brass.
 *
 * With nothing typed the control is inert — no metal, no relief, no
 * light, and no edge — but it is still visibly *there*: one step of
 * value above the composer it sits in, so the bar never looks
 * unfinished at rest. (It used to be drawn at the composer's own value
 * in dark mode, which made the button disappear into the field until
 * you typed.) The moment there is something worth sending the disc is
 * struck from the same brass as the emblem, so the two brass things on
 * the page belong to one object rather than a logo and a chat button.
 *
 * The relief is built the way the emblem builds it, only in layers of
 * view rather than layers of path: the brass ramp read diagonally, a
 * bright lip catching the light along the top of the rim and the deep
 * tone along the bottom. The rim arrives with the metal — a disabled
 * disc is flat, and flat means flat.
 *
 * The arrow travels the other way from the disc: muted stone ink while
 * nothing can be sent, pale and catching the light once the metal is
 * under it.
 *
 * Hover and press are carried by light on the metal — a breath of glint
 * across it under the pointer, a shadow pressed into it under a finger
 * — never by the material changing.
 */

/**
 * The disc is 42 so the composer stands at a true 66 (42 + 12 + 12).
 * The *target* is grown past the 44pt minimum with hit slop instead, so
 * the bar's height is not held hostage to it.
 */
const SIZE = 42;
const TARGET_SLOP = 5;

/** The bright band the mark's gradient wears near its top-left shoulder. */
const LIT_LOCATIONS = [0, 0.13, 0.27, 0.58, 0.86, 1] as const;

const CORNER = { x: 0, y: 0 };
const OPPOSITE = { x: 1, y: 1 };

export function BrassSendButton({
  onPress,
  canSend,
  sending,
  shimmer = false,
  testID,
}: {
  onPress: () => void;
  /** Whether there is a question worth sending: the metal arrives. */
  canSend: boolean;
  sending: boolean;
  /**
   * Catch the light once, the first time the metal appears. Reserved
   * for the home screen — the one moment the button is the thing to
   * notice. A glint on every thread's composer would be a tic.
   */
  shimmer?: boolean;
  testID?: string;
}) {
  const dark = useScheme() === 'dark';
  const palette = dark ? colors.dark : colors.light;
  const metal = dark ? brass.dark : brass.light;
  const reducedMotion = useReducedMotion();

  // Sending keeps the metal lit: the question is gone from the field,
  // but the control is still the active thing on the screen.
  const active = canSend || sending;

  // The brass rises rather than snaps: light arriving on metal, not a
  // colour swapping. Two stacked fills and an opacity between them,
  // because gradient stops cannot be interpolated on the UI thread and
  // an opacity can.
  const lit = useSharedValue(active ? 1 : 0);
  React.useEffect(() => {
    lit.set(
      withTiming(active ? 1 : 0, {
        duration: 220,
        easing: Easing.out(Easing.quad),
      }),
    );
  }, [active, lit]);
  const litFade = useAnimatedStyle(() => ({ opacity: lit.get() }));
  const unlitFade = useAnimatedStyle(() => ({ opacity: 1 - lit.get() }));

  // The sweep: 0 parks the band off the left of the disc, 1 off the
  // right. It runs once, on the UI thread, the first time the disc
  // turns to metal — the only moment there is any metal to catch it.
  // Parked at either end the band is not drawn at all, so nothing shows
  // before or after.
  const sweep = useSharedValue(0);
  const swept = React.useRef(false);
  React.useEffect(() => {
    if (!shimmer || reducedMotion || swept.current || !active) return;
    swept.current = true;
    sweep.set(
      withTiming(1, { duration: 700, easing: Easing.inOut(Easing.quad) }),
    );
  }, [shimmer, reducedMotion, active, sweep]);
  const sheenTravel = useAnimatedStyle(() => {
    const t = sweep.get();
    return {
      opacity: t > 0 && t < 1 ? 1 : 0,
      transform: [{ rotate: '18deg' }, { translateX: -SIZE + t * 2 * SIZE }],
    };
  });

  return (
    <Pressable
      onPress={onPress}
      disabled={!canSend}
      // The disc stays 42 so the composer stays 66; the target that
      // matters to a thumb is grown around it.
      hitSlop={TARGET_SLOP}
      accessibilityRole="button"
      accessibilityLabel={
        sending ? 'Answer is being prepared' : 'Send question'
      }
      accessibilityState={{ disabled: !canSend, busy: sending }}
      testID={testID}
      style={
        [styles.button, { cursor: canSend ? 'pointer' : 'auto' }] as ViewStyle[]
      }
    >
      {(state) => (
        <View style={styles.disc}>
          {/* Inert: one quiet step above the composer, and nothing else —
            a plain fill with no edge of its own, plainly not ready. */}
          <Animated.View
            style={[
              StyleSheet.absoluteFill,
              { backgroundColor: dark ? night.lifted : stone[300] },
              unlitFade,
            ]}
          />

          {/* Struck: the emblem's own ramp, read corner to corner. */}
          <Animated.View style={[StyleSheet.absoluteFill, litFade]}>
            <LinearGradient
              colors={[
                metal.warm,
                metal.highlight,
                metal.warm,
                metal.mid,
                metal.deep,
                metal.deep,
              ]}
              locations={[...LIT_LOCATIONS]}
              start={CORNER}
              end={OPPOSITE}
              style={StyleSheet.absoluteFill}
            />

            {shimmer && !reducedMotion && (
              // A single pass of light across the metal as it arrives.
              // It runs off the edge of the disc at both ends, so nothing
              // is visible before or after.
              <Animated.View style={[styles.sheen, sheenTravel]}>
                <LinearGradient
                  colors={[
                    withAlpha(metal.glint, 0),
                    withAlpha(metal.glint, dark ? 0.38 : 0.6),
                    withAlpha(metal.glint, 0),
                  ]}
                  locations={[0, 0.5, 1]}
                  start={{ x: 0, y: 0.5 }}
                  end={{ x: 1, y: 0.5 }}
                  style={StyleSheet.absoluteFill}
                />
              </Animated.View>
            )}

            {/* The relief: a bright lip along the top where the light
              lands, the deep tone along the bottom where it does not.
              This one inset pair is what turns a filled circle into a
              raised disc — and it belongs to the metal, not to the
              stone.

              No drawn outline under it. A struck disc is not a circle
              with a line around it; the metal's own value against the
              composer (3.2:1 by day, 3.6:1 at night) is what gives it
              an edge, and an ink ring on top only flattened it. */}
            <View
              style={[
                styles.rim,
                {
                  boxShadow: [
                    `inset 0 1px 1px ${withAlpha(metal.glint, dark ? 0.3 : 0.55)}`,
                    `inset 0 -1px 1px ${withAlpha(metal.shadow, 0.35)}`,
                  ].join(', '),
                } as ViewStyle,
              ]}
              pointerEvents="none"
            />

            {/* Hover and press, on the metal only: a breath more light
              under the pointer, the light going out under a finger.
              Never a change of material. */}
            {(isHovered(state) || state.pressed) && (
              <View
                style={[
                  StyleSheet.absoluteFill,
                  {
                    backgroundColor: state.pressed
                      ? withAlpha(metal.shadow, 0.3)
                      : withAlpha(metal.glint, dark ? 0.18 : 0.32),
                  },
                ]}
                pointerEvents="none"
              />
            )}
          </Animated.View>

          {sending ? (
            <ActivityIndicator size="small" color={metal.glint} />
          ) : (
            <View style={styles.glyph}>
              {/* Stone ink while the disc is inert. */}
              <Animated.View style={[styles.glyphLayer, unlitFade]}>
                <Feather
                  name="arrow-up"
                  size={19}
                  color={palette.mutedForeground}
                />
              </Animated.View>
              {/* On metal the arrow is the part that catches the light,
                with the cut edge falling a fraction of a pixel beneath
                it so it reads as struck rather than printed. */}
              <Animated.View style={[styles.glyphLayer, litFade]}>
                <Feather
                  name="arrow-up"
                  size={19}
                  color={metal.shadow}
                  style={styles.glyphLip}
                />
                <Feather name="arrow-up" size={19} color={metal.glint} />
              </Animated.View>
              {/* Reserves the glyph's box; both states are drawn over it. */}
              <Feather name="arrow-up" size={19} color="transparent" />
            </View>
          )}
        </View>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    width: SIZE,
    height: SIZE,
    ...rounded(SIZE / 2),
  },
  disc: {
    ...StyleSheet.absoluteFillObject,
    ...rounded(SIZE / 2),
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
  },
  // Tall enough to cross the disc corner to corner while tilted.
  sheen: {
    position: 'absolute',
    top: -SIZE / 2,
    bottom: -SIZE / 2,
    left: SIZE / 2 - 9,
    width: 18,
  },
  rim: {
    ...StyleSheet.absoluteFillObject,
    ...rounded(SIZE / 2),
  },
  glyph: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  glyphLayer: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
  },
  glyphLip: {
    position: 'absolute',
    opacity: 0.4,
    transform: [{ translateY: 0.6 }],
  },
});
