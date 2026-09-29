import { Platform, ScrollView, ScrollViewProps } from 'react-native';
import {
  KeyboardAwareScrollView,
  KeyboardAwareScrollViewProps,
} from 'react-native-keyboard-controller';

type Props = KeyboardAwareScrollViewProps & ScrollViewProps;

/**
 * A scroller that keeps the field being typed into above the keyboard.
 *
 * Native has the keyboard controller's own, which scrolls the focused
 * field into view and pads the content while the keyboard is up.
 *
 * The web needs neither: the shell is shortened to the room left above
 * the keyboard (see `hooks/useKeyboard.web.ts`), so a raised keyboard
 * makes this scroller shorter rather than covering its foot, and the
 * browser scrolls a focused field into view within it by itself. A
 * plain `ScrollView` is the whole of the web path.
 */
export function KeyboardAwareScrollViewCompat({
  children,
  keyboardShouldPersistTaps = 'handled',
  ...props
}: Props) {
  if (Platform.OS === 'web') {
    return (
      <ScrollView
        keyboardShouldPersistTaps={keyboardShouldPersistTaps}
        {...props}
      >
        {children}
      </ScrollView>
    );
  }
  return (
    <KeyboardAwareScrollView
      keyboardShouldPersistTaps={keyboardShouldPersistTaps}
      {...props}
    >
      {children}
    </KeyboardAwareScrollView>
  );
}
