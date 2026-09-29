import React from 'react';
import { Platform, View, type ViewProps } from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';

/**
 * The stage a screen stands on, holding itself clear of the keyboard.
 *
 * Native has this already: the keyboard controller's own
 * `KeyboardAvoidingView` pads the stage in step with the real
 * keyboard's animation, which is what makes the composer ride it.
 *
 * On the web there is nothing for it to listen to — the library's web
 * build stubs its keyboard bindings out — but there is also nothing
 * left for it to do. The shell itself is shortened to the room left
 * above the keyboard (see `hooks/useKeyboard.web.ts`), so a stage that
 * fills its parent is already clear of it. Padding it a second time
 * would lift the composer a keyboard's height too far.
 */
export function KeyboardAvoidingViewCompat({ children, ...props }: ViewProps) {
  if (Platform.OS === 'web') {
    return <View {...props}>{children}</View>;
  }
  return (
    <KeyboardAvoidingView behavior="padding" {...props}>
      {children}
    </KeyboardAvoidingView>
  );
}
