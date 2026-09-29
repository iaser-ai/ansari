import React, { useEffect, useId, useState } from 'react';
import {
  PixelRatio,
  Platform,
  StyleSheet,
  TextInput,
  View,
  type NativeSyntheticEvent,
  type TextInputKeyPressEventData,
} from 'react-native';
import { BlurView } from 'expo-blur';
import { GlassView, isLiquidGlassAvailable } from 'expo-glass-effect';
import { LinearGradient } from 'expo-linear-gradient';
import Animated, {
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { BrassSendButton } from '@/components/BrassSendButton';
import { useColors } from '@/hooks/useColors';
import { useScheme } from '@/hooks/useScheme';
import { useDesktop } from '@/hooks/useDesktop';
import { fonts } from '@/constants/colors';
import { DURATION, EASE_OUT } from '@/constants/motion';
import { COMPOSER_RADIUS, rounded } from '@/constants/radius';
import { withAlpha } from '@/lib/color';
import { sendHaptic } from '@/lib/haptics';
import { selfInkedFocusId } from '@/lib/semantics';

const liquidGlass = Platform.OS === 'ios' && isLiquidGlassAvailable();

const AnimatedGlassView = Animated.createAnimatedComponent(GlassView);

/**
 * The composer's own perimeter — the one edge in the app that still
 * draws, because a raised pane of glass is exactly the thing that has
 * an edge. Drawn at half a point rather than a whole one: at a point
 * wide it was an outline around the bar, at half it is light catching
 * along a lip.
 *
 * Half a point is only a real line where there are at least two device
 * pixels to a point. Asking for less than one device pixel hands the
 * line to the rasteriser, which either drops it or paints it at full
 * width anyway — so the floor is one device pixel, which is the
 * platform hairline by another name. A 2x phone or retina desktop
 * lands exactly on half a point; a 3x phone draws it a pixel and a
 * half wide rather than shrinking further, so the edge weighs the same
 * on every density; a 1x screen keeps its hairline, already the finest
 * line it can draw.
 */
const DEVICE_PIXEL =
  Platform.OS === 'web' ? 1 / PixelRatio.get() : StyleSheet.hairlineWidth;
const RIM_WIDTH = Math.max(0.5, DEVICE_PIXEL);

/**
 * A border sits inside the box, so thinning it would pull the bar's
 * height and its text inset in with it. The padding gives back exactly
 * what the rim gave up: same height, same radius, same everything, one
 * finer line. (On a 1x screen the rim is unchanged and this is zero.)
 */
const RIM_INSET_RECOVERY = 1 - RIM_WIDTH;

/**
 * The light-catching lip along the top edge.
 *
 * On paper a floating pane lifts by casting a shadow. On charcoal there
 * is nothing for a shadow to fall on, so the pane lifts by catching
 * light instead: a hairline of brightness across the top that fades out
 * toward the corners, exactly where a real pane of glass would take the
 * light of the room. Drawn as a gradient rather than an inset shadow so
 * it exists on native as well as on the web.
 */
function Lip({ color }: { color: string }) {
  return (
    <LinearGradient
      pointerEvents="none"
      colors={['transparent', color, color, 'transparent']}
      locations={[0, 0.28, 0.72, 1]}
      start={{ x: 0, y: 0 }}
      end={{ x: 1, y: 0 }}
      style={styles.lip}
    />
  );
}

/**
 * The composer's focus cue: the bar lifts.
 *
 * It used to fade in a drawn rim over the glass edge, but on a surface
 * that already has a lit rim and a drop shadow a second edge reads as
 * an outline stuck onto the bar. Focus should say *raised*, not
 * *selected* — so the bar's own depth answers instead. Nothing new is
 * drawn: the shadow it already casts throws further and deepens while
 * the contact shadow pulls in and firms, which is what an object does
 * when it rises off the page.
 *
 * After dark the mechanism flips, because a black shadow on charcoal
 * has nowhere to go (see `composerDepth` in the palette): the bar lifts
 * by catching more light along its top edge, the same way every other
 * floating surface in the app lifts at night.
 *
 * Both are one interpolation between two stops off the palette, run on
 * the UI thread and stepped straight to its end under Reduce Motion.
 */
function useComposerDepth(focused: boolean, sheen: string | null) {
  const { composerDepth } = useColors();
  const lift = useSharedValue(0);

  useEffect(() => {
    lift.value = withTiming(focused ? 1 : 0, {
      duration: focused ? DURATION.state : DURATION.exit,
      easing: EASE_OUT,
      reduceMotion: ReduceMotion.System,
    });
  }, [focused, lift]);

  return useAnimatedStyle(() => {
    const { rest, focus, shadowRgb, glowRgb } = composerDepth;
    const t = lift.value;
    const at = (key: keyof typeof rest) =>
      rest[key] + (focus[key] - rest[key]) * t;

    const layers = [
      `0 ${at('castY')}px ${at('castBlur')}px rgba(${shadowRgb}, ${at('castAlpha')})`,
      `0 ${at('contactY')}px ${at('contactBlur')}px rgba(${shadowRgb}, ${at('contactAlpha')})`,
    ];
    // The resting sheen the clear desktop composer already wore, kept
    // exactly as it was so nothing changes when the bar is at rest.
    if (sheen) layers.push(`inset 0 8px 18px ${sheen}`);
    const glow = at('glowAlpha');
    if (glow > 0) {
      layers.push(
        `inset 0 ${at('glowY')}px ${at('glowBlur')}px rgba(${glowRgb}, ${glow})`,
      );
    }
    return { boxShadow: layers.join(', ') };
  }, [composerDepth, sheen]);
}

/**
 * The composer surface: real Liquid Glass on modern iOS, a backdrop-blur
 * material on other iOS and web, and a solid linen card on Android.
 *
 * Every value it draws with — wash, rim, lip, shadow — comes from the
 * palette per mode, because the same recipe has to read as a *lit pane
 * over paper* by day and a *raised warm surface catching moonlight* at
 * night, and those are not the same colours.
 */
function ComposerSurface({
  children,
  clear = false,
  focused = false,
  disabled = false,
}: {
  children: React.ReactNode;
  /**
   * Media-backed surfaces (the ambient-video home screen) ask for the
   * clear treatment: Apple's `clear` Liquid Glass variant, made for
   * sitting over motion, and a lighter wash on the fallback materials.
   */
  clear?: boolean;
  /** Lifts the bar on its own shadow while the question field has focus. */
  focused?: boolean;
  /**
   * A disabled composer stops being a raised surface: no lip, no
   * shadow, a recessed wash instead of a lifted one. The field looks
   * unavailable, not just the button inside it.
   */
  disabled?: boolean;
}) {
  const colors = useColors();
  const scheme = useScheme();
  const desktop = useDesktop();

  // A disabled composer stops being a raised surface, so it takes no
  // depth at all — the hook still runs, its result simply isn't applied.
  const lift = useComposerDepth(
    focused && !disabled,
    clear && desktop ? colors.glassSheen : null,
  );
  const depth = disabled ? undefined : lift;

  if (liquidGlass) {
    // Interactive glass is what gives Liquid Glass its visible presence
    // (rim lighting + touch shimmer) — the same treatment the system
    // composer in Messages uses. Children sit above the effect view, so
    // the text field and buttons receive touches as usual. Nothing is
    // layered on top of it, so it keeps its own rim rather than ours —
    // the focus cue reaches it as depth on the same view, not as an
    // overlay that would sit between the reader and the glass.
    return (
      <View style={styles.wrap}>
        <AnimatedGlassView
          glassEffectStyle={clear ? 'clear' : 'regular'}
          isInteractive
          // Pinned so the composer can't flip appearance when a bright
          // patch of the ambient video passes beneath it.
          colorScheme={scheme}
          style={[styles.container, disabled && styles.dimmed, depth]}
        >
          {children}
        </AnimatedGlassView>
      </View>
    );
  }
  if (Platform.OS === 'ios' || Platform.OS === 'web') {
    return (
      <View style={styles.wrap}>
        <Animated.View
          style={[
            styles.container,
            styles.clip,
            {
              borderWidth: RIM_WIDTH,
              // The lift is the composer's answer to focus, and a
              // shadow is a poor thing to ask a keyboard reader to spot
              // — especially over the ambient video, where the bar is
              // already floating. So the rim inks with it, the way the
              // search field's does: same width, same radius, nothing
              // moves, and the cue is a change of value rather than a
              // second ring drawn outside the one already there.
              borderColor: disabled
                ? colors.inputRim
                : focused
                  ? colors.inputRimFocus
                  : colors.glassRim,
              // Longhands, because Yoga gives an edge-specific padding
              // precedence over the shorthand whatever the order — the
              // shared style already sets paddingTop and paddingBottom.
              paddingTop: 12 + RIM_INSET_RECOVERY,
              paddingBottom: 12 + RIM_INSET_RECOVERY,
              paddingHorizontal: 12 + RIM_INSET_RECOVERY,
            },
            depth,
          ]}
        >
          <BlurView
            // The desktop clear composer wants to read like lit glass over
            // the ambient shadow, so it leans on a much lighter blur tint;
            // the phone/native and non-clear surfaces keep the fuller wash.
            intensity={clear && desktop ? 24 : 30}
            tint={scheme === 'dark' ? 'dark' : 'light'}
            style={StyleSheet.absoluteFillObject}
          />
          <View
            style={[
              StyleSheet.absoluteFillObject,
              {
                // The wash carries the whole value step on the web,
                // where a nested blur has no backdrop to work on — so it
                // is heavy enough that the composer is unmistakably a
                // step above the page, and no heavier.
                backgroundColor: disabled
                  ? withAlpha(colors.surface, 0.7)
                  : clear
                    ? colors.glassWashClear
                    : colors.glassWash,
              },
            ]}
          />
          {!disabled && <Lip color={colors.glassLip} />}
          {children}
        </Animated.View>
      </View>
    );
  }
  return (
    <View style={styles.wrap}>
      <Animated.View
        style={[
          styles.container,
          styles.clip,
          {
            // Android has no backdrop blur here — a translucent linen
            // fill lets the ambient video ghost through instead.
            backgroundColor: disabled
              ? withAlpha(colors.surface, 0.9)
              : withAlpha(colors.card, clear ? 0.88 : 1),
            borderWidth: RIM_WIDTH,
            borderColor: disabled ? colors.inputRim : colors.glassRim,
            paddingTop: 12 + RIM_INSET_RECOVERY,
            paddingBottom: 12 + RIM_INSET_RECOVERY,
            paddingHorizontal: 12 + RIM_INSET_RECOVERY,
          },
          depth,
        ]}
      >
        {!disabled && <Lip color={colors.glassLip} />}
        {children}
      </Animated.View>
    </View>
  );
}

/**
 * The shared composer: one compact bar on every platform — the question
 * field and the brass send disc side by side, the card hugging the
 * button with the same 12px breathing room on every side.
 */
export function ChatInput({
  onSend,
  sending,
  placeholder = 'Ask Ansari',
  autoFocus = false,
  onFocusChange,
  inputRef,
  clearGlass = false,
  disabled = false,
  shimmerSend = false,
}: {
  onSend: (text: string) => void;
  sending: boolean;
  placeholder?: string;
  autoFocus?: boolean;
  /** Fires when the question field gains or loses focus. */
  onFocusChange?: (focused: boolean) => void;
  /** Direct handle on the field, so screens can blur it reliably. */
  inputRef?: React.Ref<TextInput>;
  /** Clearer glass for media-backed screens (the ambient-video home). */
  clearGlass?: boolean;
  /** Keeps the draft visible when the thread is unavailable. */
  disabled?: boolean;
  /** The send button catches the light once, shortly after it appears. */
  shimmerSend?: boolean;
}) {
  const colors = useColors();
  const fieldKey = useId();
  const [text, setText] = useState('');
  const [focused, setFocused] = useState(false);
  // Web autogrow: react-native-web's <textarea> keeps its browser
  // default height instead of sizing to content, so on web the bar
  // tracks content height itself — 42 (one line, matching the send
  // button) up to the shared 110 cap. Native multiline autogrows on
  // its own.
  const [inputHeight, setInputHeight] = useState(42);
  const canSend = text.trim().length > 0 && !sending && !disabled;

  const submit = () => {
    if (!canSend) return;
    sendHaptic();
    onSend(text.trim());
    setText('');
  };

  // Web manners: Enter sends, Shift+Enter breaks the line. On web the
  // event is a React synthetic keyboard event (`key`/`shiftKey` on it,
  // the DOM event underneath), and react-native-web runs this handler
  // first — preventDefault() both suppresses the newline and stops any
  // further submit handling, so nothing fires twice. IME composition
  // (Arabic transliteration and the like) is left alone. Native
  // keyboards never come through here with Enter; they use
  // submitBehavior/onSubmitEditing as before.
  const submitOnEnter = (
    e: NativeSyntheticEvent<TextInputKeyPressEventData>,
  ) => {
    if (Platform.OS !== 'web') return;
    const web = e as unknown as {
      key?: string;
      shiftKey?: boolean;
      nativeEvent?: { isComposing?: boolean; keyCode?: number };
      preventDefault: () => void;
    };
    const composing =
      web.nativeEvent?.isComposing === true || web.nativeEvent?.keyCode === 229;
    if (web.key === 'Enter' && !web.shiftKey && !composing) {
      web.preventDefault();
      submit();
    }
  };

  const field = (
    <TextInput
      ref={inputRef}
      value={text}
      onChangeText={setText}
      placeholder={placeholder}
      // The hero ink used to carry this, at 2.2:1 against the composer
      // in both modes — decorative, not readable. The placeholder ink
      // is tuned to clear 4.5:1 on the composer surface it sits on.
      placeholderTextColor={disabled ? colors.heroInk : colors.placeholder}
      // Native tints the caret and the selection handles from these; the
      // web selection wash is set once, globally, from the same palette.
      cursorColor={colors.caret}
      selectionColor={colors.caret}
      style={[
        styles.input,
        Platform.OS === 'web' && styles.inputWeb,
        Platform.OS === 'web' && { height: inputHeight },
        { color: disabled ? colors.mutedForeground : colors.cardForeground },
      ]}
      multiline
      autoFocus={autoFocus}
      editable={!disabled}
      // The bar's lift *is* this field's focus cue, so it says so by
      // name and the page's ring stays off it. Named per mounted
      // composer, because the ask and the thread both have one on
      // screen through the hand-off. See `SELF_INKED_FOCUS`.
      nativeID={selfInkedFocusId(fieldKey)}
      accessibilityLabel="Your question"
      accessibilityHint="Type a question. On the web, press Enter to send and Shift Enter for a new line."
      submitBehavior="submit"
      onSubmitEditing={submit}
      onKeyPress={submitOnEnter}
      onContentSizeChange={
        Platform.OS === 'web'
          ? (e) =>
              setInputHeight(
                Math.min(110, Math.max(42, e.nativeEvent.contentSize.height)),
              )
          : undefined
      }
      onFocus={() => {
        setFocused(true);
        onFocusChange?.(true);
      }}
      onBlur={() => {
        setFocused(false);
        onFocusChange?.(false);
      }}
      testID="chat-input"
    />
  );

  const sendButton = (
    <BrassSendButton
      onPress={submit}
      canSend={canSend}
      sending={sending}
      shimmer={shimmerSend}
      testID="chat-send"
    />
  );

  // Field and send button share one bottom-aligned row, so the button
  // stays pinned to the corner while long questions grow the field
  // toward its cap.
  return (
    <ComposerSurface clear={clearGlass} focused={focused} disabled={disabled}>
      <View style={styles.row}>
        {field}
        {sendButton}
      </View>
    </ComposerSurface>
  );
}

const styles = StyleSheet.create({
  // The bar's own positioning context, kept so the lip and the material
  // layers inside it stay anchored to the pill.
  wrap: {
    position: 'relative',
  },
  // The compact bar: send button 42 + 12 above and below = 66 tall at
  // rest, a true pill.
  container: {
    ...rounded(COMPOSER_RADIUS),
    paddingHorizontal: 12,
    paddingTop: 12,
    paddingBottom: 12,
  },
  clip: {
    overflow: 'hidden',
  },
  // Liquid Glass draws its own material, so a disabled composer there
  // says so by receding rather than by being repainted.
  dimmed: {
    opacity: 0.55,
  },
  // Drawn to the weight of the rim it sits above: at a full point over
  // a half-point edge the lip was the heavier of the two lines, and a
  // highlight that out-weighs the edge it lights reads as a second
  // stroke rather than as light landing on the pane. Its colour came
  // down with it (see `glassLip`).
  lip: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: RIM_WIDTH,
  },
  row: {
    flexDirection: 'row',
    // Bottom-aligned so the send button sits exactly as far from the
    // card's bottom edge as it does from its side, however tall the
    // field grows.
    alignItems: 'flex-end',
    gap: 10,
  },
  input: {
    flex: 1,
    fontSize: 16,
    fontFamily: fonts.body,
    maxHeight: 110,
    paddingVertical: 10,
    // The question starts a clear step inside the pill's curve rather
    // than against it; the right side keeps its tighter inset, where
    // the send disc supplies the breathing room instead.
    paddingLeft: 10,
    paddingRight: 4,
    // `minWidth: 0` is what lets the field actually shrink. A flex item
    // will not go below its own min-content width unless it is told to,
    // and a textarea's min-content width is the browser's default
    // `cols` — around 232px in Firefox. On a 320px phone the row has
    // only 266px for the field, the gap and the 42px send disc, so
    // Firefox held the field at 232 and pushed the send button 18px out
    // through the pill's right edge. Chromium and WebKit floor the same
    // control at zero, which is why the overhang only ever showed up in
    // Gecko, and only under about 350px — including any browser at 200%
    // zoom on a phone. The search field already carries this.
    ...(Platform.OS === 'web' ? ({ minWidth: 0 } as object) : {}),
  },
  // Web sizes the field against its tracked height; 11 + 20 + 11 keeps
  // a single line at exactly 42 — the send button's height.
  inputWeb: {
    paddingVertical: 11,
    lineHeight: 20,
  },
});
