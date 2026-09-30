import React, { useEffect } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Animated, {
  FadeIn,
  ReduceMotion,
  cancelAnimation,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';
import { AnsariMarkPulse } from '@/components/AnsariMarkPulse';
import { useColors } from '@/hooks/useColors';
import { fonts } from '@/constants/colors';
import { DURATION, EASE_IN_OUT, EASE_OUT } from '@/constants/motion';
import { ANSARI_MARK_EMBLEM_HEIGHT } from '@/constants/ansariMark';
import {
  sourceProgress,
  type SourceProgress,
  type SourceState,
  type TraceEntry,
} from '@/lib/chat-trace';

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
 * While the model searches, the line names every source Ansari can
 * consult — "Searching Qur'an · Hadith · Fiqh · Tafsir" — and `trace`
 * (one entry per tool call) lights each one as its search completes
 * (issue #204). The row is the same shape from the first frame to the
 * last, so it never grows as searches pile up: a source not searched
 * stays dim, the one being searched breathes, a finished one is fully
 * inked. The lead word holds at "Searching" throughout, so nothing at
 * the head of the line shifts under the reader. It is transient — shown only
 * here, while awaiting the answer, never persisted or replayed — and it
 * is not citation UI: it shows what the answer is being built FROM.
 */
export function ThinkingLine({
  animate = true,
  trace = [],
}: {
  animate?: boolean;
  trace?: TraceEntry[];
}) {
  const colors = useColors();
  const sources = sourceProgress(trace);
  const ink = { color: colors.mutedForeground };
  return (
    <Animated.View
      entering={animate ? WAIT_ENTER : undefined}
      style={styles.row}
      accessible
      accessibilityRole="text"
      accessibilityLabel={describe(sources)}
      accessibilityLiveRegion="polite"
    >
      {/* Sized to the line of type it stands in, not to an icon slot:
          the mark's height is the text's own em box, so its star sits
          level with the ascenders and its arcs with the descenders,
          and it reads as the first character of the line. */}
      <View style={styles.markSlot}>
        <AnsariMarkPulse height={MARK_HEIGHT} />
      </View>
      {/* One word per source, wrapping as words do: a single line on
          a phone, a second only on a narrow window or at the largest
          type sizes. Separate words rather than spans of one Text,
          because a nested span cannot take an opacity of its own. */}
      <View style={styles.words}>
        <Text style={[styles.text, ink]}>Searching</Text>
        {sources.map((source, i) => (
          <View key={source.key} style={styles.source}>
            {i > 0 && <Text style={[styles.text, ink, styles.dot]}>·</Text>}
            <SourceWord label={source.label} state={source.state} color={ink.color} />
          </View>
        ))}
      </View>
    </Animated.View>
  );
}

/** Not yet searched: recessive, but still legible as a name. */
const IDLE = 0.35;
/** The top of the breath while a source is being searched. */
const BREATH = 0.7;
/** Reduced motion: searching held between the two, and left there. */
const STILL_SEARCHING = 0.6;
const DONE = 1;

function SourceWord({
  label,
  state,
  color,
}: {
  label: string;
  state: SourceState;
  color: string;
}) {
  const still = useReducedMotion();
  const opacity = useSharedValue(IDLE);

  useEffect(() => {
    if (state === 'searching') {
      if (still) {
        opacity.set(STILL_SEARCHING);
        return;
      }
      // Breathes on the mark's own tempo, so the two read as one wait.
      opacity.set(
        withRepeat(
          withSequence(
            withTiming(BREATH, { duration: DURATION.enter * 2, easing: EASE_IN_OUT }),
            withTiming(IDLE, { duration: DURATION.enter * 2, easing: EASE_IN_OUT }),
          ),
          -1,
          false,
        ),
      );
      return () => cancelAnimation(opacity);
    }
    const target = state === 'done' ? DONE : IDLE;
    opacity.set(
      still ? target : withTiming(target, { duration: DURATION.state, easing: EASE_OUT }),
    );
  }, [opacity, state, still]);

  const style = useAnimatedStyle(() => ({ opacity: opacity.get() }));
  return <Animated.Text style={[styles.text, { color }, style]}>{label}</Animated.Text>;
}

/** What a screen reader hears in place of the opacity steps. */
function describe(sources: SourceProgress[]): string {
  const said: Record<SourceState, string> = {
    idle: 'not searched',
    searching: 'searching',
    done: 'done',
  };
  return `Searching sources. ${sources.map((s) => `${s.label} ${said[s.state]}`).join(', ')}.`;
}

/**
 * The answer is still being written: the waiting mark on its own, at
 * the foot of the growing answer.
 *
 * Once the first words arrive the status line has done its job and
 * steps aside, but the answer is not finished — so the mark stays,
 * without words, where the next line will appear. It stands alone here
 * rather than as a character in a line of type, so it takes the mark's
 * standing size (the sidebar emblem's), not the status line's. It
 * arrives on the same held-back fade as the line, so an answer that
 * completes at once never shows it, and it simply goes when the answer
 * is handed over — a fading footer would leave a gap that then snaps
 * shut.
 */
export function GeneratingMark() {
  return (
    <Animated.View entering={WAIT_ENTER} style={styles.generating}>
      <AnsariMarkPulse height={ANSARI_MARK_EMBLEM_HEIGHT} />
    </Animated.View>
  );
}

/** The status line's own size, so the mark stands as tall as the type. */
const MARK_HEIGHT = 15;
/** The status line's leading; the mark's slot matches it. */
const LINE_HEIGHT = 20;

const styles = StyleSheet.create({
  // No card: the same air the answer sits in, so the answer can simply
  // replace these words without a surface dissolving away.
  // The mark sits with the first line; a wrapped second line runs on
  // beneath the words, not beneath the mark.
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    paddingVertical: 4,
    alignSelf: 'flex-start',
  },
  // One line of type tall, so the mark centres on the first line
  // however many the words wrap to.
  markSlot: {
    height: LINE_HEIGHT,
    justifyContent: 'center',
  },
  generating: {
    paddingVertical: 4,
    alignSelf: 'flex-start',
  },
  words: {
    flexShrink: 1,
    flexDirection: 'row',
    flexWrap: 'wrap',
    columnGap: 6,
    rowGap: 2,
  },
  source: {
    flexDirection: 'row',
    columnGap: 6,
  },
  dot: {
    opacity: IDLE,
  },
  text: {
    fontSize: 15,
    lineHeight: LINE_HEIGHT,
    fontFamily: fonts.proseItalic,
  },
});
