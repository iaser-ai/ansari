import React, { useEffect, useState } from 'react';
import { Platform, StyleSheet, Text, View, type ViewStyle } from 'react-native';
import { Feather } from '@expo/vector-icons';
import Animated from 'react-native-reanimated';
import { useColors } from '@/hooks/useColors';
import { useOverlayFocus } from '@/hooks/useOverlayFocus';
import { announce } from '@/lib/announce';
import {
  useSourcePanelPhase,
  useSourcePanelPresentation,
  useSourcePanelSlide,
} from '@/hooks/useSourcePanel';
import { fonts } from '@/constants/colors';
import { SOURCE_PANEL_WIDTH } from '@/constants/layout';
import { withAlpha } from '@/lib/color';
import { isHovered } from '@/lib/web';
import { PressableScale } from '@/components/PressableScale';
import { Sheet } from '@/components/Sheet';
import { LEAF_SHADOW_REACH, SourceStack } from '@/components/SourceStack';
import type { Citation } from '@/lib/api';
import { RADIUS, rounded } from '@/constants/radius';

/**
 * A reader asking to see a source. Not the source they touched — the
 * whole apparatus of the answer it belongs to, and which of its marks
 * the request came from.
 */
export type SourceRequest = {
  /** The answer the sources belong to. */
  messageId: string;
  /** Every source for that answer, in marker order. */
  citations: Citation[];
  /** The mark that was tapped. */
  marker: number;
  /** How the answer opens, so the panel can name whose sources it holds. */
  excerpt: string;
  /**
   * One per request. Tapping the same mark twice, or a second mark in
   * the same answer, is a new request even though the stack is
   * unchanged — the column has to travel either way.
   */
  requestKey: number;
};

/**
 * How far a source card sits in from the edge of whatever is holding
 * it. Both are wider than the shadow's sideways reach, which is the
 * whole point of them living in the scrolled content rather than on the
 * containers around it: the card keeps the inset it always had, and the
 * shadow now has clear ground on both sides to fade out over.
 *
 * The panel's is tighter than the header wants, because the sheets
 * inside carry their own margins of paper — the panel's gutter and the
 * leaf's padding are the same gutter twice over if both are generous.
 * The header therefore keeps its own, wider inset, and the rule under
 * it follows the header rather than the cards.
 */
const PANEL_GUTTER = Math.max(14, LEAF_SHADOW_REACH.side);
const PANEL_HEADER_GUTTER = PANEL_GUTTER + 8;
/** The sheet's, matching the horizontal padding every other sheet has. */
const SHEET_GUTTER = Math.max(20, LEAF_SHADOW_REACH.side);

/**
 * How an answer opens, in plain words — the panel's running head, and
 * the only way a reader who cannot see the page is told whose sources
 * they have been given. The answer's Markdown furniture and its own
 * source marks are stripped: they are notation for the page, and read
 * out loud they are noise.
 */
export function answerExcerpt(content: string): string {
  const plain = content
    .replace(/\[\d+\]/g, '')
    .replace(/[#*_`>~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (plain.length <= 56) return plain;
  // Cut at the last whole word, so the head does not end mid-syllable.
  const cut = plain.slice(0, 56);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > 32 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/**
 * An answer's sources, beside the answer or over it.
 *
 * Desktop keeps them beside: a panel along the right edge, built the way
 * the rail along the left edge is — absolutely positioned, sliding in on
 * one shared progress that the page's own inset is drawn from, so the
 * reading column moves out of the way rather than being covered, and the
 * answer stays there to be read against its evidence.
 *
 * A phone has no second column to give, so the same stack arrives as a
 * full-height sheet with the rise, the scrim and the drag every other
 * sheet in the app has. Narrow web takes the sheet too: a panel that
 * leaves the answer four words wide is worse than one that covers it.
 */
export function SourcePanel({
  request,
  onClose,
}: {
  request: SourceRequest | null;
  onClose: () => void;
}) {
  const colors = useColors();
  const asPanel = useSourcePanelPresentation();
  const slide = useSourcePanelSlide();
  const phase = useSourcePanelPhase();
  const open = request !== null;

  // Held past the parent clearing the request, so the panel still has
  // something to draw while it leaves.
  const [current, setCurrent] = useState<SourceRequest | null>(null);
  useEffect(() => {
    if (request) setCurrent(request);
  }, [request]);
  useEffect(() => {
    // The panel's own exit is the glide; the sheet's is its own, and it
    // says when it is finished through `onExited`.
    if (asPanel && !open && !phase.lit) setCurrent(null);
  }, [asPanel, phase.lit, open]);

  // Which answer's sources these are, said out loud — the panel opens
  // beside an answer the reader cannot see if they are not looking at
  // the page, and "sources" alone does not say whose.
  useEffect(() => {
    if (!request) return;
    const source = request.citations.find((c) => c.marker === request.marker);
    announce(
      `Sources for the answer beginning ${request.excerpt}. ` +
        `${request.citations.length} ${request.citations.length === 1 ? 'source' : 'sources'}, ` +
        `showing ${source?.reference ?? `source ${request.marker}`}.`,
    );
  }, [request]);

  // The panel presentation is a view lying on the page, so it owns the
  // whole focus lifecycle itself. The sheet presentation is a `Sheet`,
  // which already takes the same hook — asking for it twice would trap
  // focus in the panel's empty box while the sheet is the thing on
  // screen.
  const panelID = useOverlayFocus(asPanel && open, onClose);

  if (!current) return null;

  const count = current.citations.length;
  const label =
    `Sources for the answer beginning ${current.excerpt}: ` +
    `${count} ${count === 1 ? 'source' : 'sources'}`;

  const header = (
    <View
      style={[
        styles.header,
        asPanel ? styles.panelHeaderInset : styles.sheetHeaderInset,
      ]}
    >
      <View style={styles.headerText}>
        <Text style={[styles.title, { color: colors.strongForeground }]}>
          Sources
        </Text>
        <Text
          style={[styles.excerpt, { color: colors.mutedForeground }]}
          numberOfLines={2}
        >
          “{current.excerpt}”
        </Text>
      </View>
      <PressableScale
        onPress={onClose}
        hitSlop={8}
        style={(state) => [
          styles.closeButton,
          {
            backgroundColor: colors.lifted,
            opacity: state.pressed ? 0.6 : isHovered(state) ? 0.8 : 1,
          },
        ]}
        testID="sources-close"
        accessibilityRole="button"
        accessibilityLabel="Close sources"
      >
        <Feather name="x" size={17} color={colors.mutedForeground} />
      </PressableScale>
    </View>
  );

  const stack = (
    <SourceStack
      // A different answer is a different column: its cards' positions
      // have nothing to do with the last one's, so the stack starts
      // over rather than scrolling to a remembered offset.
      key={current.messageId}
      citations={current.citations}
      anchorMarker={current.marker}
      anchorKey={current.requestKey}
      // A panel is a full-height column and the stack fills it. A sheet
      // is sized by what is in it, so there the stack must ask for its
      // content's height and only give way once the sheet meets its
      // ceiling — `flex: 1` would have it ask for nothing at all and
      // the sheet would open as a bare header.
      style={asPanel ? styles.stack : styles.stackInSheet}
      runOutTail={asPanel}
      contentStyle={
        asPanel ? styles.panelStackContent : styles.sheetStackContent
      }
    />
  );

  if (!asPanel) {
    return (
      <Sheet
        open={open}
        onClose={onClose}
        onExited={() => setCurrent(null)}
        style={styles.sheet}
        dialogStyle={styles.dialogSheet}
        accessibilityViewIsModal
        accessibilityLabel={label}
        header={header}
      >
        {stack}
      </Sheet>
    );
  }

  // The rail's own material, on the other edge: frosted glass over the
  // paper rather than a panel cut out of it. On the web the
  // backdrop-filter has to sit on this wrapper — it is z-indexed, so a
  // child's filter would sample only what is painted inside that
  // stacking context, which is nothing.
  //
  // Thinner than the chrome glass, and tinted a step below the page
  // rather than towards white: this pane is a third of the window, and
  // at the chrome's opacity it read as a wall bolted to the edge. Held
  // under the paper, it reads as glass and lets the sheets on it be the
  // brightest thing in the column.
  const glass =
    Platform.OS === 'web'
      ? ({
          backdropFilter: `blur(26px) ${colors.glassFilter}`,
          WebkitBackdropFilter: `blur(26px) ${colors.glassFilter}`,
          backgroundColor: colors.panelWash,
          willChange: 'backdrop-filter',
          backfaceVisibility: 'hidden',
        } as unknown as ViewStyle)
      : { backgroundColor: withAlpha(colors.surface, 0.9) };

  return (
    <Animated.View
      style={[styles.panel, glass, { borderLeftColor: colors.glassRim }, slide]}
      nativeID={panelID}
      // Mid-glide the panel is not a place to click and not a thing to
      // read out; it is simply on its way.
      pointerEvents={phase.live ? 'auto' : 'none'}
      accessibilityElementsHidden={!phase.live}
      importantForAccessibility={phase.live ? 'auto' : 'no-hide-descendants'}
      accessibilityLabel={label}
      testID="sources-panel"
    >
      <View style={styles.panelInner}>
        {header}
        <View style={[styles.headRule, { backgroundColor: colors.border }]} />
        {stack}
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  // Absolute, like the rail, so the page reserves room for it with an
  // inset of exactly the same width rather than laying it out in flow.
  panel: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    right: 0,
    width: SOURCE_PANEL_WIDTH,
    zIndex: 30,
    borderLeftWidth: StyleSheet.hairlineWidth,
  },
  // No horizontal padding of its own: the column's gutter lives in the
  // scrolled content instead, so the scroll viewport runs the full
  // width of the panel and a card's shadow has panel either side of it
  // to fade out over rather than an edge to be sheared off at. The
  // header and the rule carry the gutter themselves, to the same inset
  // the cards below them keep.
  panelInner: {
    flex: 1,
    paddingTop: 22,
    paddingBottom: 18,
  },
  panelHeaderInset: {
    paddingHorizontal: PANEL_HEADER_GUTTER,
  },
  sheetHeaderInset: {
    paddingHorizontal: SHEET_GUTTER,
  },
  headRule: {
    height: StyleSheet.hairlineWidth,
    marginTop: 14,
    marginHorizontal: PANEL_HEADER_GUTTER,
  },
  // The phone presentation: a stack of folios is a thing to read down,
  // not a card. Sized by what is in it, not by a fraction of the glass:
  // an answer with one source opens a short sheet and an answer with
  // eight opens a tall one, and `Sheet`'s own ceiling stops either of
  // them running under the status bar. A fixed height made the short
  // case a mostly empty screen and told the reader nothing about how
  // much there was to read.
  sheet: {
    flexShrink: 1,
    // The sheet's own gutter is handed to the header and to the scrolled
    // content, so the scroll viewport reaches the sheet's edges and a
    // card's shadow is not cut off flat against them.
    paddingHorizontal: 0,
  },
  // A browser too narrow for the panel still has a desktop's pointer,
  // so the sheet arrives as this app's centered dialog — held to a
  // book's measure rather than stretched across the window.
  dialogSheet: {
    maxWidth: 520,
    height: '86%',
    paddingTop: 18,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
  },
  headerText: {
    flex: 1,
    gap: 2,
  },
  title: {
    fontSize: 19,
    fontFamily: fonts.display,
  },
  // The answer this apparatus belongs to, quoted the way a running head
  // quotes the page it sits above.
  excerpt: {
    fontSize: 12.5,
    lineHeight: 17,
    fontFamily: fonts.displayItalic,
  },
  closeButton: {
    width: 30,
    height: 30,
    ...rounded(RADIUS.pill),
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'pointer',
  },
  // A panel is a full-height column and the stack fills it. In a sheet
  // sized by its contents, `flex: 1` would give the stack a flex basis
  // of nothing, the sheet would measure to a bare header, and there
  // would be no height left for the growth to happen in — so there the
  // stack asks for its content's height and only gives way at the
  // ceiling.
  stack: {
    flex: 1,
  },
  stackInSheet: {
    flexShrink: 1,
    flexGrow: 0,
  },
  // The column's own margins. Every edge clears the shadow's reach in
  // that direction, so the first card is not cut at the top and neither
  // card is cut at the sides.
  panelStackContent: {
    paddingTop: Math.max(22, LEAF_SHADOW_REACH.above),
    paddingHorizontal: PANEL_GUTTER,
    paddingBottom: Math.max(40, LEAF_SHADOW_REACH.below),
  },
  sheetStackContent: {
    paddingTop: LEAF_SHADOW_REACH.above + 9,
    paddingHorizontal: SHEET_GUTTER,
    paddingBottom: Math.max(24, LEAF_SHADOW_REACH.below),
  },
});
