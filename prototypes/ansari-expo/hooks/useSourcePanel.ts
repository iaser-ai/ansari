import { useState } from 'react';
import { Platform, useWindowDimensions } from 'react-native';
import {
  makeMutable,
  ReduceMotion,
  runOnJS,
  useAnimatedReaction,
  useAnimatedStyle,
  withSpring,
  type SharedValue,
} from 'react-native-reanimated';
import { SOURCE_PANEL_MIN_WIDTH, SOURCE_PANEL_WIDTH } from '@/constants/layout';
import { SPRING } from '@/constants/motion';

/**
 * Whether an answer's sources present as a panel beside the reading
 * column, or as a full-height sheet over it.
 *
 * It is a question about the window, not about the platform: a desktop
 * browser dragged narrow has no more room than a phone, and a panel
 * that squeezes the answer into a gutter defeats the whole reason for
 * putting the sources beside it. Native is phone-only, so it always
 * takes the sheet.
 */
export function useSourcePanelPresentation(): boolean {
  const { width } = useWindowDimensions();
  return Platform.OS === 'web' && width >= SOURCE_PANEL_MIN_WIDTH;
}

/**
 * How far the sources panel is out: 0 fully away, 1 fully open.
 *
 * A module value for the same reason the rail's is. The panel takes the
 * right edge of the *window*, not of the thread — the account links in
 * the top corner are mounted by the root layout and have to move off
 * that edge too — so the one number every affected surface reads has to
 * outlive the screen that opens it.
 */
const progress = makeMutable(0);

/**
 * The panel's own glide, the same one the rail travels on: this is the
 * furniture of the screen rearranging itself — the reading column moves
 * with it — rather than a control answering a touch, so it is
 * deliberately slower than the interface ceiling and critically damped,
 * which also lets a close be reversed mid-flight from wherever it is.
 */
const PANEL_GLIDE = {
  ...SPRING.glide,
  reduceMotion: ReduceMotion.System,
} as const;

/**
 * Open or close the panel's travel. Called from an effect, never from
 * render, and called with `false` when the thread unmounts — the value
 * outlives the screen, and a page that never gets the edge back would
 * be left permanently indented.
 */
export function setSourcePanelOpen(open: boolean) {
  progress.set(withSpring(open ? 1 : 0, PANEL_GLIDE));
}

/** The panel's travel, for whatever draws itself against it. */
export function useSourcePanelProgress(): SharedValue<number> {
  return progress;
}

/** How far the page holds its content clear of the panel. */
export function useSourcePanelInset() {
  return useAnimatedStyle(() => ({
    paddingRight: SOURCE_PANEL_WIDTH * progress.get(),
  }));
}

/**
 * The same edge, for chrome pinned to the right corner rather than
 * padded clear of it: it travels on the same frames as the page.
 */
export function useSourcePanelEdge(base: number) {
  return useAnimatedStyle(() => ({
    right: base + SOURCE_PANEL_WIDTH * progress.get(),
  }));
}

/** The panel's own travel: fully off the right edge at rest. */
export function useSourcePanelSlide() {
  return useAnimatedStyle(() => ({
    transform: [{ translateX: SOURCE_PANEL_WIDTH * (1 - progress.get()) }],
  }));
}

/**
 * What is drawn (`lit`) and what has arrived (`live`), read off the
 * progress rather than off the state the panel is heading for. A panel
 * with any travel left stays in the tree whichever way it is going; a
 * panel that has not fully arrived is not a place to click, not read
 * out, and not a tab stop.
 */
export type SourcePanelPhase = { lit: boolean; live: boolean };

const ARRIVED = 0.999;

export function sourcePanelPhaseAt(p: number): SourcePanelPhase {
  'worklet';
  return { lit: p > 0.001, live: p >= ARRIVED };
}

export function useSourcePanelPhase(): SourcePanelPhase {
  const [phase, setPhase] = useState<SourcePanelPhase>(() =>
    sourcePanelPhaseAt(progress.get()),
  );

  useAnimatedReaction(
    () => sourcePanelPhaseAt(progress.get()),
    (next, previous) => {
      if (
        previous &&
        next.lit === previous.lit &&
        next.live === previous.live
      ) {
        return;
      }
      runOnJS(setPhase)(next);
    },
  );

  return phase;
}
