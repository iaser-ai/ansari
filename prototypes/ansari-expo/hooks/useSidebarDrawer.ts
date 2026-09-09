import { useState, useSyncExternalStore } from 'react';
import {
  makeMutable,
  ReduceMotion,
  runOnJS,
  useAnimatedReaction,
  withSpring,
  type SharedValue,
} from 'react-native-reanimated';
import { SPRING } from '@/constants/motion';

/**
 * Whether the rail is showing as a drawer, and how far through that
 * move it is.
 *
 * A desktop keeps the rail standing beside the page, so it needs no
 * open state at all — only a collapsed one, which is
 * `useSidebarCollapsed`. A phone has no room to stand it beside
 * anything, so the same rail arrives over the page and leaves again,
 * and something has to remember whether it is there.
 *
 * A module store rather than a provider, for the same reason the
 * collapse is one: the rail is mounted by the root layout and opened by
 * a button inside a screen, and those two are on opposite sides of the
 * navigator. It also means the drawer does not spring open again when a
 * question is opened from inside it.
 */
let open = false;
const listeners = new Set<() => void>();

/**
 * 0 fully closed, 1 fully open. The scrim's ink and the panel's travel
 * both read from this one value, so the page cannot darken a frame
 * before or after the rail slides.
 */
const progress = makeMutable(0);

/**
 * A panel arriving over the page, so it takes the sheet's spring —
 * enough give at the end of the travel to read as a thing coming to
 * rest, and quick, because it is the way to everything else.
 */
const DRAWER_GLIDE = {
  ...SPRING.sheet,
  reduceMotion: ReduceMotion.System,
} as const;

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

const getSnapshot = () => open;

export function setSidebarDrawer(next: boolean) {
  if (next === open) return;
  open = next;
  progress.set(withSpring(next ? 1 : 0, DRAWER_GLIDE));
  for (const listener of listeners) listener();
}

export const openSidebarDrawer = () => setSidebarDrawer(true);
export const closeSidebarDrawer = () => setSidebarDrawer(false);

/**
 * The drawer under a finger, dragged in from the edge of the page.
 *
 * `settleSidebarDrawer` is not `setSidebarDrawer`: the boolean guard
 * above is right for a button — pressing "menu" twice must not restart
 * the glide — but wrong here, because a swipe abandoned halfway leaves
 * the boolean where it was and the progress somewhere in the middle. It
 * always springs, and it carries the finger's own speed into the spring
 * so there is no seam where the gesture ends and the animation begins.
 */
export function settleSidebarDrawer(next: boolean, velocity: number) {
  const changed = next !== open;
  open = next;
  progress.set(withSpring(next ? 1 : 0, { ...DRAWER_GLIDE, velocity }));
  if (changed) for (const listener of listeners) listener();
}

/** The panel's live position while a finger is on it. */
export function dragSidebarDrawer() {
  return progress;
}

/** Whether the drawer is being asked for — what a control reads. */
export function useSidebarDrawer() {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** The move itself, for whatever is drawn from it. */
export function useSidebarDrawerProgress(): SharedValue<number> {
  return progress;
}

/**
 * Whether the drawer is on the screen at all — open, or still on its
 * way out.
 *
 * This is the mounting question, and it is deliberately not the boolean
 * above: unmounting the moment the drawer is dismissed would take the
 * rail off the screen before it had finished leaving. Closed and
 * settled, nothing is mounted, so a phone that never opens the menu
 * never pays for the list inside it.
 */
export function useSidebarDrawerDrawn() {
  const asked = useSidebarDrawer();
  const [lit, setLit] = useState(() => progress.get() > 0);
  useAnimatedReaction(
    () => progress.get() > 0,
    (next, previous) => {
      if (previous !== null && next === previous) return;
      runOnJS(setLit)(next);
    },
  );
  return asked || lit;
}
