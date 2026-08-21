import React from 'react';
import { Pressable, StyleSheet, Text } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useColors } from '@/hooks/useColors';
import { fonts } from '@/constants/colors';
import { isHovered } from '@/lib/web';

/**
 * Quiet text chrome for desktop web. Where floating OS-style glass
 * circles feel foreign in a browser, navigation reads as calm inked
 * words — History, About, Back — that darken under the pointer.
 * Phones and native keep their glass circles; this renders only in
 * the desktop composition.
 */
export function WebNavButton({
  label,
  onPress,
  icon,
  testID,
}: {
  label: string;
  onPress: () => void;
  icon?: keyof typeof Feather.glyphMap;
  testID?: string;
}) {
  const colors = useColors();
  return (
    <Pressable
      onPress={onPress}
      hitSlop={6}
      testID={testID}
      accessibilityRole="button"
      style={(state) => [styles.button, { opacity: state.pressed ? 0.6 : 1 }]}
    >
      {(state) => {
        const ink = isHovered(state)
          ? colors.foreground
          : colors.mutedForeground;
        return (
          <>
            {icon && <Feather name={icon} size={15} color={ink} />}
            <Text style={[styles.label, { color: ink }]}>{label}</Text>
          </>
        );
      }}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingVertical: 6,
    paddingHorizontal: 8,
    cursor: 'pointer',
  },
  label: {
    fontSize: 14,
    letterSpacing: 0.2,
    fontFamily: fonts.bodyMedium,
  },
});
