import React, { useId, useState } from 'react';
import { StyleSheet, TextInput, View } from 'react-native';
import { useColors } from '@/hooks/useColors';
import { fonts } from '@/constants/colors';
import { RADIUS, rounded } from '@/constants/radius';
import { touchBrowser } from '@/lib/web';
import { selfInkedFocusId } from '@/lib/semantics';

/**
 * One field, in the app's recessed-bed style: `inputFill` under a
 * hairline that inks on focus rather than drawing a ring outside it —
 * the same treatment `SearchField` wears, so every place a reader types
 * in this app looks like the same place.
 */
export function Field({
  label,
  value,
  onChangeText,
  ...input
}: {
  label: string;
  value: string;
  onChangeText: (next: string) => void;
} & React.ComponentProps<typeof TextInput>) {
  const colors = useColors();
  const fieldKey = useId();
  const [focused, setFocused] = useState(false);
  return (
    <View
      style={[
        styles.field,
        {
          backgroundColor: colors.inputFill,
          borderColor: focused ? colors.inputRimFocus : colors.inputRim,
        },
      ]}
    >
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={label}
        placeholderTextColor={colors.placeholder}
        cursorColor={colors.caret}
        selectionColor={colors.caret}
        nativeID={selfInkedFocusId(fieldKey)}
        accessibilityLabel={label}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        style={[
          styles.input,
          {
            // Mobile Safari magnifies the page around any field with a
            // sub-16px face; carry 16px on a phone browser (see
            // `SearchField` for the same guard).
            fontSize: touchBrowser ? 16 : 15.5,
            color: colors.foreground,
          },
        ]}
        {...input}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  field: {
    minHeight: 50,
    justifyContent: 'center',
    paddingHorizontal: 15,
    ...rounded(RADIUS.md),
    borderWidth: StyleSheet.hairlineWidth,
  },
  input: {
    fontFamily: fonts.body,
    // The bed carries the vertical centring; the field keeps no line
    // padding of its own so a 16px browser face still sits centred.
    paddingVertical: 0,
  },
});
