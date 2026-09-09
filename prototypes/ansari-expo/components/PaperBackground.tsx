import React, { useEffect } from 'react';
import { Image, Platform, StyleSheet, View } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { useColors } from '@/hooks/useColors';
import { useScheme } from '@/hooks/useScheme';
import { night } from '@/constants/colors';
import { EASE_IN_OUT, SCREEN_FADE_MS } from '@/constants/motion';

const AnimatedImage = Animated.createAnimatedComponent(Image);

/**
 * Day lays the tile on as ink; night lifts it on as light, so the two
 * carry the same weight of texture at different opacities.
 */
const GRAIN_OPACITY = { light: 0.8, dark: 0.34 };

const grain = require('@/assets/images/grain.png');
// react-native-web doesn't tile with resizeMode="repeat"; use CSS there.
const grainUri =
  Platform.OS === 'web'
    ? ((grain as { uri?: string })?.uri ?? (grain as unknown as string))
    : null;

/**
 * The "sunlit paper" surface: warm greige background with a fine
 * film-grain tile. The grain is a tiny (96px) mostly-transparent PNG
 * repeated across the screen — it costs nothing at first paint and
 * never intercepts touches.
 *
 * `grain` can be turned off for a screen that is mostly long-form
 * reading: the tile is a texture for an empty page, and under a full
 * column of body text it only competes with the letterforms.
 *
 * The paper is mounted once, above the screens, so that turning the
 * grain off is a change to the page rather than a change *of* page. It
 * therefore fades on the same beat the screens cross-dissolve on: a cut
 * would take the texture off the whole surface in a single frame, which
 * is exactly the thing the reader notices.
 *
 * At night the tile is *lightened* onto the page rather than laid over
 * it. The grain is a dark-speckled texture: painted flat on charcoal it
 * only muddies the page into a grey haze, however low the opacity goes.
 * Screen-blending inverts its job — the speckle becomes the faintest
 * scatter of light on the paper, which is what a texture does in a dark
 * room — so it can be carried at a real opacity and still read as
 * atmosphere rather than dirt.
 */
export function PaperBackground({
  children,
  style,
  grain: showGrain = true,
}: {
  children?: React.ReactNode;
  style?: object;
  grain?: boolean;
}) {
  const colors = useColors();
  const dark = useScheme() === 'dark';
  const full = dark ? GRAIN_OPACITY.dark : GRAIN_OPACITY.light;

  const grainOpacity = useSharedValue(showGrain ? full : 0);
  useEffect(() => {
    grainOpacity.set(
      withTiming(showGrain ? full : 0, {
        duration: SCREEN_FADE_MS,
        easing: EASE_IN_OUT,
      }),
    );
  }, [full, grainOpacity, showGrain]);
  const grainFade = useAnimatedStyle(() => ({ opacity: grainOpacity.get() }));

  return (
    <View style={[styles.fill, { backgroundColor: colors.background }, style]}>
      <View style={StyleSheet.absoluteFillObject} pointerEvents="none">
        {Platform.OS === 'web' ? (
          <Animated.View
            style={[
              StyleSheet.absoluteFillObject,
              {
                backgroundImage: `url(${grainUri})`,
                backgroundRepeat: 'repeat',
                backgroundSize: '96px 96px',
                // Screen blending keeps only the tile's lighter values,
                // so the speckle lands as light on the page.
                ...(dark ? { mixBlendMode: 'screen' } : null),
              },
              grainFade,
            ]}
          />
        ) : (
          <AnimatedImage
            source={grain}
            resizeMode="repeat"
            // Native has no blend mode here, so the same idea is reached
            // by recolouring the speckle itself: the tile's alpha is
            // kept, its ink is replaced with the page's own light.
            tintColor={dark ? night.bright : undefined}
            style={[StyleSheet.absoluteFillObject, grainFade]}
            fadeDuration={0}
          />
        )}
      </View>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  fill: {
    flex: 1,
  },
});
