import React, { useMemo } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import * as Haptics from 'expo-haptics';
import Animated, { FadeInDown, ReduceMotion } from 'react-native-reanimated';
import { useColors } from '@/hooks/useColors';
import { useDesktop } from '@/hooks/useDesktop';
import { fonts } from '@/constants/colors';
import { withAlpha } from '@/lib/color';
import { isHovered } from '@/lib/web';
import { CitationChip, toSuperscript } from '@/components/CitationChip';
import { SafetyCard } from '@/components/SafetyCard';
import type { Citation, Message } from '@/lib/api';

/**
 * Renders an assistant answer as a book page: unboxed serif prose set
 * directly on the paper — no card, border, or fill — with small
 * superscript footnote markers inline, then a quiet footnote block at
 * the foot of the same page: a short hairline rule and one restrained
 * line per source, as at the foot of a printed page. Source-type
 * distinction is carried by wording and type (the source title sits in
 * the Spectral italic), never by badges.
 *
 * Both the inline markers and the footnote lines open the illuminated
 * folio citation sheet. The footnote lines are the thumb-friendly
 * target, and they show it: rounded beige pills at least 44pt tall in
 * the same material as the reader's own messages, so a reader can see
 * at a glance that a source can be opened. A safety card follows when
 * the response carries a distress signal.
 */
export function AnswerMessage({
  message,
  onCitationPress,
}: {
  message: Message;
  onCitationPress: (citation: Citation) => void;
}) {
  const colors = useColors();
  const desktop = useDesktop();
  const byMarker = useMemo(() => {
    const map = new Map<number, Citation>();
    for (const c of message.citations) map.set(c.marker, c);
    return map;
  }, [message.citations]);

  const footnotes = useMemo(
    () => [...message.citations].sort((a, b) => a.marker - b.marker),
    [message.citations],
  );

  const paragraphs = useMemo(
    () => message.content.split(/\n{2,}/),
    [message.content],
  );

  const openCitation = (citation: Citation) => {
    if (Platform.OS !== 'web') {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }
    onCitationPress(citation);
  };

  return (
    <Animated.View
      entering={FadeInDown.duration(320).reduceMotion(ReduceMotion.System)}
      style={styles.container}
    >
      <View>
        {paragraphs.map((paragraph, pi) => (
          <Text
            key={pi}
            selectable={Platform.OS === 'web'}
            style={[
              styles.paragraph,
              desktop && styles.paragraphDesktop,
              // Unboxed: the ink comes from the page, not a card.
              { color: colors.foreground },
              pi > 0 && styles.paragraphSpacing,
            ]}
          >
            {paragraph.split(/(\[\d+\])/).map((segment, si) => {
              const match = segment.match(/^\[(\d+)\]$/);
              if (match) {
                const citation = byMarker.get(Number(match[1]));
                if (citation) {
                  return (
                    <CitationChip
                      key={si}
                      citation={citation}
                      onPress={onCitationPress}
                    />
                  );
                }
              }
              return <Text key={si}>{segment}</Text>;
            })}
          </Text>
        ))}

        {footnotes.length > 0 && (
          <View style={styles.footnotes}>
            <View
              style={[styles.footnoteRule, { backgroundColor: colors.border }]}
            />
            {footnotes.map((citation) => (
              <Pressable
                key={citation.id}
                onPress={() => openCitation(citation)}
                accessibilityRole="button"
                accessibilityLabel={`Source ${citation.marker}: ${citation.reference}, ${citation.sourceTitle}`}
                style={(state) => [
                  styles.footnoteLine,
                  {
                    // Outlined, not filled: a hairline ring drawn on
                    // the bare paper. Visibly a control, but the
                    // opposite material to the reader's own messages —
                    // their words are a solid card, the sources are
                    // engraved into the page. Pressing inks the ring in.
                    backgroundColor: state.pressed
                      ? withAlpha(colors.heroInk, 0.38)
                      : isHovered(state)
                        ? withAlpha(colors.heroInk, 0.16)
                        : 'transparent',
                    borderColor: withAlpha(colors.heroInk, 0.55),
                  },
                ]}
                testID={`footnote-${citation.marker}`}
              >
                <Text style={styles.footnoteText}>
                  <Text
                    style={[styles.footnoteMarker, { color: colors.accent }]}
                  >
                    {toSuperscript(citation.marker)}
                  </Text>
                  <Text
                    style={[
                      styles.footnoteReference,
                      { color: colors.secondaryForeground },
                    ]}
                  >
                    {'\u2009'}
                    {citation.reference}
                  </Text>
                  <Text
                    style={[
                      styles.footnoteSource,
                      { color: withAlpha(colors.secondaryForeground, 0.6) },
                    ]}
                  >
                    {' · '}
                    {citation.sourceTitle}
                  </Text>
                </Text>
              </Pressable>
            ))}
          </View>
        )}
      </View>

      {message.safety && <SafetyCard safety={message.safety} />}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: 12,
  },
  // Answers are set as reading matter, not chat: Literata's regular
  // weight at a book-like size with generous leading, sitting straight
  // on the paper. Its large x-height reads a step bigger than the same
  // nominal size in Spectral, so the size is pulled back slightly and
  // the leading kept open.
  paragraph: {
    fontSize: 17,
    lineHeight: 28.5,
    fontFamily: fonts.prose,
  },
  // Desktop reading: one comfortable step up in size and leading.
  paragraphDesktop: {
    fontSize: 18,
    lineHeight: 30.5,
  },
  paragraphSpacing: {
    marginTop: 15,
  },
  // The foot of the page: a short rule, then one quiet line per source.
  footnotes: {
    marginTop: 18,
    alignItems: 'flex-start',
    gap: 8,
  },
  footnoteRule: {
    width: 56,
    height: StyleSheet.hairlineWidth,
    marginBottom: 6,
  },
  // A comfortable thumb target that also *looks* like one: an outlined
  // pill, never under 44pt, hugging its reference so long ones wrap
  // onto a second line rather than truncating.
  footnoteLine: {
    maxWidth: '100%',
    minHeight: 44,
    justifyContent: 'center',
    paddingVertical: 9,
    paddingHorizontal: 15,
    borderRadius: 22,
    borderWidth: StyleSheet.hairlineWidth,
    cursor: 'pointer',
  },
  // The footnotes belong to the answer, so they speak in the answer's
  // voice rather than the app's chrome voice.
  footnoteText: {
    fontSize: 13,
    lineHeight: 19.5,
  },
  footnoteMarker: {
    fontFamily: fonts.proseSemiBold,
  },
  footnoteReference: {
    fontFamily: fonts.proseMedium,
  },
  footnoteSource: {
    fontFamily: fonts.proseItalic,
  },
});
