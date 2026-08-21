import type { PressableStateCallbackType } from 'react-native';

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
