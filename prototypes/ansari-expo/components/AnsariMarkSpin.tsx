import React from 'react';
import { Platform, StyleSheet, type ViewStyle } from 'react-native';
import { tickHaptic } from '@/lib/haptics';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  ReduceMotion,
  runOnJS,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDecay,
  withSpring,
  type SharedValue,
} from 'react-native-reanimated';
import Svg, { Path } from 'react-native-svg';
import {
  ANSARI_MARK_ASPECT_RATIO,
  ANSARI_MARK_DECORATIVE_PROPS,
  ANSARI_MARK_PATH,
  ANSARI_MARK_VIEWBOX,
} from '@/constants/ansariMark';
import { brass } from '@/constants/colors';
import { useScheme } from '@/hooks/useScheme';
import { coinTurnAt, SPRING } from '@/constants/motion';
import { AnsariMarkBrass } from './AnsariMarkBrass';

/**
 * How far the mark turns per pixel of drag. Set so that a comfortable
 * swipe across a phone — roughly 240pt — is a little more than one full
 * revolution: enough that a curious finger is rewarded immediately,
 * short of the mark feeling loose or over-geared.
 */
const DEGREES_PER_PX = 1.5;

/**
 * The finger has to travel this far sideways before the turn takes the
 * gesture. Below it the touch belongs to the paper underneath, which is
 * what dismisses the keyboard — a tap on the emblem must still do the
 * ordinary thing.
 */
const CLAIM_AT = 6;

/**
 * A flick keeps turning and slows to a stop rather than halting with the
 * finger, the way a struck coin spun on a table does. Firm enough that
 * even a hard flick is spent within a second or so; the mark is a
 * flourish, not something to be left whirring on the page.
 */
const SPIN_DOWN = 0.995;

/**
 * How thick the mark is, as a fraction of its height.
 *
 * A face with no edge is a decal, not a piece of struck brass, and the
 * moment it starts to turn the eye knows. What it is not is a coin
 * standing on its rim: at three hundredths the emblem is about as thick
 * as a pressed medal, seen only in the sweep and gone again at rest.
 */
const THICKNESS = 0.03;

/**
 * The far side of the slab, seen past the face as the mark turns.
 *
 * These children are flattened into the face's own plane — there is no
 * real depth here to put them behind it — so the edge is drawn as the
 * face's silhouette in an unlit brass, shifted along the turn. A point
 * `t` behind the face lands `t·sin(angle)` to the side on screen, and
 * everything in this plane is already foreshortened by `cos(angle)`, so
 * the offset it has to be *given* is `t·tan(angle)`. That runs away to
 * infinity at edge-on, which is precisely where the face has narrowed
 * to a line and the whole emblem is a sliver: clamped there, and hidden
 * by the same `|sin|` that reveals it, the cheat never has a frame in
 * which it could be seen.
 */
const EDGE_REACH = 3;

/** The two silhouettes that stand in for the mark's edge, back to front. */
const EDGE_PLIES = [
  { depth: 1, shade: 'shadow' as const, alpha: 0.85 },
  { depth: 0.45, shade: 'deep' as const, alpha: 0.7 },
];

/** Native only: the quiet tick as the mark comes to rest face-on. */
function restTick() {
  tickHaptic();
}

/**
 * The phone's hero emblem, turnable with a finger.
 *
 * The rail's mark turns once on its own axis every time the sidebar
 * opens or closes — a piece of struck brass catching the light as its
 * face sweeps past edge-on. A phone has no rail to collapse, so the same
 * turn is put directly under the reader's finger instead: drag the
 * emblem and it follows, flick it and it spins down and settles face-on.
 *
 * It is deliberately undiscoverable and deliberately inconsequential.
 * Nothing depends on it, nothing announces it, and it always comes back
 * to the angle the mark was authored at.
 */
export function AnsariMarkSpin({ height }: { height: number }) {
  const reducedMotion = useReducedMotion();
  const dark = useScheme() === 'dark';
  const degrees = useSharedValue(0);
  const from = useSharedValue(0);
  const thickness = height * THICKNESS;

  // Same reasoning as the rail: the glint is a web filter, and a
  // platform that cannot draw one simply gets the turn without it.
  const glintable = Platform.OS === 'web';

  // Coming to rest means the nearest face-on angle, never a half turn —
  // the mark reads backwards at 180deg. Once the spring has landed, the
  // angle is folded back to zero: a whole number of turns is the same
  // picture, so this is invisible, and it keeps the value from drifting
  // out to thousands of degrees over a long sitting.
  const settle = (fling: number) => {
    'worklet';
    const land = () => {
      'worklet';
      degrees.set(
        withSpring(
          Math.round(degrees.get() / 360) * 360,
          { ...SPRING.glide, reduceMotion: ReduceMotion.System },
          (landed) => {
            if (!landed) return;
            degrees.set(0);
            runOnJS(restTick)();
          },
        ),
      );
    };
    if (reducedMotion || Math.abs(fling) < 40) {
      land();
      return;
    }
    degrees.set(
      withDecay({ velocity: fling, deceleration: SPIN_DOWN }, (finished) => {
        if (finished) land();
      }),
    );
  };

  const spin = Gesture.Pan()
    .activeOffsetX([-CLAIM_AT, CLAIM_AT])
    .onBegin(() => {
      from.set(degrees.get());
    })
    .onUpdate((e) => {
      degrees.set(from.get() + e.translationX * DEGREES_PER_PX);
    })
    .onEnd((e) => {
      settle(e.velocityX * DEGREES_PER_PX);
    })
    .onFinalize((_e, success) => {
      // A cancelled turn still has to come home; without this the mark
      // would be left stranded at whatever angle the finger left it.
      if (!success) settle(0);
    });

  const markStyle = useAnimatedStyle(() => {
    const d = degrees.get();
    // `coinTurnAt` reads a 0 → 1 progress through one revolution, which
    // is what puts the glint at the same two angles here as on the rail.
    const turn = ((d % 360) + 360) % 360;
    const coin = coinTurnAt(turn / 360);
    return {
      transform: [{ perspective: coin.perspective }, { rotateY: `${d}deg` }],
      ...(glintable
        ? {
            filter: `brightness(${coin.brightness}) contrast(${coin.contrast})`,
            // At a narrow window a mouse can reach this too, and a
            // grabbable thing should say so. (`grab` is a real CSS
            // cursor that react-native-web passes straight through;
            // only RN's own types stop at `pointer`.)
            cursor: 'grab',
          }
        : null),
    } as unknown as ViewStyle;
  });

  return (
    <GestureDetector gesture={spin}>
      <Animated.View style={[styles.mark, markStyle]}>
        {EDGE_PLIES.map((ply) => (
          <MarkEdge
            key={ply.shade}
            height={height}
            reach={thickness * ply.depth}
            color={brass[dark ? 'dark' : 'light'][ply.shade]}
            alpha={ply.alpha}
            degrees={degrees}
          />
        ))}
        <AnsariMarkBrass height={height} />
      </Animated.View>
    </GestureDetector>
  );
}

/** One silhouette of the mark's edge, riding the turn behind the face. */
function MarkEdge({
  height,
  reach,
  color,
  alpha,
  degrees,
}: {
  height: number;
  reach: number;
  color: string;
  alpha: number;
  degrees: SharedValue<number>;
}) {
  const width = height * ANSARI_MARK_ASPECT_RATIO;
  const edgeStyle = useAnimatedStyle(() => {
    const radians = (degrees.get() * Math.PI) / 180;
    const side = Math.tan(radians);
    return {
      opacity: Math.abs(Math.sin(radians)) * alpha,
      transform: [
        {
          translateX:
            -reach * Math.max(-EDGE_REACH, Math.min(EDGE_REACH, side)),
        },
      ],
    };
  });
  return (
    <Animated.View style={[styles.edge, { width, height }, edgeStyle]}>
      <Svg
        width={width}
        height={height}
        viewBox={`0 0 ${ANSARI_MARK_VIEWBOX.width} ${ANSARI_MARK_VIEWBOX.height}`}
        {...ANSARI_MARK_DECORATIVE_PROPS}
      >
        <Path d={ANSARI_MARK_PATH} fill={color} />
      </Svg>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  mark: {
    alignItems: 'center',
  },
  edge: {
    position: 'absolute',
    top: 0,
  },
});
