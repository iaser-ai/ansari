import { Platform, useWindowDimensions } from 'react-native';

/**
 * The single desktop breakpoint. Below it, the phone composition ships
 * exactly as-is on every platform; at or above it — web only — screens
 * present the "calm sanctuary, scaled up" composition: centered capped
 * widths, wrapped chips, sheets as centered dialogs.
 *
 * Native is phone-only (`supportsTablet` is false), so this is always
 * false off the web and native layouts cannot change. One breakpoint,
 * no tablet middle state.
 */
export const DESKTOP_MIN_WIDTH = 800;

export function useDesktop(): boolean {
  const { width } = useWindowDimensions();
  return Platform.OS === 'web' && width >= DESKTOP_MIN_WIDTH;
}
