import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Animated, { FadeIn, ReduceMotion } from 'react-native-reanimated';
import { AnsariMarkPulse } from '@/components/AnsariMarkPulse';
import { useColors } from '@/hooks/useColors';
import { fonts } from '@/constants/colors';
import { DURATION, EASE_OUT } from '@/constants/motion';
import { formatTraceLine, type TraceEntry } from '@/lib/chat-trace';

// A line of status arriving: a small change in place, held back a beat
// so an answer that comes straight back never shows it at all.
const WAIT_ENTER = FadeIn.duration(DURATION.state)
  .easing(EASE_OUT)
  .delay(180)
  .reduceMotion(ReduceMotion.System);

/**
 * The waiting state sits on the paper exactly as the answer will —
 * unboxed, so nothing has to dissolve away when the text arrives. It
 * only fades in (no travel), beneath the question that prompted it.
 *
 * Drawn on both screens: it appears under the lifted question on the
 * home screen while the conversation is being created, and continues
 * into the thread. Pass `animate={false}` where it is already on screen
 * (the thread's first frame), so it does not fade in a second time.
 *
 * While the model searches the sources, `trace` carries one line per
 * tool call ("Searching hadith for "patience" — 12 results"). It is
 * transient — shown only here, while awaiting the answer, never
 * persisted or replayed — and it is not citation UI: it shows what the
 * answer is being built FROM. Empty (or absent) falls back to the plain
 * "Searching the sources…" line.
 */
export function ThinkingLine({
  animate = true,
  trace = [],
}: {
  animate?: boolean;
  trace?: TraceEntry[];
}) {
  const colors = useColors();
  const lines =
    trace.length > 0
      ? trace.map(formatTraceLine)
      : ['Searching the sources…'];
  // One line sits centred on the mark, as it always has; a stack of
  // trace lines aligns to the top so the mark stays with the first.
  const multiline = lines.length > 1;
  return (
    <Animated.View
      entering={animate ? WAIT_ENTER : undefined}
      style={[styles.row, multiline ? styles.rowTop : styles.rowCenter]}
    >
      {/* Sized to the line of type it stands in, not to an icon slot:
          the mark's height is the text's own em box, so its star sits
          level with the ascenders and its arcs with the descenders,
          and it reads as the first character of the line. Top-aligned,
          so it sits with the first trace line while the rest stack
          beneath it. */}
      <AnsariMarkPulse height={MARK_HEIGHT} />
      <View style={styles.lines}>
        {lines.map((line, i) => (
          <Text
            key={i}
            style={[styles.text, { color: colors.mutedForeground }]}
          >
            {line}
          </Text>
        ))}
      </View>
    </Animated.View>
  );
}

/** The status line's own size, so the mark stands as tall as the type. */
const MARK_HEIGHT = 15;

const styles = StyleSheet.create({
  // No card: the same air the answer sits in, so the answer can simply
  // replace these words without a surface dissolving away.
  row: {
    flexDirection: 'row',
    gap: 10,
    paddingVertical: 4,
    alignSelf: 'flex-start',
  },
  rowCenter: {
    alignItems: 'center',
  },
  rowTop: {
    alignItems: 'flex-start',
  },
  lines: {
    flexShrink: 1,
    gap: 4,
  },
  text: {
    fontSize: 15,
    lineHeight: 20,
    fontFamily: fonts.displayItalic,
  },
});
