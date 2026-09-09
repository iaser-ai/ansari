import React from 'react';
import { Pressable, StyleSheet, Text } from 'react-native';
import { router } from 'expo-router';
import Animated from 'react-native-reanimated';
import { useColors } from '@/hooks/useColors';
import { useSourcePanelEdge } from '@/hooks/useSourcePanel';
import { fonts } from '@/constants/colors';
import { isHovered } from '@/lib/web';
import { useAuth } from '@/lib/auth/context';

/**
 * Account chrome: the way in, kept in the top-right corner where a
 * reader looks for it, on every desktop screen.
 *
 * Two words of plain text on the paper — no pill, no glass, no rule.
 * Nothing scrolls under this corner and nothing competes with it, so a
 * panel here would only be a box drawn around two links.
 *
 * Signed out it offers "Log in" / "Sign up", both opening the real auth
 * screen — Ansari works without an account, so this is an optional add-on,
 * not a gate. Signed in it shows the name and a way out.
 *
 * Desktop only, like the rail: phones reach the same actions from the
 * rail's drawer, and two competing sets of chrome on a small screen is
 * one too many. Callers gate it on `useDesktop()`.
 */
export function AccountChrome() {
  const colors = useColors();
  const { status, session, isGuest, logout } = useAuth();
  // A guest is on a throwaway account — offer sign-in, not a name + "log out".
  const hasRealAccount = status === 'signedIn' && !isGuest;
  // The corner belongs to the page, so it travels with it: when the
  // sources panel takes the right edge, these move off that edge on the
  // same frames rather than being buried under it.
  const edge = useSourcePanelEdge(CORNER_INSET);

  const accountName =
    [session?.firstName, session?.lastName]
      .map((part) => part?.trim())
      .filter(Boolean)
      .join(' ') || 'Signed in';

  return (
    <Animated.View style={[styles.wrap, edge]}>
      {hasRealAccount ? (
        <>
          <Text
            style={[styles.linkText, { color: colors.mutedForeground }]}
            numberOfLines={1}
          >
            {accountName}
          </Text>
          <Pressable
            onPress={() => {
              // Leave any account-owned thread before the principal
              // changes, so it can't refetch into its load-error screen.
              router.replace('/');
              void logout();
            }}
            accessibilityRole="button"
            testID="logout-button"
            style={(state) => [
              styles.link,
              { opacity: state.pressed ? 0.6 : isHovered(state) ? 1 : 0.75 },
            ]}
          >
            <Text style={[styles.linkText, { color: colors.foreground }]}>
              Log out
            </Text>
          </Pressable>
        </>
      ) : (
        <>
          <Pressable
            onPress={() => router.push('/login')}
            accessibilityRole="button"
            testID="login-button"
            style={(state) => [
              styles.link,
              { opacity: state.pressed ? 0.6 : isHovered(state) ? 1 : 0.75 },
            ]}
          >
            <Text style={[styles.linkText, { color: colors.mutedForeground }]}>
              Log in
            </Text>
          </Pressable>

          <Pressable
            onPress={() => router.push('/register')}
            accessibilityRole="button"
            testID="signup-button"
            style={(state) => [
              styles.link,
              { opacity: state.pressed ? 0.6 : isHovered(state) ? 1 : 0.9 },
            ]}
          >
            <Text style={[styles.linkText, { color: colors.foreground }]}>
              Sign up
            </Text>
          </Pressable>
        </>
      )}
    </Animated.View>
  );
}

/** How far the corner sits in from the window's right edge at rest. */
const CORNER_INSET = 26;

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute',
    top: 18,
    zIndex: 25,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 18,
  },
  link: {
    minHeight: 28,
    justifyContent: 'center',
    cursor: 'pointer',
  },
  linkText: {
    fontSize: 12.5,
    fontFamily: fonts.bodyMedium,
  },
});
