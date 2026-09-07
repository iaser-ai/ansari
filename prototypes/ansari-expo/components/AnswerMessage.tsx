import React, { useMemo, useState } from 'react';
import {
  Platform,
  Pressable,
  Share,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useColors } from '@/hooks/useColors';
import { fonts } from '@/constants/colors';
import { withAlpha } from '@/lib/color';
import { isHovered } from '@/lib/web';
import { copyToClipboard } from '@/lib/clipboard';
import { tapHaptic } from '@/lib/haptics';
import { openMessageActions } from '@/lib/messageActions';
import { toast } from '@/lib/toast';
import { PressableScale } from '@/components/PressableScale';
import { SafetyCard } from '@/components/SafetyCard';
import type { Citation, Message } from '@/lib/api';
import { AnswerProse } from '@/components/AnswerProse';
import { toSuperscript } from '@/components/CitationChip';
import { RADIUS, rounded } from '@/constants/radius';

/**
 * The room the answer's two pills claim beyond their drawn box, taking
 * a 36pt control to the 44pt a thumb needs without touching the look of
 * it. Sideways too, because they sit as a pair.
 */
const ANSWER_ACTION_SLOP = { top: 4, bottom: 4, left: 4, right: 4 } as const;

/**
 * Renders an assistant answer as a book page: unboxed serif prose set
 * directly on the paper — no card, border, or fill — with small
 * superscript footnote markers inline, then a quiet footnote block at
 * the foot of the same page: a short hairline rule and one restrained
 * line per source, as at the foot of a printed page. Source-type
 * distinction is carried by wording and type (the source title sits in
 * the serif italic), never by badges.
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
  onSourcesOpen,
}: {
  message: Message;
  onSourcesOpen: (message: Message, marker: number) => void;
}) {
  const colors = useColors();
  const byMarker = useMemo(() => {
    const map = new Map<number, Citation>();
    for (const c of message.citations) map.set(c.marker, c);
    return map;
  }, [message.citations]);

  const footnotes = useMemo(
    () => [...message.citations].sort((a, b) => a.marker - b.marker),
    [message.citations],
  );

  // One action for both ways in. A mark in the prose and a line at the
  // foot of the page are the same request — show this answer's sources,
  // starting at this one — so neither one gets to open a different
  // thing from the other.
  const openSources = (citation: Citation) => {
    tapHaptic();
    onSourcesOpen(message, citation.marker);
  };
  // Copying is the plainest case for a notice over a dialog: the reader
  // is mid-answer, and a modal would cost them a tap to undo a tap.
  const copyAnswer = async () => {
    if (await copyToClipboard(message.content)) {
      toast.success('Answer copied');
      return;
    }
    toast.error("Couldn't copy the answer", {
      detail: 'Hold the answer down and select the part you need.',
    });
  };
  const shareAnswer = async () => {
    try {
      await Share.share({ message: message.content });
    } catch {
      toast.error('Sharing is unavailable', {
        detail: 'Hold the answer down and select the part you need.',
      });
    }
  };

  // Selection is off until it is asked for, and asked for through the
  // hold menu below. A selectable <Text> claims the long press for the
  // platform's own magnifier, so an answer that was selectable from the
  // start could never be held down for anything else — and a thumb
  // dragging the thread would keep catching on the words. See
  // `lib/messageActions`.
  const [selecting, setSelecting] = useState(false);

  // A finger has no hover, so the copy and share that a pointer finds
  // by resting on the answer are reached by holding it instead. The
  // press is the app's default tap; the sheet arriving is the rest of
  // the feedback.
  const holdForActions =
    Platform.OS === 'web'
      ? undefined
      : () => {
          tapHaptic();
          openMessageActions({
            kind: 'answer',
            text: message.content,
            onSelectText: () => setSelecting(true),
          });
        };

  // No entrance of its own: an answer is a row in the thread's
  // virtualized list, and a list row that animates on mount replays
  // that entrance every time the reader scrolls it back into view. The
  // thread decides what is genuinely new and animates it there.
  const page = (
    <>
      {/* Unboxed: the ink comes from the page, not a card. The prose
            sets the answer's Markdown in the answer's own voice, and
            keeps the paragraph rhythm for text that has none. */}
      <AnswerProse
        content={message.content}
        byMarker={byMarker}
        onCitationPress={openSources}
        selectable={selecting}
      />

      {footnotes.length > 0 && (
        <View style={styles.footnotes}>
          <View
            style={[styles.footnoteRule, { backgroundColor: colors.border }]}
          />
          {footnotes.map((citation) => (
            <PressableScale
              key={citation.id}
              onPress={() => openSources(citation)}
              accessibilityRole="button"
              accessibilityLabel={`Sources for this answer, from source ${citation.marker}: ${citation.reference}, ${citation.sourceTitle}`}
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
                <Text style={[styles.footnoteMarker, { color: colors.accent }]}>
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
            </PressableScale>
          ))}
        </View>
      )}
      <View style={styles.answerActions}>
        <PressableScale
          onPress={() => void copyAnswer()}
          accessibilityRole="button"
          accessibilityLabel="Copy answer"
          // A pill this quiet has to stay this quiet — it sits at the
          // foot of every answer — so the thumb is given its room
          // outside the drawn box rather than inside it. 36 drawn,
          // 44 to hit, and nothing about it looks any different.
          hitSlop={ANSWER_ACTION_SLOP}
          style={(state) => [
            styles.answerAction,
            {
              borderColor: colors.border,
              opacity: state.pressed ? 0.6 : isHovered(state) ? 0.78 : 1,
            },
          ]}
        >
          <Feather name="copy" size={14} color={colors.mutedForeground} />
          <Text
            style={[styles.answerActionText, { color: colors.mutedForeground }]}
          >
            Copy
          </Text>
        </PressableScale>
        <PressableScale
          onPress={() => void shareAnswer()}
          accessibilityRole="button"
          accessibilityLabel="Share answer"
          hitSlop={ANSWER_ACTION_SLOP}
          style={(state) => [
            styles.answerAction,
            {
              borderColor: colors.border,
              opacity: state.pressed ? 0.6 : isHovered(state) ? 0.78 : 1,
            },
          ]}
        >
          <Feather name="share-2" size={14} color={colors.mutedForeground} />
          <Text
            style={[styles.answerActionText, { color: colors.mutedForeground }]}
          >
            Share
          </Text>
        </PressableScale>
      </View>
    </>
  );

  // No entrance of its own: an answer is a row in the thread's
  // virtualized list, and a list row that animates on mount replays
  // that entrance every time the reader scrolls it back into view. The
  // thread decides what is genuinely new and animates it there.
  return (
    <View style={styles.container}>
      {/* Held down, the whole answer offers what a pointer gets for
          free from hover. `accessible={false}`: a screen reader must
          still walk the prose, the footnotes and the two buttons
          separately rather than hearing the answer collapsed into one
          long-press target.

          The web keeps the plain box it always had. A held mouse button
          is not a gesture anyone makes, and a pressable would put a
          pointer cursor over a column of prose a reader is trying to
          select. */}
      {holdForActions ? (
        <Pressable onLongPress={holdForActions} accessible={false}>
          {page}
        </Pressable>
      ) : (
        <View>{page}</View>
      )}

      {message.safety && <SafetyCard safety={message.safety} />}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: 12,
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
    // Clamped by the 44 minimum to the 22 it always drew; a wrapped
    // one settles at 24 rather than turning into a lozenge.
    ...rounded(RADIUS.xl),
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
  answerActions: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 4,
  },
  answerAction: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    minHeight: 36,
    paddingHorizontal: 11,
    borderWidth: StyleSheet.hairlineWidth,
    ...rounded(RADIUS.pill),
    cursor: 'pointer',
  },
  answerActionText: {
    fontSize: 12.5,
    fontFamily: fonts.bodyMedium,
  },
});
