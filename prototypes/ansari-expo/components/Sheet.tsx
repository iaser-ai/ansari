import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  View,
  useWindowDimensions,
  type LayoutChangeEvent,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import {
  Gesture,
  GestureDetector,
  GestureHandlerRootView,
} from 'react-native-gesture-handler';
import Animated, {
  Extrapolation,
  ReduceMotion,
  interpolate,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useColors } from '@/hooks/useColors';
import { useDesktop } from '@/hooks/useDesktop';
import { useOverlayFocus } from '@/hooks/useOverlayFocus';
import {
  DURATION,
  EASE_SHEET,
  SHEET_DISMISS,
  SPRING,
  rubberband,
} from '@/constants/motion';
import { tapHaptic } from '@/lib/haptics';
import { RADIUS, rounded, roundedTop } from '@/constants/radius';

/**
 * The app's sheet chrome, in one place: scrim, card, grabber, and — on a
 * phone — a sheet you can actually pull down.
 *
 * A grabber is a promise. Everything here exists to keep it: the card
 * tracks the finger one to one, resists rather than stops if pulled past
 * its resting place, leaves on a flick as readily as on a long drag, and
 * carries the release velocity into whichever outcome so there is no seam
 * between the finger letting go and the sheet finishing the move. The
 * scrim and the corner radius are derived from the same value the drag
 * writes, so the sheet reads as one object leaving the screen rather than
 * a panel that blinks out at the end.
 *
 * One position value drives all of it — entrance, drag, dismissal and the
 * programmatic close are the same motion on the same shared value, which
 * is what lets a close be grabbed mid-flight and reversed.
 *
 * On desktop widths the same card presents as a centred dialog: it keeps
 * the short rise and cross-fade it has always had, and is not draggable.
 * With reduced motion on, the animations collapse to instant (through
 * `ReduceMotion.System`) and the drag is switched off with them.
 *
 * A keyboard gets the same promise a finger does: focus moves into the
 * card when it opens, stays in it while it is open, leaves on Escape,
 * and goes back to whatever raised it. That is `useOverlayFocus`, shared
 * with the sources panel and the phone drawer so all three behave
 * identically — a grabber, a scrim and a trap are one contract.
 */

/** The desktop dialog's rise — a lift, not a slide off the bottom edge. */
const DESKTOP_RISE = 24;

/** The card's top corners at rest, clipped to the bottom edge of the screen. */
const RADIUS_RESTING = RADIUS.xl;
/** ...and once it has been pulled away from that edge and reads as free. */
const RADIUS_FREE = RADIUS.xxl;

export function Sheet({
  open,
  onClose,
  onExited,
  header,
  children,
  style,
  dialogStyle,
  accessibilityLabel,
  accessibilityViewIsModal,
}: {
  /** Whether the sheet should be on screen. */
  open: boolean;
  /** Asked to leave — by the close button, the scrim, back, or a drag. */
  onClose: () => void;
  /** The sheet has finished leaving and is unmounted. */
  onExited?: () => void;
  /**
   * The grabber's neighbours: the title row. This region and the grabber
   * are what the finger drags, so anything scrollable stays in `children`.
   */
  header: React.ReactNode;
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  dialogStyle?: StyleProp<ViewStyle>;
  accessibilityLabel?: string;
  accessibilityViewIsModal?: boolean;
}) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const desktop = useDesktop();
  const reduced = useReducedMotion();
  const { height: screenHeight } = useWindowDimensions();

  const [mounted, setMounted] = useState(false);
  const entered = useRef(false);
  /** The last measured card height, forgotten once the sheet unmounts. */
  const measured = useRef(0);

  /**
   * How far the sheet sits below its resting place, in points. Zero is
   * home; the sheet's own height is off the bottom of the screen.
   */
  const y = useSharedValue(screenHeight);
  /** Measured, because the travel is the sheet's height, not the screen's. */
  const sheetHeight = useSharedValue(screenHeight);
  /** Where the sheet was when the finger landed on it, mid-flight or not. */
  const grabbedAt = useSharedValue(0);

  const draggable = !desktop && !reduced;

  // The card is what the trap holds, not the modal around it: the scrim
  // is inside that modal too, and a reader tabbing onto a full-screen
  // "close" rectangle has been let out of the sheet in every way that
  // matters.
  const overlayID = useOverlayFocus(open, onClose);

  const finishExit = useCallback(() => {
    measured.current = 0;
    setMounted(false);
    onExited?.();
  }, [onExited]);

  /** The rise, from wherever the card's own height puts it off screen. */
  const enter = useCallback(
    (height: number) => {
      entered.current = true;
      // A sheet rising into view is coming to rest rather than fading up,
      // so it springs — with just enough give at the end of the travel to
      // read as a thing arriving rather than a value being set.
      y.set(desktop ? DESKTOP_RISE : height);
      y.set(
        withSpring(0, { ...SPRING.sheet, reduceMotion: ReduceMotion.System }),
      );
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [desktop],
  );

  useEffect(() => {
    if (open) {
      entered.current = false;
      if (measured.current > 0) {
        // Reopened before it finished leaving: the card is still on
        // screen and already measured, so it rises from here.
        enter(measured.current);
      } else {
        // Parked off screen until layout — the rise starts from the
        // sheet's own height, which only a measurement knows.
        y.set(screenHeight);
      }
      setMounted(true);
    } else if (mounted) {
      const closed = desktop ? DESKTOP_RISE : sheetHeight.get();
      // A drag that dismissed the sheet has already taken it there.
      if (y.get() >= closed - 0.5) {
        finishExit();
        return;
      }
      // Dismissal is a plain exit and stays on a curve — iOS's own sheet
      // curve, and quicker than the arrival.
      y.set(
        withTiming(
          closed,
          {
            duration: DURATION.exit,
            easing: EASE_SHEET,
            reduceMotion: ReduceMotion.System,
          },
          (finished) => {
            if (finished) scheduleOnRN(finishExit);
          },
        ),
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const onSheetLayout = (event: LayoutChangeEvent) => {
    const height = event.nativeEvent.layout.height;
    if (height <= 0) return;
    measured.current = height;
    sheetHeight.set(height);
    if (open && !entered.current) enter(height);
  };

  const pan = useMemo(
    () =>
      Gesture.Pan()
        .enabled(draggable)
        // Require intent before committing, so a tap on the close button
        // and a lazy finger on the title both survive.
        .activeOffsetY([-10, 10])
        .onStart(() => {
          // Start from where the eye last saw the sheet, not from home:
          // this is what lets a close be caught mid-flight and reversed.
          grabbedAt.set(y.get());
        })
        .onUpdate((event) => {
          const next = grabbedAt.get() + event.translationY;
          // Downward is free; upward past the resting place resists.
          y.set(next >= 0 ? next : rubberband(next, sheetHeight.get()));
        })
        .onEnd((event) => {
          const height = sheetHeight.get();
          // Distance or speed, whichever comes first: a long pull is an
          // unambiguous "go away", and so is a flick from near the top.
          const leaving =
            y.get() > height * SHEET_DISMISS.travel ||
            event.velocityY > SHEET_DISMISS.flick;
          if (leaving) {
            // The haptic belongs to the moment the decision is made, not
            // to the moment the animation lands.
            scheduleOnRN(tapHaptic);
            y.set(
              withSpring(
                height,
                {
                  ...SPRING.dismiss,
                  velocity: event.velocityY,
                  reduceMotion: ReduceMotion.System,
                },
                (finished) => {
                  if (finished) scheduleOnRN(onClose);
                },
              ),
            );
          } else {
            y.set(
              withSpring(0, {
                ...SPRING.sheet,
                velocity: event.velocityY,
                reduceMotion: ReduceMotion.System,
              }),
            );
          }
        }),
    // `y`, `sheetHeight` and `grabbedAt` are Reanimated shared values:
    // one object per mount, read and written on the UI thread, never
    // reassigned. Listing them would say the gesture has to be rebuilt
    // when they change, which they never do.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [draggable, onClose],
  );

  const backdropStyle = useAnimatedStyle(() => ({
    opacity: interpolate(
      y.get(),
      [0, desktop ? DESKTOP_RISE : sheetHeight.get()],
      [1, 0],
      Extrapolation.CLAMP,
    ),
  }));

  const sheetStyle = useAnimatedStyle(() => {
    const offset = y.get();
    // The dialog cross-fades over its short rise, as it always has. The
    // phone sheet is a real sheet: it slides, and stays solid while it
    // does — a card that goes translucent under the finger reads as a
    // rendering artefact, not as a thing being moved.
    const radius = desktop
      ? RADIUS_RESTING
      : interpolate(
          offset,
          [0, sheetHeight.get() * 0.5],
          [RADIUS_RESTING, RADIUS_FREE],
          Extrapolation.CLAMP,
        );
    return {
      transform: [{ translateY: offset }],
      opacity: desktop
        ? interpolate(offset, [0, DESKTOP_RISE], [1, 0], Extrapolation.CLAMP)
        : 1,
      // The curve itself comes from the static style; only its size
      // moves as the sheet is pulled clear of the bottom edge.
      borderTopLeftRadius: radius,
      borderTopRightRadius: radius,
    };
  });

  const bottomPad = desktop
    ? 22
    : Platform.OS === 'web'
      ? 34
      : Math.max(insets.bottom, 16);

  // A phone sheet takes the height its contents ask for — and stops
  // there. Without a ceiling a long sheet simply keeps growing upward
  // off the top of the glass: its head, which is the grabber and the
  // title, is the part that disappears, and the reader is left with a
  // card that has no top edge and cannot be told apart from the page.
  // Held a clear step below the status bar, the sheet always reads as a
  // card lying over the page rather than as a second screen.
  const sheetCap = desktop
    ? undefined
    : { maxHeight: screenHeight - insets.top - 24 };

  return (
    <Modal
      visible={mounted}
      transparent
      animationType="none"
      onRequestClose={onClose}
    >
      {/* A modal is its own view hierarchy on native, outside the root
          view the app set up, so gestures inside it need their own. */}
      <GestureHandlerRootView style={styles.root}>
        <Animated.View
          style={[
            styles.backdrop,
            { backgroundColor: colors.scrim },
            backdropStyle,
          ]}
        >
          {/* A pointer's way out, and only a pointer's. A keyboard has
              Escape and a screen reader has the close control inside
              the card; an unnamed full-bleed button in front of both
              would be the first thing either one found. */}
          <Pressable
            style={styles.backdropPress}
            onPress={onClose}
            focusable={false}
            accessible={false}
            importantForAccessibility="no-hide-descendants"
            aria-hidden
          />
        </Animated.View>
        <View
          style={[styles.sheetContainer, desktop && styles.dialogContainer]}
          pointerEvents="box-none"
        >
          <Animated.View
            onLayout={onSheetLayout}
            nativeID={overlayID}
            accessibilityViewIsModal={accessibilityViewIsModal}
            accessibilityLabel={accessibilityLabel}
            style={[
              styles.sheet,
              sheetCap,
              desktop && styles.dialogSheet,
              style,
              desktop && dialogStyle,
              sheetStyle,
              {
                // A sheet sits above everything, so it takes the rung
                // above a card on the elevation ladder — which in dark
                // mode is the only thing that tells the two apart.
                backgroundColor: colors.sheet,
                borderColor: colors.border,
                paddingBottom: bottomPad,
              },
            ]}
          >
            <GestureDetector gesture={pan}>
              <View style={styles.dragRegion}>
                {!desktop && (
                  <View
                    style={[styles.grabber, { backgroundColor: colors.border }]}
                  />
                )}
                {header}
              </View>
            </GestureDetector>
            {children}
          </Animated.View>
        </View>
      </GestureHandlerRootView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  // Tinted per mode: a warm wash over paper by day, a deeper one over
  // charcoal at night, so a sheet never opens onto a black rectangle.
  backdrop: {
    ...StyleSheet.absoluteFillObject,
  },
  backdropPress: {
    flex: 1,
  },
  sheetContainer: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'flex-end',
  },
  // Desktop: the card centers with a scrim on every side.
  dialogContainer: {
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  sheet: {
    ...roundedTop(RADIUS_RESTING),
    borderWidth: 1,
    paddingHorizontal: 20,
    paddingTop: 8,
    gap: 12,
  },
  dialogSheet: {
    width: '100%',
    ...rounded(RADIUS_RESTING),
    paddingTop: 20,
  },
  // Grabber and title travel together under the finger.
  dragRegion: {
    gap: 12,
  },
  grabber: {
    alignSelf: 'center',
    width: 36,
    height: 4,
    ...rounded(RADIUS.pill),
    marginBottom: 4,
  },
});
