import React, { useState } from 'react';
import { ActivityIndicator, Text } from 'react-native';
import { router } from 'expo-router';
import { useColors } from '@/hooks/useColors';
import { useAuth } from '@/lib/auth/context';
import { AccountDeleteNotSentError, AccountSessionEndedError } from '@/lib/auth/errors';
import { openAuthSheet } from '@/lib/authSheet';
import { AuthPage, authPageStyles as styles } from '@/components/AuthPage';
import { PressableScale } from '@/components/PressableScale';

type Step = 'start' | 'confirm' | 'deleted' | 'ended';

const NOT_CONFIRMED =
  "We couldn't confirm the deletion. If this device has been signed out, your account is gone; otherwise try again.";

/**
 * `/delete-account` (#306). The address is legacy web's, and probably the
 * deletion URL listed with the app stores, so it must make sense to anyone
 * who lands on it:
 *
 * - signed in to a real account: what is deleted, then an explicit second
 *   step (no `confirm()` dialog: it is unreliable in the web shell);
 * - a guest, or nobody: a prompt to sign in to the account to delete. A
 *   guest has nothing of its own to delete and is re-provisioned anyway.
 *
 * It is a public page (`isPublicPath`): a visitor with nothing stored (a
 * store reviewer, a mailed link) is not given a guest by opening it, so
 * while the session is still `loading` with nothing restored, the page
 * shows the sign-in prompt.
 *
 * Deleting calls apps/api (`DELETE /api/v2/users/me`, with the JWT), which
 * removes the account at apps/auth too. On success the device returns to its
 * guest; this page keeps saying the account is gone rather than turning into
 * the sign-in prompt the guest would otherwise see.
 */
export default function DeleteAccountScreen() {
  const colors = useColors();
  const { status, session, isGuest, deleteAccount } = useAuth();
  const [step, setStep] = useState<Step>('start');
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const hasRealAccount = status === 'signedIn' && !isGuest && session !== null;
  const accountName =
    [session?.firstName, session?.lastName]
      .map((part) => part?.trim())
      .filter(Boolean)
      .join(' ') || 'your account';

  const remove = async () => {
    if (deleting) return;
    setError(null);
    setDeleting(true);
    try {
      await deleteAccount();
      setStep('deleted');
    } catch (e) {
      if (e instanceof AccountSessionEndedError) {
        setStep('ended');
      } else if (e instanceof AccountDeleteNotSentError) {
        // Nothing was sent: the account is certainly still there.
        setError(e.message);
      } else {
        // A 5xx or a lost response cannot say whether the delete committed,
        // and no raw error text belongs on this page.
        setError(NOT_CONFIRMED);
      }
    } finally {
      setDeleting(false);
    }
  };

  if (step === 'deleted') {
    return (
      <AuthPage
        documentTitle="Account deleted · Ansari"
        title="Your account has been deleted"
        subtitle="Your account and its questions are gone. You can keep using Ansari as a guest."
      >
        <Button label="Back to Ansari" onPress={() => router.replace('/')} testID="delete-done" />
      </AuthPage>
    );
  }

  if (step === 'ended') {
    return (
      <AuthPage
        documentTitle="Session ended · Ansari"
        title="Your session has ended"
        subtitle="If you already confirmed, your account is deleted. Otherwise, sign in and try again."
      >
        <Button label="Back to Ansari" onPress={() => router.replace('/')} testID="delete-ended" />
      </AuthPage>
    );
  }

  if (!hasRealAccount) {
    return (
      <AuthPage
        documentTitle="Delete your account · Ansari"
        title="Delete your account"
        subtitle="Sign in to the account you want to delete. A guest session has no account to delete."
      >
        <Button label="Log in" onPress={() => openAuthSheet('login')} testID="delete-sign-in" />
      </AuthPage>
    );
  }

  return (
    <AuthPage
      documentTitle="Delete your account · Ansari"
      title="Delete your account"
      subtitle={`Signed in as ${accountName}.`}
    >
      <Text style={[styles.note, { color: colors.foreground }]} testID="delete-what">
        Deleting your account removes it and every question you have asked, with
        its answers. It cannot be undone, and you will be signed out on every
        device.
      </Text>
      {error && (
        <Text style={[styles.error, { color: colors.destructive }]} testID="delete-error">
          {error}
        </Text>
      )}
      {step === 'start' ? (
        <Button
          label="Delete my account"
          destructive
          onPress={() => setStep('confirm')}
          testID="delete-start"
        />
      ) : (
        <>
          <Text style={[styles.note, { color: colors.foreground }]}>
            Are you sure? This is permanent.
          </Text>
          <Button
            label="Yes, delete my account"
            destructive
            busy={deleting}
            onPress={remove}
            testID="delete-confirm"
          />
          <PressableScale
            onPress={() => {
              setError(null);
              setStep('start');
            }}
            disabled={deleting}
            accessibilityRole="button"
            testID="delete-cancel"
            style={styles.link}
          >
            <Text style={[styles.linkText, { color: colors.foreground }]}>Cancel</Text>
          </PressableScale>
        </>
      )}
    </AuthPage>
  );
}

function Button({
  label,
  onPress,
  testID,
  busy = false,
  destructive = false,
}: {
  label: string;
  onPress: () => void;
  testID: string;
  busy?: boolean;
  destructive?: boolean;
}) {
  const colors = useColors();
  const fill = destructive ? colors.destructive : colors.primary;
  const ink = destructive ? colors.destructiveForeground : colors.primaryForeground;
  return (
    <PressableScale
      onPress={onPress}
      disabled={busy}
      accessibilityRole="button"
      testID={testID}
      style={(state) => [
        styles.button,
        { backgroundColor: fill, opacity: busy ? 0.7 : state.pressed ? 0.85 : 1 },
      ]}
    >
      {busy ? (
        <ActivityIndicator color={ink} />
      ) : (
        <Text style={[styles.buttonText, { color: ink }]}>{label}</Text>
      )}
    </PressableScale>
  );
}
