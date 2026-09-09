import React, { useState } from 'react';
import {
  Pressable,
  type PressableProps,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import Animated, { useReducedMotion } from 'react-native-reanimated';
import { DURATION, EASE_OUT_CSS } from '@/constants/motion';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

/**
 * What a Pressable knows about itself while it is being used. The same
 * shape react-native-web hands its own style callback, so `isHovered`
 * and every existing `state.pressed` check keep working unchanged.
 */
export type PressState = { pressed: boolean; hovered: boolean };

/**
 * A control that dips under the finger.
 *
 * A fade tells you a control noticed you; a dip tells you that you
 * pushed it. Only two frames' worth of difference, but it is the
 * difference between reading as software and reading as a thing.
 *
 * Everything else about pressing stays where the call site put it —
 * hit slop, press retention, the hover and pressed colours it already
 * describes through `style`. This adds the scale and nothing else, and
 * removes even that when the reader has asked for reduced motion.
 *
 * Deliberately not used on the Liquid Glass surfaces (the composer, the
 * round glass buttons). iOS animates its own glass under a touch, and a
 * scale layered on top fights it.
 */
export function PressableScale({
  style,
  scale = 0.97,
  children,
  onPressIn,
  onPressOut,
  onHoverIn,
  onHoverOut,
  ...rest
}: Omit<PressableProps, 'style' | 'children'> & {
  style?: StyleProp<ViewStyle> | ((state: PressState) => StyleProp<ViewStyle>);
  /** How far it sinks. Smaller controls can take a little more. */
  scale?: number;
  children?: React.ReactNode;
}) {
  const reducedMotion = useReducedMotion();
  // Pressable resolves its own state internally, but the scale has to
  // be a declared style for the transition below to have something to
  // animate between — so the two states are held here instead. This
  // renders twice per press, which is what a press costs.
  const [pressed, setPressed] = useState(false);
  const [hovered, setHovered] = useState(false);

  return (
    <AnimatedPressable
      {...rest}
      onPressIn={(event) => {
        setPressed(true);
        onPressIn?.(event);
      }}
      onPressOut={(event) => {
        setPressed(false);
        onPressOut?.(event);
      }}
      onHoverIn={(event) => {
        setHovered(true);
        onHoverIn?.(event);
      }}
      onHoverOut={(event) => {
        setHovered(false);
        onHoverOut?.(event);
      }}
      style={[
        {
          transitionProperty: 'transform',
          transitionDuration: DURATION.press,
          transitionTimingFunction: EASE_OUT_CSS,
        },
        typeof style === 'function' ? style({ pressed, hovered }) : style,
        { transform: [{ scale: pressed && !reducedMotion ? scale : 1 }] },
      ]}
    >
      {children}
    </AnimatedPressable>
  );
}
