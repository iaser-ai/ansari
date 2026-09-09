import React from 'react';
import {
  Platform,
  Pressable,
  StyleSheet,
  View,
  type PressableStateCallbackType,
} from 'react-native';
import { BlurView } from 'expo-blur';
import { GlassView, isLiquidGlassAvailable } from 'expo-glass-effect';
import { useColors } from '@/hooks/useColors';
import { useScheme } from '@/hooks/useScheme';
import { withAlpha } from '@/lib/color';
import { isHovered } from '@/lib/web';
import { rounded } from '@/constants/radius';

const liquidGlass = Platform.OS === 'ios' && isLiquidGlassAvailable();

/**
 * A floating circular chrome button. On modern iOS it renders native
 * Liquid Glass and stays out of its way: `isInteractive` gives the
 * system's own touch shimmer, so the pressable adds no effects of its
 * own there. Other iOS versions get a real blur, Android/web a crafted
 * translucent linen fallback.
 *
 * Those fallbacks draw no outline. A ring around a round button is the
 * loudest way to say "this is pressable" and the least like the paper
 * and glass everything else here is made of, so the disc holds its own
 * shape instead: a firmer wash than the rim used to sit in front of,
 * and a contact shadow beneath it, which is how anything else on this
 * page reads as lifted off it.
 *
 * With the ring gone the ring's share of the press and hover feedback
 * has to be picked up too, so those states are carried by the fill —
 * a breath of the page's own ink washed over the disc, which moves the
 * right way in both modes — rather than by fading the whole button
 * toward the paper, which now takes its resting shape with it.
 */
export function GlassCircleButton({
  onPress,
  onLongPress,
  size = 46,
  children,
  accessibilityLabel,
  testID,
  style,
}: {
  onPress: () => void;
  onLongPress?: () => void;
  size?: number;
  children: React.ReactNode;
  /**
   * What the button does, said in words. These carry an icon and
   * nothing else, so without this a screen reader has only the test id
   * or silence to announce.
   */
  accessibilityLabel?: string;
  testID?: string;
  style?: object;
}) {
  const colors = useColors();
  const scheme = useScheme();
  const circle = {
    width: size,
    height: size,
    ...rounded(size / 2),
  };

  /**
   * Press and hover, drawn in the page's own ink so one recipe serves
   * both modes: `foreground` is dark on paper and light on charcoal, so
   * a wash of it always moves the disc away from its resting value
   * rather than toward the backdrop.
   */
  const stateWash = (state: PressableStateCallbackType) =>
    state.pressed
      ? withAlpha(colors.foreground, 0.14)
      : isHovered(state)
        ? withAlpha(colors.foreground, 0.06)
        : 'transparent';

  const surface = (state: PressableStateCallbackType) => {
    if (liquidGlass) {
      return (
        <GlassView
          style={[circle, styles.center]}
          glassEffectStyle="regular"
          isInteractive
          // Pin the glass to the app's scheme. Left on 'auto', each button
          // adapts to the brightness of the video drifting behind it, and
          // the pair can split light/dark on the same screen.
          colorScheme={scheme}
        >
          {children}
        </GlassView>
      );
    }
    if (Platform.OS === 'ios' || Platform.OS === 'web') {
      // Real backdrop blur — a system-material look on older iOS, CSS
      // backdrop-filter on web. The wash over it is what the eye reads
      // as the disc, so it carries the shape the rim used to draw.
      return (
        <View style={[circle, styles.clip]}>
          <BlurView
            intensity={36}
            tint={scheme === 'dark' ? 'dark' : 'light'}
            style={StyleSheet.absoluteFillObject}
          />
          <View
            style={[
              StyleSheet.absoluteFillObject,
              styles.center,
              { backgroundColor: colors.glassButtonFill },
            ]}
          >
            {children}
          </View>
          <View
            pointerEvents="none"
            style={[
              StyleSheet.absoluteFillObject,
              { backgroundColor: stateWash(state) },
            ]}
          />
        </View>
      );
    }
    return (
      <View
        style={[
          circle,
          styles.center,
          styles.clip,
          {
            // Android has no blur here, so the wash is the material.
            backgroundColor: colors.glassButtonFill,
          },
        ]}
      >
        {children}
        <View
          pointerEvents="none"
          style={[
            StyleSheet.absoluteFillObject,
            { backgroundColor: stateWash(state) },
          ]}
        />
      </View>
    );
  };

  // The contact shadow that stands in for the removed rim. It has to
  // live out here rather than on the disc: the disc clips its own blur,
  // and a clipped layer cannot cast anything past its own bounds.
  const depth = {
    ...rounded(size / 2),
    boxShadow: `0 1px 2px ${colors.shadowTintSoft}, 0 4px 12px ${colors.shadowTint}`,
  } as object;

  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      hitSlop={8}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      testID={testID}
      style={liquidGlass ? style : [style, styles.pointer, depth]}
    >
      {(state) => surface(state)}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  center: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  clip: {
    overflow: 'hidden',
  },
  pointer: {
    cursor: 'pointer',
  },
});
