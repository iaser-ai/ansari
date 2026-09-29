import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';
import { useColors } from '@/hooks/useColors';
import { fonts } from '@/constants/colors';
import { ROW_REVEAL, SPRING, rubberband } from '@/constants/motion';
import { tickHaptic } from '@/lib/haptics';
import { PressableScale } from '@/components/PressableScale';
import { RADIUS, rounded } from '@/constants/radius';

/** How much of the row the action takes when it is showing. */
const ACTION_WIDTH = 84;

/**
 * A row that slides aside to show what can be done to it.
 *
 * The action travels *with* the row rather than being uncovered from
 * underneath: it is parked just past the right edge and the pair move
 * together, which is why nothing here needs an opaque backing to hide
 * behind. The rail is frosted glass over the page, and a row painted
 * solid to mask a button beneath it would show as a bar of paint.
 *
 * The gesture is not the only way in, and is not allowed to become one.
 * A swipe is invisible; the row keeps the control that can be seen, and
 * both open the same confirmation. This is the third way to the same
 * action, for the readers who reach for it first.
 *
 * Which row is open is the list's business, not the row's — two rows
 * open at once is a list that has come apart — so the caller holds it
 * and hands it back down.
 */
export function SwipeToReveal({
  enabled,
  open,
  onOpenChange,
  action,
  children,
}: {
  enabled: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  action: {
    label: string;
    accessibilityLabel: string;
    onPress: () => void;
  };
  children: React.ReactNode;
}) {
  const colors = useColors();
  /** How far the row has been carried, in points. Negative is leftwards. */
  const x = useSharedValue(0);
  /** Where the row was when the finger landed, so a re-grab continues. */
  const grabbedAt = useSharedValue(0);
  /** The last resting place this row was sent to, open or closed. */
  const settled = useRef(false);

  const spring = { ...SPRING.snap, reduceMotion: ReduceMotion.System };

  // Somebody else closed this row — another one opened, or the list
  // navigated away. The gesture springs itself, and tells the caller
  // through `commit` below, so this only ever answers a change the row
  // did not make.
  useEffect(() => {
    if (settled.current === open) return;
    settled.current = open;
    x.set(withSpring(open ? -ACTION_WIDTH : 0, spring));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // The gesture is built once and left alone. A row lives in a list
  // whose `renderItem` hands down a fresh callback on every render, and
  // rebuilding every row's gesture each time is a lot of churn for a
  // function that does the same thing — so the gesture calls this, and
  // this reads whatever the latest render passed in.
  const latest = useRef(onOpenChange);
  latest.current = onOpenChange;
  const commit = useCallback((next: boolean) => {
    settled.current = next;
    // A reveal is a thing shown, not a thing decided: the quiet tick,
    // not the tap that a real commitment gets.
    if (next) tickHaptic();
    latest.current(next);
  }, []);

  const pan = useMemo(
    () =>
      Gesture.Pan()
        .enabled(enabled)
        // Sideways intent only: the list behind scrolls, and a thumb
        // dragging up the rail must not peel rows open on the way.
        .activeOffsetX([-12, 12])
        .failOffsetY([-14, 14])
        .onStart(() => {
          grabbedAt.set(x.get());
        })
        .onUpdate((event) => {
          const next = grabbedAt.get() + event.translationX;
          // Free between home and the action's width; resisting at
          // both ends, because a row has nothing further to show.
          x.set(
            next > 0
              ? rubberband(next, ACTION_WIDTH)
              : next < -ACTION_WIDTH
                ? -ACTION_WIDTH + rubberband(next + ACTION_WIDTH, ACTION_WIDTH)
                : next,
          );
        })
        .onEnd((event, success) => {
          const opened =
            success &&
            (-x.get() > ACTION_WIDTH * ROW_REVEAL.travel ||
              -event.velocityX > ROW_REVEAL.flick);
          x.set(
            withSpring(opened ? -ACTION_WIDTH : 0, {
              ...spring,
              velocity: event.velocityX,
            }),
          );
          scheduleOnRN(commit, opened);
        }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [enabled],
  );

  const rowStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: x.get() }],
  }));

  if (!enabled) return <>{children}</>;

  return (
    <View style={styles.clip}>
      <GestureDetector gesture={pan}>
        <Animated.View style={rowStyle}>
          {children}
          <View
            style={styles.actionSlot}
            pointerEvents={open ? 'auto' : 'none'}
          >
            <PressableScale
              onPress={action.onPress}
              accessibilityRole="button"
              accessibilityLabel={action.accessibilityLabel}
              style={(state) => [
                styles.action,
                {
                  backgroundColor: colors.destructive,
                  opacity: state.pressed ? 0.78 : 1,
                },
              ]}
            >
              <Feather
                name="trash-2"
                size={15}
                color={colors.destructiveForeground}
              />
              <Text
                style={[
                  styles.actionText,
                  { color: colors.destructiveForeground },
                ]}
              >
                {action.label}
              </Text>
            </PressableScale>
          </View>
        </Animated.View>
      </GestureDetector>
    </View>
  );
}

const styles = StyleSheet.create({
  // The row leaves on one side and the action arrives from the other;
  // neither is allowed to draw outside the row's own line.
  clip: {
    overflow: 'hidden',
  },
  // Parked just past the right edge, travelling with the row.
  actionSlot: {
    position: 'absolute',
    left: '100%',
    top: 0,
    bottom: 0,
    width: ACTION_WIDTH,
    paddingLeft: 6,
    paddingVertical: 1,
  },
  action: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 3,
    ...rounded(RADIUS.sm),
    cursor: Platform.OS === 'web' ? 'pointer' : undefined,
  },
  actionText: {
    fontSize: 11,
    fontFamily: fonts.bodySemiBold,
  },
});
