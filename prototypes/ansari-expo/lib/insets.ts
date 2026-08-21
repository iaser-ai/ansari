import { Platform } from 'react-native';
import type { EdgeInsets } from 'react-native-safe-area-context';

/**
 * Web previews render inside an iframe without native safe areas, so we add
 * fixed insets on web only. Native platforms use the real safe-area values.
 */
export function screenInsets(insets: EdgeInsets): {
  top: number;
  bottom: number;
} {
  if (Platform.OS === 'web') {
    return { top: Math.max(insets.top, 67), bottom: Math.max(insets.bottom, 34) };
  }
  return { top: insets.top, bottom: insets.bottom };
}
