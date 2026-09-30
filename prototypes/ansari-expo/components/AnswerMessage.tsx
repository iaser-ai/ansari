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
import { isHovered } from '@/lib/web';
import { copyToClipboard } from '@/lib/clipboard';
import { tapHaptic } from '@/lib/haptics';
import { openMessageActions } from '@/lib/messageActions';
import { toast } from '@/lib/toast';
import { PressableScale } from '@/components/PressableScale';
import { SafetyCard } from '@/components/SafetyCard';
import type { Citation, Message } from '@/lib/api';
import { AnswerProse } from '@/components/AnswerProse';
import { groupFootnotes } from '@/lib/footnote-groups';
import { answerWithSources } from '@/lib/answer-text';
import { FootnoteGroup } from '@/components/FootnoteGroup';
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
 * the foot of the same page: a short hairline rule, then the sources
 * grouped by kind — Qur'an, hadith, scholarly works — as quiet pills
 * that sit side by side. Source-type
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
  generating = false,
}: {
  message: Message;
  onSourcesOpen: (message: Message, marker: number) => void;
  /**
   * The answer is still being written. Copy and Share wait until it is
   * finished: there is nothing whole yet to copy or pass on.
   */
  generating?: boolean;
}) {
  const colors = useColors();
  const byMarker = useMemo(() => {
    const map = new Map<number, Citation>();
    for (const c of message.citations) map.set(c.marker, c);
    return map;
  }, [message.citations]);

  const footnoteGroups = useMemo(
    () => groupFootnotes(message.citations),
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
  // What Copy, Share and the hold menu hand on: the prose with its
  // sources keyed underneath, so a pasted `[3]` still points somewhere.
  const shareableText = useMemo(
    () => answerWithSources(message.content, message.citations),
    [message.content, message.citations],
  );
  const hasSources = message.citations.length > 0;

  // Copying is the plainest case for a notice over a dialog: the reader
  // is mid-answer, and a modal would cost them a tap to undo a tap.
  const copyAnswer = async () => {
    if (await copyToClipboard(shareableText)) {
      toast.success(hasSources ? 'Answer and sources copied' : 'Answer copied');
      return;
    }
    toast.error("Couldn't copy the answer", {
      detail: 'Hold the answer down and select the part you need.',
    });
  };
  const shareAnswer = async () => {
    try {
      await Share.share({ message: shareableText });
    } catch {
      toast.error('Sharing is unavailable', {
        detail: 'Hold the answer down and select the part you need.',
      });
    }
  };

  // On a phone, selection is off until it is asked for, and asked for
  // through the hold menu below. A selectable <Text> claims the long
  // press for the platform's own magnifier, so an answer that was
  // selectable from the start could never be held down for anything
  // else — and a thumb dragging the thread would keep catching on the
  // words. See `lib/messageActions`. The web has a cursor, no hold
  // menu, and nothing to arbitrate: the words are simply selectable.
  const [selecting, setSelecting] = useState(Platform.OS === 'web');

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
            text: shareableText,
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

      {footnoteGroups.length > 0 && (
        <View style={styles.footnotes}>
          <View
            style={[styles.footnoteRule, { backgroundColor: colors.border }]}
          />
          <Text
            style={[styles.footnoteTitle, { color: colors.strongForeground }]}
            accessibilityRole="header"
          >
            Sources
            <Text style={{ color: colors.mutedForeground }}>
              {' · '}
              {message.citations.length}
            </Text>
          </Text>
          {/* Grouped by kind, pills side by side, each group folded past
              three rows: twenty sources one to a line made the foot of
              the page longer than the answer (#194). */}
          {footnoteGroups.map((group) => (
            <FootnoteGroup key={group.kind} group={group} onOpen={openSources} />
          ))}
        </View>
      )}
      {!generating && (
        // With sources above them, the actions stand clear of the
        // source block — a wider break than any gap inside it — so they
        // read as acting on the whole answer, not on its last group.
        <View
          style={[
            styles.answerActions,
            footnoteGroups.length > 0 && styles.answerActionsAfterSources,
          ]}
        >
          <PressableScale
            onPress={() => void copyAnswer()}
            accessibilityRole="button"
            accessibilityLabel={hasSources ? 'Copy answer with sources' : 'Copy answer'}
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
            accessibilityLabel={hasSources ? 'Share answer with sources' : 'Share answer'}
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
      )}
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
  // The foot of the page: a short rule, then the sources by kind.
  footnotes: {
    marginTop: 18,
    alignItems: 'flex-start',
    gap: 14,
  },
  footnoteRule: {
    width: 56,
    height: StyleSheet.hairlineWidth,
  },
  // The block's own title, in the display face the folio's reference
  // is set in, so it reads as the heading of an apparatus.
  footnoteTitle: {
    fontSize: 15,
    fontFamily: fonts.display,
  },
  answerActions: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 4,
  },
  answerActionsAfterSources: {
    marginTop: 28,
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
