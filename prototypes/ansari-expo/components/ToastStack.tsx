import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import {
  Platform,
  StyleSheet,
  Text,
  View,
  type LayoutChangeEvent,
  type ViewStyle,
} from 'react-native';
import { Feather } from '@expo/vector-icons';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  Extrapolation,
  ReduceMotion,
  interpolate,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useColors } from '@/hooks/useColors';
import { useDesktop } from '@/hooks/useDesktop';
import { fonts } from '@/constants/colors';
import {
  DURATION,
  EASE_OUT,
  SHEET_DISMISS,
  SPRING,
  rubberband,
} from '@/constants/motion';
import { threadContentTop } from '@/constants/layout';
import { tapHaptic } from '@/lib/haptics';
import { isHovered } from '@/lib/web';
import { PressableScale } from '@/components/PressableScale';
import {
  dismissToast,
  getToasts,
  pauseToastTimers,
  resumeToastTimers,
  subscribeToToasts,
  type Toast,
} from '@/lib/toast';
import { RADIUS, rounded } from '@/constants/radius';

/**
 * The notice surface: one stack of transient notices, mounted once at
 * the app root, above every other piece of chrome.
 *
 * It hangs from the *top* edge on every platform, and that is the whole
 * placement argument. The bottom of a phone screen belongs to the
 * composer, which hugs the keyboard — a notice there is either behind
 * the keyboard, behind the composer, or shoving one of them about. The
 * top edge has exactly one occupant, the floating header bar (and the
 * ask screen's floating buttons, which sit at the same height), so the
 * stack begins just below it and never has to negotiate with anything
 * that moves. On desktop it takes the top-right corner, clear of the
 * account links above it and of the reading column below.
 *
 * The stack is drawn rather than laid out: every notice is absolutely
 * positioned and carries its own offset down from the top of the stack,
 * so a notice leaving in the middle lets the ones under it spring up
 * into the gap instead of the whole column jumping a row. The newest is
 * nearest the reader — first in the stack, full size, drawn over the
 * others, which recede a few percent as they age.
 */

/** Air between two notices in the stack. */
const GAP = 10;
/** How far above its resting place a notice starts. */
const ENTER_TRAVEL = 16;
/** Used for one frame, until the notice has measured itself. */
const ESTIMATED_HEIGHT = 62;
/** Travel that takes a dragged notice to nearly gone. */
const DISMISS_FADE = 120;
/** Each notice behind the newest recedes by this much. */
const DEPTH_SCALE = 0.03;
/** Where the desktop stack hangs: under the account links and the bar. */
const DESKTOP_TOP = 76;
/** The desktop column — a corner notice, not a banner. */
const DESKTOP_WIDTH = 380;
/** ...and the widest a phone notice gets on a large screen. */
const PHONE_MAX_WIDTH = 460;

function ToastCard({
  toast,
  offset,
  index,
  onMeasure,
}: {
  toast: Toast;
  /** Points down from the top of the stack to this notice's resting place. */
  offset: number;
  index: number;
  onMeasure: (id: string, height: number) => void;
}) {
  const colors = useColors();

  /** 0 off screen and transparent, 1 resting. Entrance and exit both. */
  const enter = useSharedValue(0);
  /** The notice's place in the stack, in points. */
  const stack = useSharedValue(offset);
  /** How far behind the newest it sits — 0, 1, 2. */
  const depth = useSharedValue(index);
  /** Where the finger has it, relative to that place. */
  const drag = useSharedValue(0);
  /** Measured, because the dismissal threshold is its own height. */
  const height = useSharedValue(ESTIMATED_HEIGHT);
  const placed = useRef(false);

  useEffect(() => {
    enter.set(
      withTiming(1, {
        duration: DURATION.enter,
        easing: EASE_OUT,
        reduceMotion: ReduceMotion.System,
      }),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Exits run quicker than entrances, and leave the way they arrived.
  useEffect(() => {
    if (!toast.leaving) return;
    enter.set(
      withTiming(0, {
        duration: DURATION.exit,
        easing: EASE_OUT,
        reduceMotion: ReduceMotion.System,
      }),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toast.leaving]);

  // The first position is where the notice is born; every later one is
  // the stack closing up around a departure, so it springs.
  useEffect(() => {
    if (!placed.current) {
      placed.current = true;
      stack.set(offset);
      return;
    }
    stack.set(
      withSpring(offset, {
        ...SPRING.settle,
        reduceMotion: ReduceMotion.System,
      }),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [offset]);

  useEffect(() => {
    depth.set(
      withSpring(index, {
        ...SPRING.settle,
        reduceMotion: ReduceMotion.System,
      }),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index]);

  const onLayout = (event: LayoutChangeEvent) => {
    const measured = event.nativeEvent.layout.height;
    if (measured <= 0) return;
    height.set(measured);
    onMeasure(toast.id, measured);
  };

  // Flung away with a finger, off the JS thread, on the sheets' own
  // rule: distance or speed, whichever comes first. Upward is the way
  // out — the direction it came from — so downward rubber-bands.
  const pan = useMemo(
    () =>
      Gesture.Pan()
        .activeOffsetY([-8, 8])
        .failOffsetX([-24, 24])
        .onBegin(() => {
          scheduleOnRN(pauseToastTimers);
        })
        .onUpdate((event) => {
          const y = event.translationY;
          drag.set(y <= 0 ? y : rubberband(y, height.get()));
        })
        .onEnd((event) => {
          const own = height.get();
          const leaving =
            -drag.get() > own * SHEET_DISMISS.travel ||
            -event.velocityY > SHEET_DISMISS.flick;
          if (leaving) {
            // The haptic belongs to the decision, not to the landing.
            scheduleOnRN(tapHaptic);
            drag.set(
              withSpring(-(own + stack.get() + 32), {
                ...SPRING.dismiss,
                velocity: event.velocityY,
                reduceMotion: ReduceMotion.System,
              }),
            );
            // One path out for every dismissal: the store marks it
            // leaving, the fade above plays, and it is dropped after.
            scheduleOnRN(dismissToast, toast.id);
          } else {
            drag.set(
              withSpring(0, {
                ...SPRING.snap,
                velocity: event.velocityY,
                reduceMotion: ReduceMotion.System,
              }),
            );
          }
        })
        .onFinalize(() => {
          scheduleOnRN(resumeToastTimers);
        }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [toast.id],
  );

  const cardStyle = useAnimatedStyle(() => {
    const shown = enter.get();
    const held = drag.get();
    return {
      transform: [
        { translateY: stack.get() + held - (1 - shown) * ENTER_TRAVEL },
        { scale: 1 - DEPTH_SCALE * depth.get() },
      ],
      opacity:
        shown *
        interpolate(
          Math.abs(held),
          [0, DISMISS_FADE],
          [1, 0.2],
          Extrapolation.CLAMP,
        ),
    };
  });

  const takeAction = () => {
    toast.action?.onPress();
    dismissToast(toast.id);
  };

  // There is no hover on a phone, so the timer also has to pause for a
  // pointer that is merely resting on the stack.
  const hoverProps =
    Platform.OS === 'web'
      ? { onPointerEnter: pauseToastTimers, onPointerLeave: resumeToastTimers }
      : null;

  return (
    <GestureDetector gesture={pan}>
      <Animated.View
        {...hoverProps}
        onLayout={onLayout}
        style={[styles.slot, { zIndex: 40 - index }, cardStyle]}
      >
        <View
          style={[
            styles.card,
            {
              // A notice floats over everything, so it takes the sheet's
              // rung on the elevation ladder — the same paper a dialog
              // is cut from, seated with the palette's own shadow tint.
              backgroundColor: colors.sheet,
              borderColor: colors.border,
              boxShadow: `0 14px 34px ${colors.shadowTint}`,
            } as ViewStyle,
          ]}
        >
          <View style={styles.copy}>
            <Text style={[styles.message, { color: colors.strongForeground }]}>
              {toast.message}
            </Text>
            {!!toast.detail && (
              <Text style={[styles.detail, { color: colors.mutedForeground }]}>
                {toast.detail}
              </Text>
            )}
          </View>
          {toast.action && (
            <PressableScale
              onPress={takeAction}
              accessibilityRole="button"
              accessibilityLabel={toast.action.label}
              testID="toast-action"
              style={(state) => [
                styles.action,
                {
                  borderColor: colors.border,
                  backgroundColor: state.pressed
                    ? colors.liftedHover
                    : isHovered(state)
                      ? colors.lifted
                      : 'transparent',
                },
              ]}
            >
              <Text
                style={[styles.actionText, { color: colors.strongForeground }]}
              >
                {toast.action.label}
              </Text>
            </PressableScale>
          )}
          {/* Dismissible without a gesture: a swipe is the quick way
              out, not the only one. */}
          <PressableScale
            onPress={() => dismissToast(toast.id)}
            hitSlop={10}
            accessibilityRole="button"
            accessibilityLabel="Dismiss notice"
            testID="toast-dismiss"
            style={(state) => [
              styles.close,
              { opacity: state.pressed ? 0.5 : isHovered(state) ? 0.8 : 1 },
            ]}
          >
            <Feather name="x" size={15} color={colors.mutedForeground} />
          </PressableScale>
        </View>
      </Animated.View>
    </GestureDetector>
  );
}

export function ToastStack() {
  const toasts = useSyncExternalStore(subscribeToToasts, getToasts, getToasts);
  const insets = useSafeAreaInsets();
  const desktop = useDesktop();
  const [heights, setHeights] = useState<Record<string, number>>({});

  const onMeasure = useCallback((id: string, height: number) => {
    setHeights((previous) =>
      Math.abs((previous[id] ?? 0) - height) < 0.5
        ? previous
        : { ...previous, [id]: height },
    );
  }, []);

  // Forget the height of a notice that has gone, or the map grows for
  // as long as the app runs.
  useEffect(() => {
    setHeights((previous) => {
      const kept: Record<string, number> = {};
      for (const toast of toasts) {
        const height = previous[toast.id];
        if (height !== undefined) kept[toast.id] = height;
      }
      return Object.keys(kept).length === Object.keys(previous).length
        ? previous
        : kept;
    });
  }, [toasts]);

  // A notice on its way out keeps its place on screen but gives up its
  // place in the stack, so the gap starts closing while it fades.
  let cursor = 0;
  const placed = toasts.map((toast) => {
    const offset = cursor;
    if (!toast.leaving) {
      cursor += (heights[toast.id] ?? ESTIMATED_HEIGHT) + GAP;
    }
    return { toast, offset };
  });

  return (
    <View
      // Always mounted, even empty: on the web this element is the live
      // region, and a browser only announces insertions into a region
      // that was already in the document.
      style={[
        styles.host,
        desktop
          ? { top: DESKTOP_TOP, right: 20, width: DESKTOP_WIDTH }
          : {
              // The line the phone's floating chrome leaves free. Most
              // screens have no bar at all now — only the one disc — so
              // the stack hangs from the same clearance the page's first
              // row does, which puts it under the disc on a thread and
              // under the bar on the About page alike.
              top: threadContentTop(false, insets.top),
              left: 12,
              right: 12,
            },
      ]}
      pointerEvents="box-none"
      {...(Platform.OS === 'web'
        ? ({
            role: 'status',
            'aria-live': 'polite',
            accessibilityLiveRegion: 'polite',
          } as object)
        : null)}
    >
      {placed.map(({ toast, offset }, index) => (
        <ToastCard
          key={toast.id}
          toast={toast}
          offset={offset}
          index={index}
          onMeasure={onMeasure}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  // Reaches to the bottom of the screen so a stack of absolutely
  // positioned notices is never clipped by its own container; it passes
  // every touch that is not on a notice straight through.
  host: {
    position: 'absolute',
    bottom: 0,
    zIndex: 1000,
  },
  slot: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    alignItems: 'center',
  },
  card: {
    width: '100%',
    maxWidth: PHONE_MAX_WIDTH,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    minHeight: 54,
    paddingVertical: 11,
    paddingLeft: 17,
    paddingRight: 9,
    ...rounded(RADIUS.lg),
    borderWidth: StyleSheet.hairlineWidth,
    // Keeps anything the card holds inside its own corners.
    overflow: 'hidden',
  },
  copy: {
    flex: 1,
    gap: 2,
  },
  // The app's chrome voice: short set-piece text, as on the header and
  // the citation sheet — never the reading voice, which belongs to
  // answers.
  message: {
    fontSize: 14.5,
    lineHeight: 19,
    fontFamily: fonts.displayMedium,
  },
  detail: {
    fontSize: 12.5,
    lineHeight: 17,
    fontFamily: fonts.body,
  },
  action: {
    minHeight: 34,
    justifyContent: 'center',
    paddingHorizontal: 12,
    borderWidth: StyleSheet.hairlineWidth,
    ...rounded(RADIUS.pill),
    cursor: 'pointer',
  },
  actionText: {
    fontSize: 12.5,
    fontFamily: fonts.bodyMedium,
  },
  close: {
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
    ...rounded(RADIUS.pill),
    cursor: 'pointer',
  },
});
