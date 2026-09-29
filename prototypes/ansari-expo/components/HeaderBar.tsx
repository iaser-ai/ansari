import React from 'react';
import { Platform, StyleSheet, View, type ViewStyle } from 'react-native';
import { BlurView, type BlurTint } from 'expo-blur';
import { useColors } from '@/hooks/useColors';
import { useScheme } from '@/hooks/useScheme';
import { withAlpha } from '@/lib/color';

/**
 * The floating navigation material: one uniform frosted bar spanning
 * from the physical top edge (behind the status bar) down through the
 * title row — the Apple Maps / Settings treatment, where content
 * scrolls and visibly blurs beneath floating chrome.
 *
 * One blur surface renders real blur on all three platforms:
 * - iOS: the system's own chrome material (UIVisualEffectView). It is
 *   never masked or gradient-clipped — masking silently disables the
 *   effect — so the bar is one hard-edged surface.
 * - Android: real blur-behind through expo-blur's experimental Dimezis
 *   renderer (RenderEffect on Android 12+). No flat-tint fallback.
 * - Web: CSS backdrop-filter applied to the floating wrapper itself.
 *   It cannot live on a BlurView child: the z-indexed wrapper forms a
 *   stacking context, and a child's backdrop-filter samples only what
 *   is painted beneath it *inside* that context — nothing — so the
 *   blur silently no-ops (verified empirically in Chrome). On the
 *   wrapper, the backdrop is the screen behind the bar, transcript
 *   included, and the blur is real.
 *
 * iOS's material carries its own fill, so it takes only a faint paper
 * wash; on Android/web the base fill is nearly clear and the wash
 * does the tinting, keeping the bar in the same warm glass family as
 * the floating buttons. A hairline seats it over busy content.
 */
export function HeaderBar({ height }: { height: number }) {
  const colors = useColors();
  const dark = useScheme() === 'dark';

  if (Platform.OS === 'web') {
    // The backdrop recipe and the base fill both come from the palette,
    // because they differ by more than a number between modes: on paper
    // the glass is brightened a touch and floored in white, on charcoal
    // it is brightened hard — the only way a bar can read as *above*
    // a dark page — and floored in the page's own warm black.
    const webGlass = {
      backdropFilter: colors.glassFilter,
      WebkitBackdropFilter: colors.glassFilter,
      backgroundColor: colors.glassBase,
    } as unknown as ViewStyle;
    return (
      <View
        style={[
          styles.wrap,
          webGlass,
          { height, borderBottomColor: dark ? colors.glassRim : colors.border },
        ]}
        pointerEvents="none"
      >
        <View
          style={[
            StyleSheet.absoluteFill,
            {
              backgroundColor: withAlpha(colors.background, dark ? 0.34 : 0.42),
            },
          ]}
        />
      </View>
    );
  }

  let tint: BlurTint;
  let wash: number;
  if (Platform.OS === 'ios') {
    tint = dark ? 'systemChromeMaterialDark' : 'systemChromeMaterialLight';
    wash = dark ? 0.2 : 0.16;
  } else {
    tint = dark ? 'systemUltraThinMaterialDark' : 'default';
    wash = dark ? 0.4 : 0.42;
  }

  return (
    <View
      style={[
        styles.wrap,
        {
          height,
          // On charcoal a dark rule under a dark bar is invisible; the
          // bar seats itself with a moonlit edge instead.
          borderBottomColor: dark ? colors.glassRim : colors.border,
        },
      ]}
      pointerEvents="none"
    >
      <BlurView
        intensity={100}
        tint={tint}
        experimentalBlurMethod="dimezisBlurView"
        style={StyleSheet.absoluteFill}
      />
      <View
        style={[
          StyleSheet.absoluteFill,
          { backgroundColor: withAlpha(colors.background, wash) },
        ]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
});
