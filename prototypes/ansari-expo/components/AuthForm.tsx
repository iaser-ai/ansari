import React, { useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { router } from 'expo-router';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useColors } from '@/hooks/useColors';
import { fonts } from '@/constants/colors';
import { screenInsets } from '@/lib/insets';
import { isHovered } from '@/lib/web';
import { AnsariWordmark } from '@/components/AnsariWordmark';
import { PaperBackground } from '@/components/PaperBackground';
import { useAuth } from '@/lib/auth/context';

type Mode = 'login' | 'register';

/**
 * Register and login share one presentational form. Both keep the prototype's
 * visual language (paper, wordmark, StyleSheet). On success the auth status flips
 * to `signedIn` and the root layout's route guard redirects to the app; this
 * component only reports errors inline.
 */
export function AuthForm({ mode }: { mode: Mode }) {
  const colors = useColors();
  const insets = screenInsets(useSafeAreaInsets());
  const { login, register } = useAuth();

  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const isRegister = mode === 'register';

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
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : 'Something went wrong. Please try again.',
      );
      setSubmitting(false);
    }
  };

  const inputStyle = [
    styles.input,
    {
      backgroundColor: colors.card,
      borderColor: colors.input,
      color: colors.foreground,
      borderRadius: colors.radius,
    },
  ];

  return (
    <PaperBackground>
      <KeyboardAvoidingView style={styles.flex} behavior="padding">
        <ScrollView
          contentContainerStyle={[
            styles.scroll,
            { paddingTop: insets.top + 48, paddingBottom: insets.bottom + 24 },
          ]}
          keyboardShouldPersistTaps="handled"
        >
          <View style={styles.header}>
            <AnsariWordmark width={150} color={colors.heroInk} />
            <Text style={[styles.title, { color: colors.foreground }]}>
              {isRegister ? 'Create your account' : 'Welcome back'}
            </Text>
            {isRegister && (
              <Text style={[styles.subtitle, { color: colors.mutedForeground }]}>
                This creates a real account on the Ansari staging server.
              </Text>
            )}
          </View>

          <View style={styles.fields}>
            {isRegister && (
              <View style={styles.nameRow}>
                <TextInput
                  style={[inputStyle, styles.nameField]}
                  placeholder="First name"
                  placeholderTextColor={colors.mutedForeground}
                  autoCapitalize="words"
                  value={firstName}
                  onChangeText={setFirstName}
                  testID="first-name-input"
                />
                <TextInput
                  style={[inputStyle, styles.nameField]}
                  placeholder="Last name"
                  placeholderTextColor={colors.mutedForeground}
                  autoCapitalize="words"
                  value={lastName}
                  onChangeText={setLastName}
                  testID="last-name-input"
                />
              </View>
            )}
            <TextInput
              style={inputStyle}
              placeholder="Email"
              placeholderTextColor={colors.mutedForeground}
              autoCapitalize="none"
              autoComplete="email"
              keyboardType="email-address"
              inputMode="email"
              value={email}
              onChangeText={setEmail}
              testID="email-input"
            />
            <TextInput
              style={inputStyle}
              placeholder={isRegister ? 'Password (min 8 characters)' : 'Password'}
              placeholderTextColor={colors.mutedForeground}
              secureTextEntry
              autoCapitalize="none"
              value={password}
              onChangeText={setPassword}
              onSubmitEditing={submit}
              returnKeyType="go"
              testID="password-input"
            />

            {error && (
              <Text style={[styles.error, { color: colors.destructive }]} testID="auth-error">
                {error}
              </Text>
            )}

            <Pressable
              onPress={submit}
              disabled={submitting}
              testID="auth-submit"
              style={(state) => [
                styles.button,
                {
                  backgroundColor: colors.primary,
                  borderRadius: colors.radius,
                  opacity: submitting
                    ? 0.7
                    : state.pressed
                      ? 0.85
                      : isHovered(state)
                        ? 0.92
                        : 1,
                },
              ]}
            >
              {submitting ? (
                <ActivityIndicator color={colors.primaryForeground} />
              ) : (
                <Text style={[styles.buttonText, { color: colors.primaryForeground }]}>
                  {isRegister ? 'Create account' : 'Log in'}
                </Text>
              )}
            </Pressable>

            <Pressable
              onPress={() => router.replace(isRegister ? '/login' : '/register')}
              style={styles.switch}
              testID="auth-switch"
            >
              <Text style={[styles.switchText, { color: colors.mutedForeground }]}>
                {isRegister ? 'Already have an account? ' : 'New to Ansari? '}
                <Text style={{ color: colors.primary, fontFamily: fonts.bodySemiBold }}>
                  {isRegister ? 'Log in' : 'Create an account'}
                </Text>
              </Text>
            </Pressable>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </PaperBackground>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  scroll: {
    flexGrow: 1,
    paddingHorizontal: 24,
    justifyContent: 'center',
    maxWidth: 460,
    width: '100%',
    alignSelf: 'center',
  },
  header: {
    alignItems: 'center',
    gap: 10,
    marginBottom: 28,
  },
  title: {
    fontSize: 22,
    fontFamily: fonts.displayMedium,
    marginTop: 6,
  },
  subtitle: {
    fontSize: 13.5,
    lineHeight: 19,
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
  input: {
    height: 50,
    paddingHorizontal: 16,
    fontSize: 15.5,
    fontFamily: fonts.body,
    borderWidth: StyleSheet.hairlineWidth,
  },
  error: {
    fontSize: 14,
    lineHeight: 19,
    fontFamily: fonts.bodyMedium,
    marginTop: 2,
  },
  button: {
    height: 50,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 6,
  },
  buttonText: {
    fontSize: 15.5,
    fontFamily: fonts.bodySemiBold,
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
