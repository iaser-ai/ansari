import React, { useId, useState } from 'react';
import {
  ActivityIndicator,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';
import { router } from 'expo-router';
import Head from 'expo-router/head';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Animated, { FadeIn, ReduceMotion } from 'react-native-reanimated';
import { useColors } from '@/hooks/useColors';
import { useDesktop } from '@/hooks/useDesktop';
import { fonts } from '@/constants/colors';
import { phoneGutter } from '@/constants/layout';
import { DURATION, EASE_OUT } from '@/constants/motion';
import { RADIUS, rounded } from '@/constants/radius';
import { touchBrowser } from '@/lib/web';
import { heading, selfInkedFocusId } from '@/lib/semantics';
import { useScreenLandmark } from '@/hooks/useScreenLandmark';
import { useAuth } from '@/lib/auth/context';
import { AnsariMarkBrass } from '@/components/AnsariMarkBrass';
import { KeyboardAvoidingViewCompat } from '@/components/KeyboardAvoidingViewCompat';
import { PressableScale } from '@/components/PressableScale';

type Mode = 'login' | 'register';

// The form settles onto the shared paper with one fade, no travel — a
// page to fill in, not a sequence to watch.
const PAGE_ENTER = FadeIn.duration(DURATION.enter)
  .easing(EASE_OUT)
  .reduceMotion(ReduceMotion.System);

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
 * Register and login share one presentational form, set in the app's
 * dark-mode token language: the brass mark, the serif display voice for
 * the title, fields in the recessed-bed style, an inked primary button.
 *
 * It draws straight onto the shared paper mounted by `AppFrame` — no
 * `PaperBackground` of its own — and on a signed-in status flip the
 * layout's route stack is already showing the app, so this just needs
 * to `router.replace('/')`. Errors are reported inline; the auth API
 * surfaces a human message via `AuthError`.
 */
export function AuthForm({ mode }: { mode: Mode }) {
  const colors = useColors();
  const desktop = useDesktop();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const screenLandmark = useScreenLandmark();
  const { login, register, loginAsGuest } = useAuth();

  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const isRegister = mode === 'register';
  // A phone reads the form at the page's own gutter; a desktop centres a
  // fixed column (see `scrollDesktop`) and needs no side air here.
  const gutter = phoneGutter(width);

  const done = () => router.replace('/');

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
      done();
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
      done();
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "Couldn't start a guest session. Please try again.",
      );
      setSubmitting(false);
    }
  };

  return (
    <Animated.View style={styles.flex} entering={PAGE_ENTER}>
      {Platform.OS === 'web' && (
        <Head>
          <title>
            {isRegister ? 'Create your account — Ansari' : 'Log in — Ansari'}
          </title>
        </Head>
      )}
      <KeyboardAvoidingViewCompat style={styles.flex}>
        <ScrollView
          contentContainerStyle={[
            styles.scroll,
            {
              paddingTop: insets.top + 56,
              paddingBottom: insets.bottom + 28,
              paddingHorizontal: desktop ? 0 : gutter,
            },
            desktop && styles.scrollDesktop,
          ]}
          keyboardShouldPersistTaps="handled"
          {...screenLandmark}
        >
          <View style={styles.header}>
            <AnsariMarkBrass height={desktop ? 44 : 40} />
            <Text
              {...heading(1)}
              style={[
                desktop ? styles.titleDesktop : styles.title,
                { color: colors.strongForeground },
              ]}
            >
              {isRegister ? 'Create your account' : 'Welcome back'}
            </Text>
            <Text
              style={[styles.subtitle, { color: colors.mutedForeground }]}
            >
              {isRegister
                ? 'Sign in to keep your questions and their sources with you, across devices.'
                : 'Sign in to pick up your questions where you left them.'}
            </Text>
          </View>

          <View style={styles.fields}>
            {isRegister && (
              <View style={styles.nameRow}>
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
              </View>
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
                  style={[
                    styles.buttonText,
                    { color: colors.primaryForeground },
                  ]}
                >
                  {isRegister ? 'Create account' : 'Log in'}
                </Text>
              )}
            </PressableScale>

            <View style={styles.dividerRow}>
              <View
                style={[styles.dividerLine, { backgroundColor: colors.border }]}
              />
              <Text
                style={[styles.dividerText, { color: colors.mutedForeground }]}
              >
                or
              </Text>
              <View
                style={[styles.dividerLine, { backgroundColor: colors.border }]}
              />
            </View>

            <PressableScale
              onPress={continueAsGuest}
              disabled={submitting}
              accessibilityRole="button"
              testID="auth-guest"
              style={(state) => [
                styles.guestButton,
                {
                  borderColor: colors.border,
                  backgroundColor: colors.card,
                  opacity: submitting ? 0.6 : state.pressed ? 0.85 : 1,
                },
              ]}
            >
              <Text style={[styles.guestText, { color: colors.foreground }]}>
                Continue as guest
              </Text>
            </PressableScale>

            <PressableScale
              onPress={() =>
                router.replace(isRegister ? '/login' : '/register')
              }
              accessibilityRole="button"
              testID="auth-switch"
              style={styles.switch}
            >
              <Text
                style={[styles.switchText, { color: colors.mutedForeground }]}
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
          </View>
        </ScrollView>
      </KeyboardAvoidingViewCompat>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  scroll: {
    flexGrow: 1,
    justifyContent: 'center',
  },
  scrollDesktop: {
    width: '100%',
    maxWidth: 420,
    alignSelf: 'center',
  },
  header: {
    alignItems: 'center',
    gap: 12,
    marginBottom: 30,
  },
  title: {
    fontSize: 24,
    lineHeight: 31,
    fontFamily: fonts.display,
    textAlign: 'center',
    marginTop: 4,
  },
  titleDesktop: {
    fontSize: 27,
    lineHeight: 34,
    fontFamily: fonts.display,
    textAlign: 'center',
    marginTop: 4,
  },
  subtitle: {
    fontSize: 14,
    lineHeight: 20,
    fontFamily: fonts.body,
    textAlign: 'center',
    maxWidth: 320,
  },
  fields: {
    gap: 12,
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
    marginTop: 6,
    ...rounded(RADIUS.md),
  },
  buttonText: {
    fontSize: 15.5,
    fontFamily: fonts.bodySemiBold,
  },
  dividerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginTop: 6,
  },
  dividerLine: {
    flex: 1,
    height: StyleSheet.hairlineWidth,
  },
  dividerText: {
    fontSize: 13,
    fontFamily: fonts.body,
  },
  guestButton: {
    minHeight: 50,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    ...rounded(RADIUS.md),
  },
  guestText: {
    fontSize: 15.5,
    fontFamily: fonts.bodyMedium,
  },
  switch: {
    alignItems: 'center',
    paddingVertical: 12,
    marginTop: 4,
  },
  switchText: {
    fontSize: 14,
    fontFamily: fonts.body,
  },
});
