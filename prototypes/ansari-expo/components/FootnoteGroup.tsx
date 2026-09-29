import React, { useMemo, useState } from 'react';
import { StyleSheet, Text, View, type LayoutChangeEvent } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useColors } from '@/hooks/useColors';
import { fonts } from '@/constants/colors';
import { withAlpha } from '@/lib/color';
import { isHovered } from '@/lib/web';
import { PressableScale } from '@/components/PressableScale';
import { toSuperscript } from '@/components/CitationChip';
import {
  FOOTNOTE_ROWS_SHOWN,
  foldAt,
  footnoteLabel,
  type FootnoteGroup as Group,
} from '@/lib/footnote-groups';
import type { Citation } from '@/lib/api';
import { RADIUS, rounded } from '@/constants/radius';

const PILL_MIN_HEIGHT = 44;
const PILL_GAP = 8;
/**
 * Three rows of one-line pills: the fold to hold before the pills have
 * been measured, so a long group mounts folded instead of drawing every
 * pill for a frame and then snapping shut under the reader.
 */
const UNMEASURED_FOLD =
  FOOTNOTE_ROWS_SHOWN * PILL_MIN_HEIGHT + (FOOTNOTE_ROWS_SHOWN - 1) * PILL_GAP;

/**
 * One kind of source at the foot of an answer — a heading, and its pills
 * side by side (issue #194).
 *
 * Past three rows the group folds, and says how much it is holding back.
 * The fold is measured, not counted: how many pills fit on a row depends
 * on the width of the column and of each reference, so the pills are all
 * laid out and the group is clipped at the top of its fourth row. The
 * pills below the fold stay mounted — that is what lets them be measured
 * — so they are taken out of the focus order and the accessibility tree
 * while they are out of sight.
 */
export function FootnoteGroup({
  group,
  onOpen,
}: {
  group: Group;
  onOpen: (citation: Citation) => void;
}) {
  const colors = useColors();
  const [tops, setTops] = useState<Record<string, number>>({});
  const [expanded, setExpanded] = useState(false);

  const measured = group.citations.every((c) => tops[c.id] !== undefined);
  const fold = useMemo(
    () =>
      measured ? foldAt(group.citations.map((c) => tops[c.id]!)) : null,
    [measured, group.citations, tops],
  );
  /** The top of the first hidden row, while the group is folded. */
  const foldTop = !expanded && fold ? fold.top : null;

  const onPillLayout = (id: string) => (event: LayoutChangeEvent) => {
    const { y } = event.nativeEvent.layout;
    setTops((prev) => (prev[id] === y ? prev : { ...prev, [id]: y }));
  };

  return (
    <View style={styles.group} testID={`footnote-group-${group.kind}`}>
      <Text
        style={[styles.heading, { color: colors.mutedForeground }]}
        accessibilityRole="header"
      >
        {group.label}
      </Text>
      <View
        style={[
          styles.clip,
          foldTop !== null
            ? { height: foldTop - PILL_GAP }
            : !measured && !expanded
              ? { maxHeight: UNMEASURED_FOLD }
              : null,
        ]}
      >
        <View style={styles.row}>
          {group.citations.map((citation) => {
            const hidden =
              foldTop !== null && Math.round(tops[citation.id]!) >= foldTop;
            return (
              <FootnotePill
                key={citation.id}
                citation={citation}
                hidden={hidden}
                onPress={() => onOpen(citation)}
                onLayout={onPillLayout(citation.id)}
              />
            );
          })}
        </View>
      </View>
      {fold !== null && (
        <PressableScale
          onPress={() => setExpanded((open) => !open)}
          hitSlop={{ top: 12, bottom: 12, left: 8, right: 8 }}
          accessibilityRole="button"
          accessibilityState={{ expanded }}
          accessibilityLabel={
            expanded
              ? `Show fewer ${group.label} sources`
              : `View ${fold.hidden} more ${group.label} sources`
          }
          style={(state) => [
            styles.toggle,
            { opacity: state.pressed ? 0.55 : isHovered(state) ? 0.78 : 1 },
          ]}
          testID={`footnote-toggle-${group.kind}`}
        >
          <Text
            style={[
              styles.toggleText,
              {
                color: colors.mutedForeground,
                textDecorationColor: colors.accent,
              },
            ]}
          >
            {expanded ? 'Show less' : `View ${fold.hidden} more`}
          </Text>
          <Feather
            name={expanded ? 'chevron-up' : 'chevron-down'}
            size={14}
            color={colors.accent}
          />
        </PressableScale>
      )}
    </View>
  );
}

function FootnotePill({
  citation,
  hidden,
  onPress,
  onLayout,
}: {
  citation: Citation;
  hidden: boolean;
  onPress: () => void;
  onLayout: (event: LayoutChangeEvent) => void;
}) {
  const colors = useColors();
  const label = footnoteLabel(citation);

  return (
    <PressableScale
      onPress={onPress}
      onLayout={onLayout}
      focusable={!hidden}
      accessibilityElementsHidden={hidden}
      importantForAccessibility={hidden ? 'no-hide-descendants' : 'auto'}
      aria-hidden={hidden}
      accessibilityRole="button"
      accessibilityLabel={`Sources for this answer, from source ${citation.marker}: ${citation.reference}, ${citation.sourceTitle}`}
      style={(state) => [
        styles.pill,
        {
          // Outlined, not filled: a hairline ring drawn on the bare
          // paper. Visibly a control, but the opposite material to the
          // reader's own messages — their words are a solid card, the
          // sources are engraved into the page. Pressing inks the ring in.
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
      {/* Two lines at most, whatever the source carries. */}
      <Text style={styles.pillText} numberOfLines={2} ellipsizeMode="tail">
        <Text style={[styles.marker, { color: colors.accent }]}>
          {toSuperscript(citation.marker)}
        </Text>
        <Text style={[styles.reference, { color: colors.secondaryForeground }]}>
          {' '}
          {label.reference}
        </Text>
        {label.detail && (
          <Text
            style={[
              styles.detail,
              { color: withAlpha(colors.secondaryForeground, 0.6) },
            ]}
          >
            {' · '}
            {label.detail}
          </Text>
        )}
      </Text>
    </PressableScale>
  );
}

const styles = StyleSheet.create({
  group: {
    alignSelf: 'stretch',
    gap: 6,
  },
  // Set like the folio's own kind label: case and tracking say "label".
  heading: {
    fontSize: 10.5,
    fontFamily: fonts.displayMedium,
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  // Holds the fold. The pills' own rings sit inside their boxes, so a
  // clip at the top of a row cuts nothing that is still showing.
  clip: {
    overflow: 'hidden',
  },
  // Pills flow side by side and wrap; a long one takes a row to itself.
  row: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'flex-start',
    gap: PILL_GAP,
  },
  // A comfortable thumb target that also *looks* like one: an outlined
  // pill, never under 44pt, hugging its reference so long ones wrap
  // onto a second line, and truncate past that.
  pill: {
    maxWidth: '100%',
    minHeight: PILL_MIN_HEIGHT,
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
  pillText: {
    fontSize: 13,
    lineHeight: 19.5,
  },
  marker: {
    fontFamily: fonts.proseSemiBold,
  },
  reference: {
    fontFamily: fonts.proseMedium,
  },
  detail: {
    fontFamily: fonts.proseItalic,
  },
  // Set as a line of the page, like the folio's way out to the book:
  // muted ink over a brass rule, not a button laid on the paper.
  toggle: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: 4,
    marginTop: 2,
    paddingVertical: 2,
    cursor: 'pointer',
  },
  toggleText: {
    fontSize: 13,
    fontFamily: fonts.proseMedium,
    textDecorationLine: 'underline',
  },
});
