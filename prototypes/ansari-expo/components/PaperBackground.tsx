import React from 'react';
import {
  Image,
  Platform,
  StyleSheet,
  View,
} from 'react-native';
import { useColors } from '@/hooks/useColors';
import { useScheme } from '@/hooks/useScheme';

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
 */
export function PaperBackground({
  children,
  style,
}: {
  children?: React.ReactNode;
  style?: object;
}) {
  const colors = useColors();
  const scheme = useScheme();
  return (
    <View
      style={[styles.fill, { backgroundColor: colors.background }, style]}
    >
      <View style={StyleSheet.absoluteFillObject} pointerEvents="none">
        {Platform.OS === 'web' ? (
          <View
            style={[
              StyleSheet.absoluteFillObject,
              {
                opacity: scheme === 'dark' ? 0.5 : 0.8,
                backgroundImage: `url(${grainUri})`,
                backgroundRepeat: 'repeat',
                backgroundSize: '96px 96px',
              },
            ]}
          />
        ) : (
          <Image
            source={grain}
            resizeMode="repeat"
            style={[
              StyleSheet.absoluteFillObject,
              { opacity: scheme === 'dark' ? 0.5 : 0.8 },
            ]}
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
