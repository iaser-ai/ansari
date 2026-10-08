import React, { useEffect, useId, useState } from 'react';
import {
  ActivityIndicator,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useReanimatedKeyboardAnimation } from 'react-native-keyboard-controller';
import Animated, {
  FadeIn,
  ReduceMotion,
  useAnimatedStyle,
} from 'react-native-reanimated';
import { useColors } from '@/hooks/useColors';
import { useScheme } from '@/hooks/useScheme';
import { fonts } from '@/constants/colors';
import { DURATION, EASE_OUT } from '@/constants/motion';
import { RADIUS, rounded } from '@/constants/radius';
import { isHovered, touchBrowser } from '@/lib/web';
import { heading, selfInkedFocusId } from '@/lib/semantics';
import { useAuth } from '@/lib/auth/context';
import {
  closeAuthSheet,
  setAuthSheetMode,
  useAuthSheet,
  type AuthMode,
} from '@/lib/authSheet';
import { AnsariMarkBrass } from '@/components/AnsariMarkBrass';
import { AppleMark, GoogleMark } from '@/components/BrandMarks';
import { PressableScale } from '@/components/PressableScale';
import { Sheet } from '@/components/Sheet';

// Turning between "Log in" and "Sign up" is the same card showing its
// other face: what changes fades in where it stands, nothing travels.
const FACE_ENTER = FadeIn.duration(DURATION.state)
  .easing(EASE_OUT)
  .reduceMotion(ReduceMotion.System);

type Provider = 'Apple' | 'Google';

/**
 * One field, in the app's recessed-bed style: `inputFill` under a
 * hairline that inks on focus rather than drawing a ring outside it —
 * the same treatment `SearchField` wears, so every place a reader types
 * in this app looks like the same place.
 */
function Field({
  label,
  value,
  onChangeText,
  ...input
}: {
  label: string;
  value: string;
  onChangeText: (next: string) => void;
} & React.ComponentProps<typeof TextInput>) {
  const colors = useColors();
  const fieldKey = useId();
  const [focused, setFocused] = useState(false);
  return (
    <View
      style={[
        styles.field,
        {
          backgroundColor: colors.inputFill,
          borderColor: focused ? colors.inputRimFocus : colors.inputRim,
        },
      ]}
    >
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={label}
        placeholderTextColor={colors.placeholder}
        cursorColor={colors.caret}
        selectionColor={colors.caret}
        nativeID={selfInkedFocusId(fieldKey)}
        accessibilityLabel={label}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        style={[
          styles.input,
          {
            // Mobile Safari magnifies the page around any field with a
            // sub-16px face; carry 16px on a phone browser (see
            // `SearchField` for the same guard).
            fontSize: touchBrowser ? 16 : 15.5,
            color: colors.foreground,
          },
        ]}
        {...input}
      />
    </View>
  );
}

/**
 * The platform's own sign-in button, in the platform's own dress — not
 * two copies of one generic button with different words on them.
 *
 * Apple (Human Interface Guidelines): a solid pill, black by day and
 * white at night, with the mark and label in the opposite colour.
 * Google (sign-in branding guidelines): the light button is white with
 * a `#747775` outline and `#1F1F1F` label; the dark one is `#131314`
 * with a `#8E918F` outline and `#E3E3E3` label; the "G" stays in full
 * colour on both.
 */
function ProviderButton({
  provider,
  onPress,
}: {
  provider: Provider;
  onPress: () => void;
}) {
  const dark = useScheme() === 'dark';
  const look =
    provider === 'Apple'
      ? dark
        ? { fill: '#FFFFFF', rim: '#FFFFFF', ink: '#000000' }
        : { fill: '#000000', rim: '#000000', ink: '#FFFFFF' }
      : dark
        ? { fill: '#131314', rim: '#8E918F', ink: '#E3E3E3' }
        : { fill: '#FFFFFF', rim: '#747775', ink: '#1F1F1F' };
  const label = `Continue with ${provider}`;
  return (
    <PressableScale
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      testID={`auth-${provider.toLowerCase()}`}
      style={(state) => [
        styles.provider,
        {
          backgroundColor: look.fill,
          borderColor: look.rim,
          opacity: state.pressed ? 0.8 : isHovered(state) ? 0.92 : 1,
        },
      ]}
    >
      <View style={styles.providerMark}>
        {provider === 'Apple' ? (
          <AppleMark size={18} color={look.ink} />
        ) : (
          <GoogleMark size={18} />
        )}
      </View>
      <Text style={[styles.providerText, { color: look.ink }]}>{label}</Text>
    </PressableScale>
  );
}

/**
 * Lifts the bottom of the card clear of the keyboard on native.
 *
 * The sheet is anchored to the bottom edge, so growing its foot by the
 * keyboard's height carries every field above it, in step with the
 * keyboard's own animation. The safe-area pad the sheet already keeps
 * at its foot sits under the keyboard, so it is not counted twice.
 *
 * The web needs none of this: its keyboard is handled by the shell (see
 * `hooks/useKeyboard.web.ts`), and the controller's web build reports
 * no keyboard at all.
 */
function KeyboardFoot() {
  const insets = useSafeAreaInsets();
  const { height } = useReanimatedKeyboardAnimation();
  const style = useAnimatedStyle(() => ({
    height: Math.max(0, -height.value - insets.bottom),
  }));
  if (Platform.OS === 'web') return null;
  return <Animated.View style={style} />;
}

/**
 * Sign in and sign up, raised over whatever the reader was looking at
 * rather than taking them away from it.
 *
 * Built on `Sheet`, so it arrives the way every other overlay in the
 * app does: a bottom sheet with a grabber on a phone, pulled down or
 * flicked away to dismiss; a centred dialog on desktop; the same scrim,
 * the same focus trap, the same Escape.
 *
 * Mounted once by the root layout and driven by `lib/authSheet`, so the
 * account corner, the rail's footer and the `/login` / `/register`
 * links all raise this one card. "Log in" ↔ "Sign up" turns the card to
 * its other face in place — the fields keep what was typed in them.
 *
 * Apple and Google lead, Apple first (Apple's own rule, and common
 * practice wherever both are offered), above a rule that hands the rest
 * of the card to email. They are presentational for now: no provider is
 * wired up, so pressing one says so, in the card, rather than pretending
 * to sign anyone in.
 *
 * On success the card simply goes away and the reader is where they
 * were. Where a reader should land after signing in is left to the pass
 * that wires real third-party sign-in (#245).
 */
export function AuthSheet() {
  const colors = useColors();
  const mode = useAuthSheet();
  const open = mode !== null;
  const { login, register, loginAsGuest } = useAuth();

  // Held past the store clearing, so the card still has a face to show
  // while it leaves.
  const [shown, setShown] = useState<AuthMode | null>(null);
  useEffect(() => {
    if (mode) setShown(mode);
  }, [mode]);

  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState<Provider | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Gone means gone: the next time the card is raised it starts clean,
  // and a password never outlives the card it was typed into.
  const reset = () => {
    setShown(null);
    setFirstName('');
    setLastName('');
    setEmail('');
    setPassword('');
    setError(null);
    setUnavailable(null);
    setSubmitting(false);
  };

  if (!shown) return null;

  const isRegister = shown === 'register';

  const switchFace = () => {
    setError(null);
    setAuthSheetMode(isRegister ? 'login' : 'register');
  };

  const submit = async () => {
    if (submitting) return;
    setError(null);
    const trimmedEmail = email.trim();
    if (!trimmedEmail || !password) {
      setError('Enter your email and password.');
      return;
    }
    if (isRegister && password.length < 8) {
      setError('Password must be at least 8 characters.');
      return;
    }
    setSubmitting(true);
    try {
      if (isRegister) {
        await register({
          email: trimmedEmail,
          password,
          firstName: firstName.trim() || undefined,
          lastName: lastName.trim() || undefined,
        });
      } else {
        await login(trimmedEmail, password);
      }
      closeAuthSheet();
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : 'Something went wrong. Please try again.',
      );
      setSubmitting(false);
    }
  };

  // Continue as guest — reuses this device's guest account if it has
  // one, else registers a fresh throwaway.
  const continueAsGuest = async () => {
    if (submitting) return;
    setError(null);
    setSubmitting(true);
    try {
      await loginAsGuest();
      closeAuthSheet();
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "Couldn't start a guest session. Please try again.",
      );
      setSubmitting(false);
    }
  };

  const title = isRegister ? 'Create your account' : 'Welcome back';

  const header = (
    <View style={styles.header}>
      <View style={styles.headerText}>
        <AnsariMarkBrass height={30} />
        <Animated.Text
          key={shown}
          entering={FACE_ENTER}
          {...heading(2)}
          style={[styles.title, { color: colors.strongForeground }]}
        >
          {title}
        </Animated.Text>
        <Text style={[styles.subtitle, { color: colors.mutedForeground }]}>
          {isRegister
            ? 'Keep your questions and their sources with you, across devices.'
            : 'Pick up your questions where you left them.'}
        </Text>
      </View>
      <PressableScale
        onPress={closeAuthSheet}
        hitSlop={8}
        style={(state) => [
          styles.closeButton,
          {
            backgroundColor: colors.lifted,
            opacity: state.pressed ? 0.6 : isHovered(state) ? 0.8 : 1,
          },
        ]}
        testID="auth-close"
        accessibilityRole="button"
        accessibilityLabel="Close"
      >
        <Feather name="x" size={17} color={colors.mutedForeground} />
      </PressableScale>
    </View>
  );

  return (
    <Sheet
      open={open}
      onClose={closeAuthSheet}
      onExited={reset}
      style={styles.sheet}
      dialogStyle={styles.dialog}
      accessibilityViewIsModal
      accessibilityLabel={title}
      fitToShell
      header={header}
    >
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.body}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.providers}>
          <ProviderButton
            provider="Apple"
            onPress={() => setUnavailable('Apple')}
          />
          <ProviderButton
            provider="Google"
            onPress={() => setUnavailable('Google')}
          />
          {unavailable && (
            <Text
              accessibilityLiveRegion="polite"
              aria-live="polite"
              style={[styles.note, { color: colors.mutedForeground }]}
              testID="auth-provider-unavailable"
            >
              Sign in with {unavailable} isn&apos;t available yet. Use your
              email below.
            </Text>
          )}
        </View>

        <View style={styles.dividerRow}>
          <View
            style={[styles.dividerLine, { backgroundColor: colors.border }]}
          />
          <Text style={[styles.dividerText, { color: colors.mutedForeground }]}>
            or continue with email
          </Text>
          <View
            style={[styles.dividerLine, { backgroundColor: colors.border }]}
          />
        </View>

        {isRegister && (
          <Animated.View entering={FACE_ENTER} style={styles.nameRow}>
            <View style={styles.nameField}>
              <Field
                label="First name"
                value={firstName}
                onChangeText={setFirstName}
                autoCapitalize="words"
                autoComplete="name-given"
                testID="first-name-input"
              />
            </View>
            <View style={styles.nameField}>
              <Field
                label="Last name"
                value={lastName}
                onChangeText={setLastName}
                autoCapitalize="words"
                autoComplete="name-family"
                testID="last-name-input"
              />
            </View>
          </Animated.View>
        )}
        <Field
          label="Email"
          value={email}
          onChangeText={setEmail}
          autoCapitalize="none"
          autoComplete="email"
          keyboardType="email-address"
          inputMode="email"
          testID="email-input"
        />
        <Field
          label={isRegister ? 'Password (min 8 characters)' : 'Password'}
          value={password}
          onChangeText={setPassword}
          secureTextEntry
          autoCapitalize="none"
          autoComplete={isRegister ? 'new-password' : 'current-password'}
          onSubmitEditing={submit}
          returnKeyType="go"
          testID="password-input"
        />

        {error && (
          <Text
            style={[styles.error, { color: colors.destructive }]}
            testID="auth-error"
          >
            {error}
          </Text>
        )}

        <PressableScale
          onPress={submit}
          disabled={submitting}
          accessibilityRole="button"
          testID="auth-submit"
          style={(state) => [
            styles.button,
            {
              backgroundColor: colors.primary,
              opacity: submitting ? 0.7 : state.pressed ? 0.85 : 1,
            },
          ]}
        >
          {submitting ? (
            <ActivityIndicator color={colors.primaryForeground} />
          ) : (
            <Text
              style={[styles.buttonText, { color: colors.primaryForeground }]}
            >
              {isRegister ? 'Create account' : 'Log in'}
            </Text>
          )}
        </PressableScale>

        <View style={styles.footer}>
          <PressableScale
            onPress={switchFace}
            accessibilityRole="button"
            testID="auth-switch"
            style={styles.footerLink}
          >
            <Text
              style={[styles.footerText, { color: colors.mutedForeground }]}
            >
              {isRegister ? 'Already have an account? ' : 'New to Ansari? '}
              <Text
                style={{
                  color: colors.foreground,
                  fontFamily: fonts.bodySemiBold,
                }}
              >
                {isRegister ? 'Log in' : 'Create an account'}
              </Text>
            </Text>
          </PressableScale>
          <PressableScale
            onPress={continueAsGuest}
            disabled={submitting}
            accessibilityRole="button"
            testID="auth-guest"
            style={(state) => [
              styles.footerLink,
              { opacity: submitting ? 0.6 : state.pressed ? 0.7 : 1 },
            ]}
          >
            <Text
              style={[styles.footerText, { color: colors.mutedForeground }]}
            >
              or{' '}
              <Text
                style={{
                  color: colors.foreground,
                  fontFamily: fonts.bodyMedium,
                  textDecorationLine: 'underline',
                }}
              >
                continue as a guest
              </Text>
            </Text>
          </PressableScale>
        </View>
      </ScrollView>
      <KeyboardFoot />
    </Sheet>
  );
}

const styles = StyleSheet.create({
  // A phone sheet is sized by what is in it; the scroller only gives way
  // once the sheet meets its ceiling (see `Sheet`'s `sheetCap`).
  sheet: {
    flexShrink: 1,
  },
  dialog: {
    maxWidth: 420,
    paddingHorizontal: 28,
    paddingTop: 26,
  },
  scroll: {
    flexShrink: 1,
  },
  body: {
    gap: 12,
    paddingTop: 6,
    paddingBottom: 4,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'flex-start',
  },
  headerText: {
    flex: 1,
    alignItems: 'center',
    gap: 8,
    // Balances the close button on the right so the title sits on the
    // card's centre line, not the text column's.
    paddingLeft: 30,
  },
  title: {
    fontSize: 23,
    lineHeight: 30,
    fontFamily: fonts.display,
    textAlign: 'center',
    marginTop: 2,
  },
  subtitle: {
    fontSize: 13.5,
    lineHeight: 19,
    fontFamily: fonts.body,
    textAlign: 'center',
    maxWidth: 300,
  },
  closeButton: {
    width: 30,
    height: 30,
    alignItems: 'center',
    justifyContent: 'center',
    ...rounded(RADIUS.pill),
  },
  providers: {
    gap: 10,
  },
  provider: {
    minHeight: 50,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    borderWidth: 1,
    ...rounded(RADIUS.pill),
  },
  providerMark: {
    width: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  providerText: {
    fontSize: 15.5,
    fontFamily: fonts.bodyMedium,
  },
  note: {
    fontSize: 13,
    lineHeight: 18,
    fontFamily: fonts.body,
    textAlign: 'center',
  },
  dividerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginVertical: 4,
  },
  dividerLine: {
    flex: 1,
    height: StyleSheet.hairlineWidth,
  },
  dividerText: {
    fontSize: 12.5,
    fontFamily: fonts.body,
  },
  nameRow: {
    flexDirection: 'row',
    gap: 12,
  },
  nameField: {
    flex: 1,
  },
  field: {
    minHeight: 50,
    justifyContent: 'center',
    paddingHorizontal: 15,
    ...rounded(RADIUS.md),
    borderWidth: StyleSheet.hairlineWidth,
  },
  input: {
    fontFamily: fonts.body,
    // The bed carries the vertical centring; the field keeps no line
    // padding of its own so a 16px browser face still sits centred.
    paddingVertical: 0,
  },
  error: {
    fontSize: 13.5,
    lineHeight: 19,
    fontFamily: fonts.bodyMedium,
    marginTop: 2,
  },
  button: {
    minHeight: 50,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 4,
    ...rounded(RADIUS.md),
  },
  buttonText: {
    fontSize: 15.5,
    fontFamily: fonts.bodySemiBold,
  },
  footer: {
    alignItems: 'center',
    marginTop: 2,
  },
  footerLink: {
    alignItems: 'center',
    paddingVertical: 7,
  },
  footerText: {
    fontSize: 14,
    fontFamily: fonts.body,
    textAlign: 'center',
  },
});
