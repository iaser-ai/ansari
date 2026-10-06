import React, { useState } from 'react';
import { Platform, StyleSheet, Text, View, type TextStyle } from 'react-native';
import { tapHaptic } from '@/lib/haptics';
import { useColors } from '@/hooks/useColors';
import { fonts } from '@/constants/colors';
import { withAlpha } from '@/lib/color';
import type { Citation } from '@/lib/api';

const SUPERSCRIPT_DIGITS = ['⁰', '¹', '²', '³', '⁴', '⁵', '⁶', '⁷', '⁸', '⁹'];

/**
 * Renders a number with real superior figures ("12" → "¹²"). Literata
 * and Inter both map U+00B9/B2/B3 and U+2070–2079, so the marks are true
 * typographic superscripts that never disturb line height.
 */
export function toSuperscript(value: number): string {
  return String(value)
    .split('')
    .map((digit) => SUPERSCRIPT_DIGITS[Number(digit)] ?? digit)
    .join('');
}

/**
 * Inline footnote marker in the answer text flow: the source's number in
 * brass, on a small brass-tinted disc, so it reads as something to tap
 * rather than as coloured type — and still sits inside the sentence
 * without opening its line.
 *
 * The disc is the same brass as the superior figure the Sources pills
 * and the folio carry, so the mark in the sentence and the pill at the
 * foot are visibly the same source. The number on it is a plain lining
 * figure: the disc already lifts it out of the line, and a superior
 * figure inside a disc would float to its top edge.
 *
 * Building the disc: a nested <Text> cannot take a corner radius on
 * native, so there the disc is an inline <View> (which RN lays out in
 * the text flow). On the web the nested <Text> is a <span>, which takes
 * `inline-flex` and a radius directly and so stays in the text — it
 * selects and copies with the sentence. An `inline-flex` box is an
 * atomic inline, which a line may break in front of, so `AnswerProse`
 * sets the chip in one unbreakable run with the word before it.
 *
 * Hit area: the outer run is set a step above the answer's body size
 * and spaced with a hair space before and a thin space after, so the
 * target is a comfortable ~25pt run even though the disc is small.
 * `pressRetentionOffset` keeps the press alive if the thumb drifts. The
 * footnote block at the foot of the answer offers a full-width 44pt
 * target for every source as the redundant path.
 *
 * Press feedback is ink, not scale: a transform on a nested <Text> is
 * ignored on native. The disc deepens and the figure darkens the instant
 * it is touched, which is the same immediacy by another means.
 */
export function CitationChip({
  citation,
  onPress,
}: {
  citation: Citation;
  onPress: (citation: Citation) => void;
}) {
  const colors = useColors();
  const [pressed, setPressed] = useState(false);
  const press = {
    onPress: () => {
      tapHaptic();
      onPress(citation);
    },
    onPressIn: () => setPressed(true),
    onPressOut: () => setPressed(false),
  };
  const ink = pressed ? colors.strongForeground : colors.accent;
  const wash = withAlpha(colors.accent, pressed ? 0.34 : 0.18);
  const figure = String(citation.marker);

  return (
    <Text
      {...press}
      pressRetentionOffset={{ top: 14, bottom: 14, left: 10, right: 10 }}
      suppressHighlighting
      accessibilityRole="link"
      accessibilityLabel={`Source ${citation.marker}: ${citation.reference}`}
      style={styles.run}
      testID={`citation-chip-${citation.marker}`}
    >
      {'\u200A'}
      {Platform.OS === 'web' ? (
        <Text
          style={[
            styles.disc,
            styles.discFigure,
            WEB_DISC,
            { backgroundColor: wash, color: ink },
          ]}
          testID={`citation-disc-${citation.marker}`}
        >
          {figure}
        </Text>
      ) : (
        <View style={[styles.disc, styles.discNative, { backgroundColor: wash }]}>
          <Text {...press} style={[styles.discFigure, { color: ink }]}>
            {figure}
          </Text>
        </View>
      )}
      {'\u2009'}
    </Text>
  );
}

/** The disc's size: a little over the answer's x-height, so it never opens a line. */
const DISC = 18;

/**
 * On the web the disc is the <span> itself. `inline-flex` is not in
 * React Native's style types, but react-native-web passes it through.
 */
const WEB_DISC = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  verticalAlign: 'text-top',
} as unknown as TextStyle;

const styles = StyleSheet.create({
  run: {
    fontSize: 19,
    cursor: 'pointer',
  },
  // A disc for one figure, a stadium for two.
  disc: {
    minWidth: DISC,
    height: DISC,
    paddingHorizontal: 4,
    borderRadius: DISC / 2,
  },
  discNative: {
    alignItems: 'center',
    justifyContent: 'center',
    transform: [{ translateY: -3 }],
  },
  discFigure: {
    fontSize: 11.5,
    lineHeight: DISC,
    fontFamily: fonts.proseSemiBold,
  },
});
