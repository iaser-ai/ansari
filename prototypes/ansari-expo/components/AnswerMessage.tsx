import React, { useMemo } from 'react';
import {
  Linking,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import * as Haptics from 'expo-haptics';
import Animated, { FadeInDown, ReduceMotion } from 'react-native-reanimated';
import { useColors } from '@/hooks/useColors';
import { useDesktop } from '@/hooks/useDesktop';
import { fonts } from '@/constants/colors';
import { withAlpha } from '@/lib/color';
import { isHovered } from '@/lib/web';
import { CitationChip, toSuperscript } from '@/components/CitationChip';
import { SafetyCard } from '@/components/SafetyCard';
import {
  firstStrongIsRtl,
  inlineText,
  parseMarkdown,
  splitArabicRuns,
  type Block,
  type InlineNode,
} from '@/lib/markdown';
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
 * The answer body is markdown (see `lib/markdown.ts`): emphasis,
 * headers, lists, blockquotes, and links all render typographically
 * instead of as literal syntax. Arabic runs — Qur'an text is often set
 * inside bold or a blockquote — take the Amiri face at a legible size,
 * and any block whose first strong character is Arabic lays out
 * right-to-left. Because answers stream in over SSE, the parser
 * tolerates partial syntax, and the parse is memoized per content
 * string so an in-flight answer re-parses, never re-mounts.
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

  const blocks = useMemo(
    () => parseMarkdown(message.content),
    [message.content],
  );

  const openCitation = (citation: Citation) => {
    if (Platform.OS !== 'web') {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }
    onCitationPress(citation);
  };

  // A plain text run: substitute [N] citation chips, and set Arabic
  // spans in Amiri a step up from the prose size (Amiri runs small at a
  // given nominal size). Bidi ordering is the platform's job — it sees
  // the whole paragraph — these spans only carry the face change.
  const renderTextRun = (text: string, key: string) =>
    text.split(/(\[\d+\])/).map((segment, si) => {
      const match = segment.match(/^\[(\d+)\]$/);
      if (match) {
        const citation = byMarker.get(Number(match[1]));
        if (citation) {
          return (
            <CitationChip
              key={`${key}-${si}`}
              citation={citation}
              onPress={onCitationPress}
            />
          );
        }
      }
      return splitArabicRuns(segment).map((run, ri) =>
        run.arabic ? (
          <Text key={`${key}-${si}-${ri}`} style={styles.arabicRun}>
            {run.text}
          </Text>
        ) : (
          <Text key={`${key}-${si}-${ri}`}>{run.text}</Text>
        ),
      );
    });

  const renderInline = (nodes: InlineNode[], key: string): React.ReactNode =>
    nodes.map((node, ni) => {
      const k = `${key}-${ni}`;
      switch (node.type) {
        case 'text':
          return renderTextRun(node.text, k);
        case 'strong':
          return (
            <Text key={k} style={styles.strong}>
              {renderInline(node.children, k)}
            </Text>
          );
        case 'em':
          return (
            <Text key={k} style={styles.em}>
              {renderInline(node.children, k)}
            </Text>
          );
        case 'link':
          return (
            <Text
              key={k}
              accessibilityRole="link"
              suppressHighlighting
              onPress={() => Linking.openURL(node.href)}
              style={[styles.link, { color: colors.accent }]}
            >
              {renderInline(node.children, k)}
            </Text>
          );
      }
    });

  const proseStyle = [
    styles.paragraph,
    desktop && styles.paragraphDesktop,
    // Unboxed: the ink comes from the page, not a card.
    { color: colors.foreground },
  ];

  const renderBlock = (block: Block, bi: number) => {
    const spacing = bi > 0 && styles.blockSpacing;
    // First-strong direction, per block: an Arabic verse or du'a lays
    // out right-to-left while the English prose around it stays LTR.
    const rtl = (children: InlineNode[]) =>
      firstStrongIsRtl(inlineText(children)) && styles.rtlBlock;

    switch (block.type) {
      case 'heading':
        return (
          <Text
            key={bi}
            selectable={Platform.OS === 'web'}
            accessibilityRole="header"
            style={[
              proseStyle,
              spacing,
              block.level <= 2 ? styles.headingLarge : styles.headingSmall,
              rtl(block.children),
            ]}
          >
            {renderInline(block.children, `b${bi}`)}
          </Text>
        );
      case 'list':
        return (
          <View key={bi} style={[styles.list, spacing]}>
            {block.items.map((item, ii) => {
              const itemRtl = firstStrongIsRtl(inlineText(item));
              return (
                <View
                  key={ii}
                  style={[styles.listRow, itemRtl && styles.listRowRtl]}
                >
                  <Text style={[proseStyle, styles.listMarker]}>
                    {block.ordered ? `${ii + 1}.` : '•'}
                  </Text>
                  <Text
                    selectable={Platform.OS === 'web'}
                    style={[
                      proseStyle,
                      styles.listContent,
                      itemRtl && styles.rtlBlock,
                    ]}
                  >
                    {renderInline(item, `b${bi}-i${ii}`)}
                  </Text>
                </View>
              );
            })}
          </View>
        );
      case 'blockquote': {
        const isRtl = firstStrongIsRtl(inlineText(block.children));
        return (
          <View
            key={bi}
            style={[
              styles.blockquote,
              spacing,
              // The quote bar sits on the side the text starts from.
              isRtl
                ? { borderRightWidth: 2, paddingRight: 14 }
                : { borderLeftWidth: 2, paddingLeft: 14 },
              { borderColor: withAlpha(colors.accent, 0.55) },
            ]}
          >
            <Text
              selectable={Platform.OS === 'web'}
              style={[proseStyle, isRtl && styles.rtlBlock]}
            >
              {renderInline(block.children, `b${bi}`)}
            </Text>
          </View>
        );
      }
      case 'rule':
        return (
          <View
            key={bi}
            style={[
              styles.mdRule,
              spacing,
              { backgroundColor: colors.border },
            ]}
          />
        );
      case 'paragraph':
        return (
          <Text
            key={bi}
            selectable={Platform.OS === 'web'}
            style={[proseStyle, spacing, rtl(block.children)]}
          >
            {renderInline(block.children, `b${bi}`)}
          </Text>
        );
    }
  };

  return (
    <Animated.View
      entering={FadeInDown.duration(320).reduceMotion(ReduceMotion.System)}
      style={styles.container}
    >
      <View>
        {blocks.map(renderBlock)}

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
  blockSpacing: {
    marginTop: 15,
  },
  // Markdown voices, all in the answer's own faces. Bold and italic map
  // to the prose family's heavier/italic cuts, never a synthetic style.
  strong: {
    fontFamily: fonts.proseSemiBold,
  },
  em: {
    fontFamily: fonts.proseItalic,
  },
  link: {
    textDecorationLine: 'underline',
    fontFamily: fonts.proseMedium,
    cursor: 'pointer',
  },
  // Amiri runs small at a nominal size, so inline Arabic takes a step
  // up; the paragraph's leading is generous enough to hold it without
  // the line growing.
  arabicRun: {
    fontFamily: fonts.arabic,
    fontSize: 21,
  },
  // Headings stay close to the body size — chat answers are short
  // documents, so a heading is a labeled pause, not a poster.
  headingLarge: {
    fontSize: 20,
    lineHeight: 30,
    fontFamily: fonts.proseSemiBold,
  },
  headingSmall: {
    fontSize: 18,
    lineHeight: 28,
    fontFamily: fonts.proseSemiBold,
  },
  rtlBlock: {
    writingDirection: 'rtl',
    textAlign: 'right',
  },
  list: {
    gap: 6,
  },
  listRow: {
    flexDirection: 'row',
  },
  listRowRtl: {
    flexDirection: 'row-reverse',
  },
  listMarker: {
    width: 26,
    textAlign: 'center',
  },
  listContent: {
    flex: 1,
  },
  blockquote: {
    marginVertical: 2,
  },
  mdRule: {
    height: StyleSheet.hairlineWidth,
    marginVertical: 4,
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
