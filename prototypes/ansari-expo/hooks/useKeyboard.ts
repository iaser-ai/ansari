import { useReanimatedKeyboardAnimation } from 'react-native-keyboard-controller';
import { type SharedValue } from 'react-native-reanimated';

/**
 * The on-screen keyboard, as the rest of the app needs to see it.
 *
 * Native has a keyboard controller that reports the real thing, frame
 * by frame, on the UI thread — this file is a thin pass-through to it.
 * The web has no keyboard event at all and has to infer the keyboard
 * from the shape of the viewport; that is `useKeyboard.web.ts`, and
 * these two files exist so no screen has to know which it is talking
 * to.
 *
 * Neither platform reports a *covered band* any more, because on
 * neither does the keyboard end up covering the app: native pads the
 * stage through the controller's own `KeyboardAvoidingView`, and the
 * web shortens the shell to the visible viewport. All a screen needs is
 * whether the keyboard is up, so that is all there is here.
 */

/** 0 with the keyboard away, 1 with it fully raised. */
export function useKeyboardProgress(): SharedValue<number> {
  return useReanimatedKeyboardAnimation().progress;
}
