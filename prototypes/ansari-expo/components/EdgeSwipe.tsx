import React, { useMemo } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { type SharedValue } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';
import { EDGE_SWIPE } from '@/constants/motion';
import { tapHaptic } from '@/lib/haptics';

/**
 * A swipe in from the left edge of the screen.
 *
 * The one gesture every phone reader already has in their hands, and
 * the app had none of it: a thread could only be left through the rail,
 * and the rail could only be reached through a button. This is the
 * vocabulary, not a shortcut — the same swipe means "back" out of a
 * thread and "here is the rail" on the home page, because in both cases
 * it is the page in front stepping aside.
 *
 * What makes it feel like a gesture rather than a hidden button is that
 * the finger drives it. The caller hands in a shared value; this writes
 * the reader's progress into it, 0 to 1, and the caller draws whatever
 * moves from that. Letting go is the caller's decision too — `onSettle`
 * says whether the swipe carried, and the caller springs the value home
 * with the release velocity it is given, so there is no seam between
 * the finger and the animation that finishes the move. Abandon it
 * halfway and it goes back where it came from.
 *
 * The gesture's activation area is a strip along the edge, so it never
 * competes with a horizontal scroller, a slider, or a press anywhere
 * else on the page — and children are laid out and touched exactly as
 * they would be without it. The web renders the children and nothing
 * else: a pointer has the rail standing beside the page and the
 * browser's own back button, and a mouse dragged from the window edge
 * is not a gesture anyone makes.
 */
export function EdgeSwipe({
  progress,
  span,
  onSettle,
  enabled = true,
  children,
}: {
  /** Written 0 (closed) to 1 (open) as the finger travels. */
  progress: SharedValue<number>;
  /** The travel, in points, that counts as all the way. */
  span: number;
  /**
   * The finger let go. `velocity` is in progress-per-second, ready to
   * be handed straight to a spring on the same value.
   */
  onSettle: (committed: boolean, velocity: number) => void;
  enabled?: boolean;
  children: React.ReactNode;
}) {
  const live = enabled && Platform.OS !== 'web' && span > 0;

  const pan = useMemo(
    () =>
      Gesture.Pan()
        .enabled(live)
        // The strip. Not a view laid over the edge — that would swallow
        // touches meant for whatever is under it — but the gesture's
        // own activation area, which leaves the page's own hit testing
        // untouched.
        .hitSlop({ left: 0, width: EDGE_SWIPE.zone })
        // Rightwards only, and only once it means it. A vertical drag
        // that begins at the edge belongs to the list behind.
        .activeOffsetX(EDGE_SWIPE.slop)
        .failOffsetY([-EDGE_SWIPE.slop, EDGE_SWIPE.slop])
        .onUpdate((event) => {
          progress.set(Math.min(1, Math.max(0, event.translationX / span)));
        })
        .onEnd((event, success) => {
          const committed =
            success &&
            (progress.get() > EDGE_SWIPE.travel ||
              event.velocityX > EDGE_SWIPE.flick);
          // The tap on the hand belongs to the moment the decision is
          // made, not to the moment the animation lands.
          if (committed) scheduleOnRN(tapHaptic);
          scheduleOnRN(onSettle, committed, event.velocityX / span);
        }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [live, span, onSettle],
  );

  if (Platform.OS === 'web') return <>{children}</>;

  return (
    <GestureDetector gesture={pan}>
      <View style={styles.fill} collapsable={false}>
        {children}
      </View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  fill: {
    flex: 1,
  },
});
