import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ScrollView,
  StyleSheet,
  View,
  type LayoutChangeEvent,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import Animated, {
  ReduceMotion,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withSequence,
  withTiming,
} from 'react-native-reanimated';
import { useColors } from '@/hooks/useColors';
import { withAlpha } from '@/lib/color';
import { ANCHOR_HOLD, DURATION, EASE_OUT } from '@/constants/motion';
import { SourceFolio } from '@/components/SourceFolio';
import type { Citation } from '@/lib/api';
import { RADIUS, rounded } from '@/constants/radius';

/**
 * How much of the last note stays on screen when it is anchored at the
 * top of the column: enough that the run-out below it reads as the foot
 * of the page rather than as an empty panel.
 */
const STACK_RUN_OUT_TRIM = 40;

/**
 * The shadow under one leaf: a tight contact shadow where the paper
 * meets the panel, and the soft cast that lifts it.
 *
 * Kept as numbers rather than a finished string because the air around
 * a card is measured off them. A CSS blur radius spreads half its
 * length outside the box, so a card needs `reach` clear on each side —
 * anything narrower and the shadow is sheared off flat instead of
 * fading out.
 */
const CONTACT = { y: 1, blur: 2 };
const CAST = { y: 6, blur: 18 };

/** How far the shadow reaches past the card on each side. */
export const LEAF_SHADOW_REACH = {
  side: CAST.blur / 2,
  above: CAST.blur / 2 - CAST.y,
  below: CAST.y + CAST.blur / 2,
} as const;

/**
 * An answer's whole apparatus, in marker order, read as one column.
 *
 * Each source is its own leaf: a sheet of the palest paper in the app,
 * laid on the panel's frosted glass with a hairline rim and a soft
 * shadow under it, with air between one sheet and the next. It was a
 * hairline rule across a single sheet, the way a book divides two notes
 * at the foot of a page — but a book's notes are four lines long, and
 * these are whole folios with Arabic and a translation in them. At that
 * size the rule stopped dividing anything and the column read as one
 * unbroken wall of type, so the leaves came apart.
 *
 * The reader arrives here from a particular mark in the answer, so the
 * stack opens on that source and says so, briefly: the page it lands on
 * is washed in the folio's own brass and carries a rule down its
 * leading edge, both of which fade out once they have been seen. A
 * quiet mark rather than a persistent selection, because the reader
 * already knows which mark they touched — this only has to confirm that
 * the panel heard them.
 */
export function SourceStack({
  citations,
  anchorMarker,
  anchorKey,
  style,
  contentStyle,
  runOutTail = true,
}: {
  /** The message's sources, already ordered by marker. */
  citations: Citation[];
  /** Which source the reader touched. */
  anchorMarker: number;
  /**
   * Bumped every time the reader asks for a source — including the same
   * one twice, and including a mark in an answer whose stack is already
   * open. It is the request, not the marker, that moves the column.
   */
  anchorKey: number;
  style?: StyleProp<ViewStyle>;
  contentStyle?: StyleProp<ViewStyle>;
  /**
   * Whether to lay blank paper after the last note.
   *
   * A column in a fixed viewport needs it, or the scroll runs out
   * before the last source can reach the top. A column in a sheet that
   * is sized by its own contents must not have it: the run-out is
   * measured from the viewport, the viewport is the content, and the
   * two would inflate each other until a two-source sheet filled the
   * screen with blank paper.
   */
  runOutTail?: boolean;
}) {
  const colors = useColors();
  const reduced = useReducedMotion();
  const scrollRef = useRef<ScrollView>(null);
  /** Where each source begins in the column, as the cards report it. */
  const offsets = useRef(new Map<number, number>());
  /** A source asked for before its card had been laid out. */
  const pending = useRef<number | null>(null);
  /**
   * The column and its last note, measured. Without a run-out of blank
   * paper after the last note, the scroll runs out first and the last
   * source can never reach the top — the reader taps the fourth mark
   * and the column stops short of it. The run-out is exactly the
   * shortfall, so it is nothing at all when the stack is long.
   */
  const [viewport, setViewport] = useState(0);
  const [lastHeight, setLastHeight] = useState(0);
  const runOut = runOutTail
    ? Math.max(0, viewport - lastHeight - STACK_RUN_OUT_TRIM)
    : 0;

  const bringIntoView = useCallback(
    (marker: number) => {
      const y = offsets.current.get(marker);
      if (y === undefined) {
        // Asked for on the frame the stack mounted: the cards have not
        // reported their positions yet, so the request waits for the
        // one that will answer it.
        pending.current = marker;
        return;
      }
      pending.current = null;
      scrollRef.current?.scrollTo({ y, animated: !reduced });
    },
    [reduced],
  );

  useEffect(() => {
    bringIntoView(anchorMarker);
    // The request is the trigger, not the marker: tapping the same mark
    // again has to bring the column back to it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchorKey]);

  const onSlotLayout =
    (marker: number, last: boolean) => (event: LayoutChangeEvent) => {
      const { y, height } = event.nativeEvent.layout;
      offsets.current.set(marker, y);
      if (last) setLastHeight(height);
      if (pending.current === marker) bringIntoView(marker);
    };

  return (
    <ScrollView
      ref={scrollRef}
      style={style}
      contentContainerStyle={contentStyle}
      showsVerticalScrollIndicator={false}
      onLayout={(event) => setViewport(event.nativeEvent.layout.height)}
      testID="source-stack"
    >
      {citations.map((citation, index) => (
        <View
          key={citation.id}
          onLayout={onSlotLayout(
            citation.marker,
            index === citations.length - 1,
          )}
          style={index > 0 ? styles.spaced : null}
        >
          <AnchorMark
            lit={citation.marker === anchorMarker}
            anchorKey={anchorKey}
            reduced={reduced}
            tint={withAlpha(colors.accent, 0.14)}
            edge={colors.accent}
            surface={{
              backgroundColor: colors.panelPaper,
              borderColor: colors.panelPaperRim,
              boxShadow:
                `0 ${CONTACT.y}px ${CONTACT.blur}px ${colors.shadowTintSoft}, ` +
                `0 ${CAST.y}px ${CAST.blur}px ${colors.shadowTint}`,
            }}
          >
            <SourceFolio citation={citation} />
          </AnchorMark>
        </View>
      ))}
      {runOut > 0 && <View style={{ height: runOut }} />}
    </ScrollView>
  );
}

/**
 * One leaf of the stack, and the "this is the one you asked for" mark
 * on it: a brass wash and a rule down the leading edge, brought up
 * quickly, held long enough to be seen after the column has finished
 * travelling, and taken away again.
 *
 * The wash is clipped to the sheet rather than bled past it, now that
 * the sheet has an edge of its own to be clipped to — but the clip
 * lives on a layer of its own inside the leaf rather than on the leaf.
 * A surface that masks to its own bounds cannot cast anything outside
 * them, and the leaf is the surface carrying the shadow: put the two on
 * one view and the platforms that honour the mask amputate the shadow
 * at the rim. So the leaf owns the paper, the rim, the corner and the
 * shadow, and an inner layer inset into it owns the corner again, for
 * the one child that has to be held inside it.
 *
 * With reduced motion on, `ReduceMotion.System` collapses both ends to
 * nothing — the mark appears, holds and goes, without the fades. The
 * hold is what carries the information, so it must survive.
 */
function AnchorMark({
  lit,
  anchorKey,
  reduced,
  tint,
  edge,
  surface,
  children,
}: {
  lit: boolean;
  anchorKey: number;
  reduced: boolean;
  tint: string;
  edge: string;
  /** The paper this leaf is printed on, from the palette. */
  surface: ViewStyle;
  children: React.ReactNode;
}) {
  const ink = useSharedValue(0);

  useEffect(() => {
    if (!lit) {
      ink.set(0);
      return;
    }
    ink.set(
      withSequence(
        withTiming(1, {
          duration: DURATION.state,
          easing: EASE_OUT,
          reduceMotion: ReduceMotion.System,
        }),
        withDelay(
          ANCHOR_HOLD,
          withTiming(0, {
            duration: DURATION.enter,
            easing: EASE_OUT,
            reduceMotion: ReduceMotion.System,
          }),
        ),
      ),
    );
    // Re-marked on every request, so a second tap on the same mark is
    // answered even though nothing about this card changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lit, anchorKey, reduced]);

  const markStyle = useAnimatedStyle(() => ({ opacity: ink.get() }));

  return (
    <View style={[styles.leaf, surface]}>
      <View pointerEvents="none" style={styles.clip}>
        <Animated.View
          style={[
            styles.mark,
            { backgroundColor: tint, borderLeftColor: edge },
            markStyle,
          ]}
        />
      </View>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  // The air between two leaves, and the whole of the shadow's downward
  // reach with a little to spare. The next leaf is opaque paper painted
  // after this one, so anything narrower and it lands on the shadow and
  // slices it off in a straight line. Still one column: five points of
  // clear panel is a gap, not a scattering.
  spaced: {
    marginTop: LEAF_SHADOW_REACH.below + 5,
  },
  // The leaf casts; it does not clip.
  leaf: {
    ...rounded(RADIUS.lg),
    borderWidth: StyleSheet.hairlineWidth,
    paddingVertical: 18,
    paddingHorizontal: 18,
  },
  // ...and this does the clipping, inset into the leaf exactly where
  // the leaf's own mask used to fall — inside the rim, on the curve the
  // rim encloses.
  clip: {
    ...StyleSheet.absoluteFillObject,
    ...rounded(RADIUS.lg - StyleSheet.hairlineWidth),
    overflow: 'hidden',
  },
  mark: {
    ...StyleSheet.absoluteFillObject,
    borderLeftWidth: 2,
  },
});
