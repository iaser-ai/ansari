import { Platform, type PressableStateCallbackType } from 'react-native';

/**
 * Whether the app is being read in a browser with a finger.
 *
 * The one question that separates a real phone browser from the
 * phone-shaped window the app is previewed in on a desktop, and it is
 * asked of the pointer rather than the screen: a narrow desktop window
 * is still a mouse, and a touchscreen laptop still reports a fine
 * primary pointer. What hangs on it is everything a browser only does
 * with a finger — reporting safe areas, raising a keyboard, magnifying
 * a small field when it is tapped.
 *
 * Evaluated once. A pointer does not change kind mid-session, and the
 * things that read this read it during render.
 */
export const touchBrowser =
  Platform.OS === 'web' &&
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(pointer: coarse)').matches;

/**
 * react-native-web extends Pressable's state callback with `hovered`
 * and `focused`. Core react-native types don't know about them, so
 * hover styling narrows through this helper: real on web, simply
 * absent (false) on native.
 */
type WebPressState = PressableStateCallbackType & {
  hovered?: boolean;
  focused?: boolean;
};

export function isHovered(state: PressableStateCallbackType): boolean {
  return (state as WebPressState).hovered === true;
}
