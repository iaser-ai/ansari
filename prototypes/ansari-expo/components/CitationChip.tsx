import React from 'react';
import { Platform, StyleSheet, Text } from 'react-native';
import * as Haptics from 'expo-haptics';
import { useColors } from '@/hooks/useColors';
import { fonts } from '@/constants/colors';
import type { Citation } from '@/vendor/api-client-react';

const SUPERSCRIPT_DIGITS = ['⁰', '¹', '²', '³', '⁴', '⁵', '⁶', '⁷', '⁸', '⁹'];

/**
 * Renders a number with real superior figures ("12" → "¹²"). Spectral and
 * Inter both map U+00B9/B2/B3 and U+2070–2079, so the marks are true
 * typographic superscripts that never disturb line height.
 */
export function toSuperscript(value: number): string {
  return String(value)
    .split('')
    .map((digit) => SUPERSCRIPT_DIGITS[Number(digit)] ?? digit)
    .join('');
}

/**
 * Inline footnote marker in the answer text flow: a small unboxed
 * superscript numeral in the scholarly serif, as in printed scholarship.
 * Implemented as a nested <Text> (not a Pressable) so it stays inline and
 * cross-platform safe inside a parent <Text>.
 *
 * Hit area: a nested <Text> takes no hitSlop, so the target is the text
 * run's own em box. The mark is therefore set a step above the answer's
 * body size — the superior figure's ink stays tiny, but the run it lives
 * in is a comfortable ~25pt tall — and spaced with a hair space before
 * (so it still tucks against its word) and a thin space after, which
 * widens the run without reading as a gap. `pressRetentionOffset` keeps
 * the press alive if the thumb drifts off the glyph. The footnote block
 * at the foot of the answer offers a full-width 44pt target for every
 * source as the redundant path.
 */
export function CitationChip({
  citation,
  onPress,
}: {
  citation: Citation;
  onPress: (citation: Citation) => void;
}) {
  const colors = useColors();
  return (
    <Text
      onPress={() => {
        if (Platform.OS !== 'web') {
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        }
        onPress(citation);
      }}
      pressRetentionOffset={{ top: 14, bottom: 14, left: 10, right: 10 }}
      suppressHighlighting
      accessibilityRole="link"
      accessibilityLabel={`Source ${citation.marker}: ${citation.reference}`}
      style={[styles.marker, { color: colors.accent }]}
      testID={`citation-chip-${citation.marker}`}
    >
      {`\u200A${toSuperscript(citation.marker)}\u2009`}
    </Text>
  );
}

const styles = StyleSheet.create({
  marker: {
    fontSize: 19,
    // Sits inside the answer's prose, so it takes the prose face.
    fontFamily: fonts.proseSemiBold,
    cursor: 'pointer',
  },
});
