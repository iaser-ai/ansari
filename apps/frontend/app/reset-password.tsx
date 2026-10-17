import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Text } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useColors } from '@/hooks/useColors';
import { authApi } from '@/lib/auth/client';
import { AuthError, INVALID_RESET_TOKEN_MESSAGE } from '@/lib/auth/api';
import { useAuth } from '@/lib/auth/context';
import { handOverResetToken, peekResetToken, takeResetToken } from '@/lib/auth/reset-token';
import { openAuthSheet } from '@/lib/authSheet';
import { Field } from '@/components/AuthField';
import { AuthPage, authPageStyles as styles } from '@/components/AuthPage';
import { PressableScale } from '@/components/PressableScale';

/**
 * - form: a token is in hand.
 * - done: the password was changed.
 * - invalid: apps/auth refused the token (unknown, expired or already used).
 * - missing: no token reached this page (a reload, or a later visit).
 */
type Outcome = 'form' | 'done' | 'invalid' | 'missing';

const UNREACHABLE = "Ansari can't be reached right now. Please try again shortly.";

/**
 * `/reset-password?token=…` (#304): the page the reset email links to, on
 * the web directly and on native through the `ansarichat` scheme. The path
 * and the `token` query are fixed by apps/auth's email and by the released
 * app, which link here; neither may change. It is a public page
 * (`isPublicPath`): opening it never provisions a guest.
 *
 * The token is a credential and never sits in a URL once the app has it
 * (`lib/auth/reset-token.ts`): on the web the app entry moves it into memory
 * before expo-router loads; on native the link's page hands it over and
 * replaces itself with a clean `/reset-password`. The clean page takes it on
 * mount, which empties the slot. It is never logged.
 *
 * A reset ends every session of the account (apps/auth), so success does
 * not sign anyone in here: it sends the reader to sign in with the new
 * password. If this device holds a real account's session, it is checked at
 * once and dropped locally if the reset killed it.
 */
export default function ResetPasswordScreen() {
  const colors = useColors();
  const { checkSession } = useAuth();
  const params = useLocalSearchParams<{ token?: string | string[] }>();
  const fromLink = (Array.isArray(params.token) ? params.token[0] : params.token)?.trim() || null;
  const linkPage = params.token !== undefined;
  const [token] = useState(() => fromLink ?? peekResetToken());
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>(token ? 'form' : 'missing');

  useEffect(() => {
    if (linkPage) {
      // Native: the link's page hands the token over to the clean page.
      handOverResetToken(fromLink);
      router.replace('/reset-password');
    } else {
      // The clean page has the token in state; nothing else keeps it.
      takeResetToken();
    }
    // Once, on arrival.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submit = async () => {
    if (submitting || !token) return;
    setError(null);
    if (password.length < 8) {
      setError('Password must be at least 8 characters.');
      return;
    }
    if (password !== confirm) {
      setError('The two passwords do not match.');
      return;
    }
    setSubmitting(true);
    try {
      await authApi.resetPassword(token, password);
      setOutcome('done');
      // The reset ended every session of the account. If this device was
      // signed in as it, drop that session now rather than when it next 401s.
      void checkSession();
    } catch (e) {
      if (e instanceof AuthError && e.status === 400 && e.message === INVALID_RESET_TOKEN_MESSAGE) {
        setOutcome('invalid');
      } else if (e instanceof AuthError && (e.status === 0 || e.status >= 500)) {
        setError(UNREACHABLE);
      } else {
        setError(e instanceof AuthError ? e.message : 'Something went wrong. Please try again.');
      }
    } finally {
      setSubmitting(false);
    }
  };

  const signIn = () => {
    openAuthSheet('login');
    router.replace('/');
  };

  // The link's page only hands the token over; the clean page shows the form.
  if (linkPage) return null;

  if (outcome === 'done') {
    return (
      <AuthPage
        documentTitle="Password changed · Ansari"
        title="Password changed"
        subtitle="You've been signed out everywhere. Sign in with your new password."
      >
        <PrimaryButton label="Log in" onPress={signIn} testID="reset-sign-in" />
      </AuthPage>
    );
  }

  if (outcome === 'missing') {
    return (
      <AuthPage
        documentTitle="Reset your password · Ansari"
        title="Open your reset link"
        subtitle="Open the link from your email again, or ask for a new one."
      >
        <PrimaryButton
          label="Send a new link"
          onPress={() => router.replace('/forgot-password')}
          testID="reset-request-new"
        />
      </AuthPage>
    );
  }

  if (outcome === 'invalid') {
    return (
      <AuthPage
        documentTitle="Reset link expired · Ansari"
        title="This link no longer works"
        subtitle="Reset links work once, for one hour. Ask for a new one and use the newest email."
      >
        <PrimaryButton
          label="Send a new link"
          onPress={() => router.replace('/forgot-password')}
          testID="reset-request-new"
        />
      </AuthPage>
    );
  }

  return (
    <AuthPage
      documentTitle="Choose a new password · Ansari"
      title="Choose a new password"
      subtitle="At least 8 characters. Mix letters, numbers and symbols."
    >
      <Field
        label="New password"
        value={password}
        onChangeText={setPassword}
        secureTextEntry
        autoCapitalize="none"
        autoComplete="new-password"
        testID="new-password-input"
      />
      <Field
        label="Confirm new password"
        value={confirm}
        onChangeText={setConfirm}
        secureTextEntry
        autoCapitalize="none"
        autoComplete="new-password"
        onSubmitEditing={submit}
        returnKeyType="go"
        testID="confirm-password-input"
      />
      {error && (
        <Text style={[styles.error, { color: colors.destructive }]} testID="reset-error">
          {error}
        </Text>
      )}
      <PrimaryButton
        label="Set new password"
        onPress={submit}
        busy={submitting}
        testID="reset-submit"
      />
    </AuthPage>
  );
}

function PrimaryButton({
  label,
  onPress,
  busy = false,
  testID,
}: {
  label: string;
  onPress: () => void;
  busy?: boolean;
  testID: string;
}) {
  const colors = useColors();
  return (
    <PressableScale
      onPress={onPress}
      disabled={busy}
      accessibilityRole="button"
      testID={testID}
      style={(state) => [
        styles.button,
        {
          backgroundColor: colors.primary,
          opacity: busy ? 0.7 : state.pressed ? 0.85 : 1,
        },
      ]}
    >
      {busy ? (
        <ActivityIndicator color={colors.primaryForeground} />
      ) : (
        <Text style={[styles.buttonText, { color: colors.primaryForeground }]}>{label}</Text>
      )}
    </PressableScale>
  );
}
