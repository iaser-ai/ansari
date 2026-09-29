import { useState, useSyncExternalStore } from 'react';
import {
  Extrapolation,
  interpolate,
  makeMutable,
  ReduceMotion,
  runOnJS,
  useAnimatedReaction,
  useAnimatedStyle,
  withSpring,
  type SharedValue,
} from 'react-native-reanimated';
import { SIDEBAR_COLLAPSED_WIDTH, SIDEBAR_WIDTH } from '@/constants/layout';
import { SPRING } from '@/constants/motion';

/**
 * Whether the desktop rail is collapsed to its slim strip, and how far
 * through that move it currently is.
 *
 * The rail is mounted separately by the ask and by the thread, and both
 * screens also have to inset their own content by whatever width it is
 * currently taking. A module store keeps all of those in step without
 * threading state through a provider — and, because it outlives
 * navigation, the rail does not spring back open the moment a question
 * is opened.
 *
 * Two readings come out of it. The boolean says which state the rail is
 * heading for, and is all the branches that only decide *what to render*
 * need. The progress below is the one the eye follows.
 */
let collapsed = false;
const listeners = new Set<() => void>();

/**
 * The single value the whole move is drawn from: 0 fully open, 1 fully
 * collapsed, and every frame in between shared by the rail's width, the
 * screens' left inset and the mark's rotation. One value rather than
 * three animations, because three cannot be relied on to agree — and a
 * mark that finishes turning a frame after the rail stops is exactly
 * the glitch this replaces.
 */
const progress = makeMutable(0);

/**
 * A spring rather than a curve, because the toggle can be pressed again
 * mid-flight: a spring picks the move up from wherever it is and
 * carries its velocity into the reversal, where a timing would restart
 * its curve from a standstill and stutter. Critically damped, so it can
 * never overshoot 1 and carry the mark past a full turn — and so the
 * whole move decelerates into its resting place rather than stopping at
 * it, which is most of what makes a glide read as a glide.
 */
const RAIL_GLIDE = {
  ...SPRING.glide,
  reduceMotion: ReduceMotion.System,
} as const;

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

const getSnapshot = () => collapsed;

export function setSidebarCollapsed(next: boolean) {
  if (next === collapsed) return;
  collapsed = next;
  progress.set(withSpring(next ? 1 : 0, RAIL_GLIDE));
  for (const listener of listeners) listener();
}

export function useSidebarCollapsed() {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** The rail's own animated collapse progress, for whatever draws it. */
export function useSidebarProgress(): SharedValue<number> {
  return progress;
}

/**
 * The rail's width at a given progress. Written once and used both by
 * the rail itself and by the inset below, so the edge the reader
 * watches and the edge the page is pushed off can not drift apart.
 */
export function sidebarWidthAt(p: number) {
  'worklet';
  return interpolate(p, [0, 1], [SIDEBAR_WIDTH, SIDEBAR_COLLAPSED_WIDTH]);
}

/**
 * How far a screen must hold its content clear of the rail. The ask and
 * the thread both apply this, so the hand-off between them lands the
 * reading column in the same place — and so the page slides with the
 * rail's edge rather than jumping once it has arrived.
 */
export function useSidebarInset() {
  return useAnimatedStyle(() => ({
    paddingLeft: sidebarWidthAt(progress.get()),
  }));
}

/**
 * The same edge, for the floating chrome that is positioned against the
 * rail rather than padded clear of it — it has to travel on the same
 * frames as the page behind it.
 */
export function useSidebarEdge() {
  return useAnimatedStyle(() => ({
    left: sidebarWidthAt(progress.get()),
  }));
}

/**
 * How much ink each of the rail's two cross-fading layers has at a
 * given progress. They hand over rather than dissolve through each
 * other: the wide column is gone before the strip's controls arrive,
 * so between the two ramps neither is drawn, by design.
 */
export function wideInkAt(p: number) {
  'worklet';
  return interpolate(p, [0, 0.42], [1, 0], Extrapolation.CLAMP);
}

export function narrowInkAt(p: number) {
  'worklet';
  return interpolate(p, [0.58, 1], [0, 1], Extrapolation.CLAMP);
}

/**
 * Which of the two layers is drawn (`lit`) and which has fully arrived
 * (`live`) — the only description of what is actually on screen, so
 * that what mounts, what takes a click and what a screen reader may
 * reach cannot disagree with what the eye is being shown.
 *
 * Drawn is the mounting question: a layer with any ink left has to stay
 * in the tree, whichever direction the move is going. Reading the state
 * the rail is *heading for* instead would unmount a half-faded layer in
 * the same frame a reversal made it start coming back.
 *
 * Arrived is the interaction question, and it is deliberately stricter:
 * mid-glide neither layer is a place to click or a thing to read out.
 * The margin below is for the float the spring lands on, not for a
 * range of "nearly there" a reader would notice.
 */
export type SidebarPhase = {
  wideLit: boolean;
  wideLive: boolean;
  narrowLit: boolean;
  narrowLive: boolean;
};

const ARRIVED = 0.999;

export function sidebarPhaseAt(p: number): SidebarPhase {
  'worklet';
  const wide = wideInkAt(p);
  const narrow = narrowInkAt(p);
  return {
    wideLit: wide > 0,
    wideLive: wide >= ARRIVED,
    narrowLit: narrow > 0,
    narrowLive: narrow >= ARRIVED,
  };
}

function samePhase(a: SidebarPhase, b: SidebarPhase) {
  'worklet';
  return (
    a.wideLit === b.wideLit &&
    a.wideLive === b.wideLive &&
    a.narrowLit === b.narrowLit &&
    a.narrowLive === b.narrowLive
  );
}

/**
 * The phase as React state, so the rail can mount and unmount against
 * it. Recomputed on the frames the progress actually moves, and pushed
 * across only when one of the four answers changes — the glide is
 * hundreds of frames and four booleans of it.
 */
export function useSidebarPhase(): SidebarPhase {
  const [phase, setPhase] = useState<SidebarPhase>(() =>
    sidebarPhaseAt(progress.get()),
  );
  useAnimatedReaction(
    () => sidebarPhaseAt(progress.get()),
    (next, previous) => {
      if (previous && samePhase(next, previous)) return;
      runOnJS(setPhase)(next);
    },
  );
  return phase;
}
