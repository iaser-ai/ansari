import React from 'react';
import { Platform, Pressable, StyleSheet, View } from 'react-native';
import { BlurView } from 'expo-blur';
import { GlassView, isLiquidGlassAvailable } from 'expo-glass-effect';
import { useColors } from '@/hooks/useColors';
import { useScheme } from '@/hooks/useScheme';
import { withAlpha } from '@/lib/color';
import { isHovered } from '@/lib/web';

const liquidGlass = Platform.OS === 'ios' && isLiquidGlassAvailable();

/**
 * A floating circular chrome button. On modern iOS it renders native
 * Liquid Glass and stays out of its way: `isInteractive` gives the
 * system's own touch shimmer, so the pressable adds no effects of its
 * own there. Other iOS versions get a real blur, Android/web a crafted
 * translucent linen fallback — those branches dip opacity on press.
 */
export function GlassCircleButton({
  onPress,
  onLongPress,
  size = 46,
  children,
  testID,
  style,
}: {
  onPress: () => void;
  onLongPress?: () => void;
  size?: number;
  children: React.ReactNode;
  testID?: string;
  style?: object;
}) {
  const colors = useColors();
  const scheme = useScheme();
  const circle = {
    width: size,
    height: size,
    borderRadius: size / 2,
  };

  let surface: React.ReactNode;
  if (liquidGlass) {
    surface = (
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
  } else if (Platform.OS === 'ios' || Platform.OS === 'web') {
    // Real backdrop blur — a system-material look on older iOS, CSS
    // backdrop-filter on web. A faint linen wash keeps icons legible.
    surface = (
      <View
        style={[
          circle,
          styles.clip,
          {
            borderWidth: StyleSheet.hairlineWidth,
            borderColor: colors.border,
          },
        ]}
      >
        <BlurView
          intensity={36}
          tint={scheme === 'dark' ? 'dark' : 'light'}
          style={StyleSheet.absoluteFillObject}
        />
        <View
          style={[
            StyleSheet.absoluteFillObject,
            styles.center,
            {
              backgroundColor: withAlpha(
                colors.card,
                scheme === 'dark' ? 0.32 : 0.4,
              ),
            },
          ]}
        >
          {children}
        </View>
      </View>
    );
  } else {
    surface = (
      <View
        style={[
          circle,
          styles.center,
          {
            backgroundColor:
              scheme === 'dark'
                ? 'rgba(40, 37, 32, 0.82)'
                : 'rgba(240, 237, 230, 0.82)',
            borderWidth: StyleSheet.hairlineWidth,
            borderColor: colors.border,
          },
        ]}
      >
        {children}
      </View>
    );
  }

  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      hitSlop={8}
      testID={testID}
      style={
        liquidGlass
          ? style
          : (state) => [
              style,
              styles.pointer,
              { opacity: state.pressed ? 0.7 : isHovered(state) ? 0.85 : 1 },
            ]
      }
    >
      {surface}
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
