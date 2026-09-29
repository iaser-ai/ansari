import React, { useId, useState } from 'react';
import {
  Platform,
  Pressable,
  StyleSheet,
  TextInput,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useColors } from '@/hooks/useColors';
import { fonts } from '@/constants/colors';
import { CONTINUOUS } from '@/constants/radius';
import { isHovered, touchBrowser } from '@/lib/web';
import { selfInkedFocusId } from '@/lib/semantics';

/**
 * The one search field.
 *
 * The rail and the history sheet used to invent their own: one a
 * borderless pill on a 4.5%-white wash, the other a bordered box on the
 * muted surface, each with its own placeholder ink and each removing
 * the browser's focus outline without drawing anything in its place.
 * They now share this: the same recessed bed, the same hairline, the
 * same stadium, the same placeholder, caret and selection colours, and
 * the same focus cue.
 *
 * Two sizes only, because there are two places: `compact` for the
 * desktop rail, `regular` for the history sheet.
 */
export function SearchField({
  value,
  onChangeText,
  placeholder,
  accessibilityLabel,
  autoFocus = false,
  size = 'regular',
  onClear,
  testID,
  style,
}: {
  value: string;
  onChangeText: (next: string) => void;
  placeholder: string;
  accessibilityLabel: string;
  autoFocus?: boolean;
  size?: 'compact' | 'regular';
  /** Renders a clear affordance once there is something to clear. */
  onClear?: () => void;
  testID?: string;
  style?: StyleProp<ViewStyle>;
}) {
  const colors = useColors();
  const fieldKey = useId();
  const [focused, setFocused] = useState(false);
  const compact = size === 'compact';
  const height = compact ? 32 : Platform.OS === 'web' ? 40 : 36;

  return (
    <View style={[compact ? styles.compactWrap : styles.wrap, style]}>
      <View
        style={[
          styles.field,
          {
            minHeight: height,
            borderRadius: height / 2,
            paddingHorizontal: compact ? 11 : 14,
            gap: compact ? 7 : 8,
            backgroundColor: colors.inputFill,
            // Focus inks the rim the field already wears rather than
            // drawing a ring outside it. Same width, same radius, same
            // insets — nothing moves, and no colour arrives.
            borderColor: focused ? colors.inputRimFocus : colors.inputRim,
          },
        ]}
      >
        <Feather
          name="search"
          size={compact ? 13 : 15}
          color={colors.mutedForeground}
        />
        <TextInput
          value={value}
          onChangeText={onChangeText}
          placeholder={placeholder}
          placeholderTextColor={colors.placeholder}
          // The caret. Native also tints the selection handles from
          // `selectionColor`; on web the selection wash is set once,
          // globally, from the same palette.
          cursorColor={colors.caret}
          selectionColor={colors.caret}
          autoFocus={autoFocus}
          returnKeyType="search"
          // The inked rim *is* this field's focus cue, so it says so by
          // name and the page's ring stays off it. Named per mounted
          // field, since the rail and the history sheet each have one.
          // See `SELF_INKED_FOCUS`.
          nativeID={selfInkedFocusId(fieldKey)}
          accessibilityLabel={accessibilityLabel}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          testID={testID}
          style={[
            styles.input,
            {
              // Mobile Safari magnifies the whole page when a field
              // with a face under 16px is tapped, and then leaves it
              // magnified — the reader is dropped into a search box
              // twice the size of the sheet around it, and has to
              // pinch their way back out. The field carries a 16px
              // face on a phone browser instead. The alternative,
              // locking the viewport scale, would take pinch-zoom away
              // from everyone who reads by it.
              fontSize: touchBrowser ? 16 : compact ? 12.5 : 14.5,
              color: colors.foreground,
            },
          ]}
        />
        {onClear && value.length > 0 && (
          <Pressable
            onPress={onClear}
            hitSlop={10}
            accessibilityRole="button"
            accessibilityLabel="Clear search"
            style={(state) => [
              styles.clear,
              { opacity: state.pressed || isHovered(state) ? 0.7 : 1 },
            ]}
          >
            <Feather
              name="x-circle"
              size={compact ? 13 : 15}
              color={colors.mutedForeground}
            />
          </Pressable>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  // Only spacing now that nothing is drawn outside the field, but both
  // wrappers keep the position context the clear affordance sits in.
  wrap: { position: 'relative' },
  compactWrap: { position: 'relative', marginTop: 12 },
  field: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    ...CONTINUOUS,
  },
  input: {
    flex: 1,
    fontFamily: fonts.body,
    // A flex child in a browser refuses to shrink below its content;
    // without this the field pushes the rail wider than the rail is.
    ...(Platform.OS === 'web' ? ({ minWidth: 0 } as object) : {}),
  },
  clear: {
    ...(Platform.OS === 'web' ? ({ cursor: 'pointer' } as object) : {}),
  },
});
