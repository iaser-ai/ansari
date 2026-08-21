import React, { useState } from 'react';
import {
  ActivityIndicator,
  Platform,
  Pressable,
  StyleSheet,
  TextInput,
  View,
  type NativeSyntheticEvent,
  type TextInputKeyPressEventData,
} from 'react-native';
import { Feather } from '@expo/vector-icons';
import { BlurView } from 'expo-blur';
import { GlassView, isLiquidGlassAvailable } from 'expo-glass-effect';
import * as Haptics from 'expo-haptics';
import { useColors } from '@/hooks/useColors';
import { useScheme } from '@/hooks/useScheme';
import { useDesktop } from '@/hooks/useDesktop';
import { fonts } from '@/constants/colors';
import { withAlpha } from '@/lib/color';
import { isHovered } from '@/lib/web';

const liquidGlass = Platform.OS === 'ios' && isLiquidGlassAvailable();

/**
 * The composer surface: real Liquid Glass on modern iOS, a backdrop-blur
 * material on other iOS and web, and a solid linen card on Android.
 */
function ComposerSurface({
  children,
  clear = false,
}: {
  children: React.ReactNode;
  /**
   * Media-backed surfaces (the ambient-video home screen) ask for the
   * clear treatment: Apple's `clear` Liquid Glass variant, made for
   * sitting over motion, and a lighter wash on the fallback materials.
   */
  clear?: boolean;
}) {
  const colors = useColors();
  const scheme = useScheme();
  const desktop = useDesktop();

  if (liquidGlass) {
    // Interactive glass is what gives Liquid Glass its visible presence
    // (rim lighting + touch shimmer) — the same treatment the system
    // composer in Messages uses. Children sit above the effect view, so
    // the text field and buttons receive touches as usual.
    return (
      <GlassView
        glassEffectStyle={clear ? 'clear' : 'regular'}
        isInteractive
        // Pinned so the composer can't flip appearance when a bright
        // patch of the ambient video passes beneath it.
        colorScheme={scheme}
        style={styles.container}
      >
        {children}
      </GlassView>
    );
  }
  if (Platform.OS === 'ios' || Platform.OS === 'web') {
    return (
      <View
        style={[
          styles.container,
          styles.clip,
          clear && desktop
            ? {
                // iOS-style glass rim: instead of a solid darker hairline,
                // a bright translucent white edge plus inset highlights —
                // a strong shine along the top lip that fades down the
                // sides, and a faint lower catch-light — so the box reads
                // like a lit pane of glass over the ambient shadow.
                borderWidth: 1,
                borderColor:
                  scheme === 'dark'
                    ? 'rgba(255,255,255,0.35)'
                    : 'rgba(255,255,255,0.7)',
                // A soft outer drop shadow lifts the pane off the linen
                // so it pops against the ambient shadow, layered under the
                // inset rim highlights that give it the glass shine.
                boxShadow:
                  '0 10px 48px rgba(60,50,38,0.09), 0 2px 20px rgba(60,50,38,0.05), inset 0 1px 1px rgba(255,255,255,0.9), inset 0 8px 18px rgba(255,255,255,0.18), inset 0 -1px 1px rgba(255,255,255,0.25)',
              }
            : {
                borderWidth: StyleSheet.hairlineWidth,
                borderColor: colors.border,
              },
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
              // Light enough a wash that the ambient shadow drifts
              // visibly through the glass, heavy enough that the
              // question text stays crisp against it. Desktop web has
              // no working backdrop blur, so the clear composer leans
              // even thinner there — and washes toward bright white
              // rather than linen so the box reads like lit glass while
              // the landscape shadow stays clearly visible behind it.
              backgroundColor:
                clear && desktop
                  ? withAlpha(
                      scheme === 'dark' ? '#f5f3ee' : '#ffffff',
                      scheme === 'dark' ? 0.28 : 0.42,
                    )
                  : withAlpha(
                      colors.card,
                      clear
                        ? scheme === 'dark'
                          ? 0.22
                          : 0.3
                        : scheme === 'dark'
                          ? 0.42
                          : 0.55,
                    ),
            },
          ]}
        />
        {children}
      </View>
    );
  }
  return (
    <View
      style={[
        styles.container,
        {
          // Android has no backdrop blur here — a translucent linen
          // fill lets the ambient video ghost through instead.
          backgroundColor: withAlpha(colors.card, clear ? 0.72 : 1),
          borderWidth: 1,
          borderColor: colors.border,
        },
      ]}
    >
      {children}
    </View>
  );
}

/**
 * The shared composer: one compact bar on every platform — the question
 * field and the circular emerald send button side by side, the card
 * hugging the button with the same 12px breathing room on every side.
 */
export function ChatInput({
  onSend,
  sending,
  placeholder = "What's on your heart?",
  autoFocus = false,
  onFocusChange,
  inputRef,
  clearGlass = false,
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
}) {
  const colors = useColors();
  const [text, setText] = useState('');
  // Web autogrow: react-native-web's <textarea> keeps its browser
  // default height instead of sizing to content, so on web the bar
  // tracks content height itself — 42 (one line, matching the send
  // button) up to the shared 110 cap. Native multiline autogrows on
  // its own.
  const [inputHeight, setInputHeight] = useState(42);
  const canSend = text.trim().length > 0 && !sending;

  const submit = () => {
    if (!canSend) return;
    if (Platform.OS !== 'web') {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    }
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
      placeholderTextColor={colors.heroInk}
      style={[
        styles.input,
        Platform.OS === 'web' && styles.inputWeb,
        Platform.OS === 'web' && { height: inputHeight },
        { color: colors.cardForeground },
      ]}
      multiline
      autoFocus={autoFocus}
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
      onFocus={() => onFocusChange?.(true)}
      onBlur={() => onFocusChange?.(false)}
      testID="chat-input"
    />
  );

  const sendButton = (
    <Pressable
      onPress={submit}
      disabled={!canSend}
      testID="chat-send"
      style={(state) => [
        styles.sendButton,
        {
          backgroundColor: canSend ? colors.primary : colors.muted,
          opacity:
            state.pressed && canSend
              ? 0.85
              : isHovered(state) && canSend
                ? 0.9
                : 1,
          cursor: canSend ? 'pointer' : 'auto',
        },
      ]}
    >
      {sending ? (
        <ActivityIndicator size="small" color={colors.primaryForeground} />
      ) : (
        <Feather
          name="arrow-up"
          size={19}
          color={canSend ? colors.primaryForeground : colors.mutedForeground}
        />
      )}
    </Pressable>
  );

  // Field and send button share one bottom-aligned row, so the button
  // stays pinned to the corner while long questions grow the field
  // toward its cap.
  return (
    <ComposerSurface clear={clearGlass}>
      <View style={styles.row}>
        {field}
        {sendButton}
      </View>
    </ComposerSurface>
  );
}

const styles = StyleSheet.create({
  // The compact bar: send button 42 + 12 above and below = 66 tall at
  // rest, a true pill.
  container: {
    borderRadius: 33,
    paddingHorizontal: 12,
    paddingTop: 12,
    paddingBottom: 12,
  },
  clip: {
    overflow: 'hidden',
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
    paddingHorizontal: 4,
    ...(Platform.OS === 'web' ? ({ outlineStyle: 'none' } as object) : {}),
  },
  // Web sizes the field against its tracked height; 11 + 20 + 11 keeps
  // a single line at exactly 42 — the send button's height.
  inputWeb: {
    paddingVertical: 11,
    lineHeight: 20,
  },
  sendButton: {
    width: 42,
    height: 42,
    borderRadius: 21,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
