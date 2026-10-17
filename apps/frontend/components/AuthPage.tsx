import React from 'react';
import {
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { Feather } from '@expo/vector-icons';
import { router } from 'expo-router';
import Head from 'expo-router/head';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Animated from 'react-native-reanimated';
import { useColors } from '@/hooks/useColors';
import { useDesktop } from '@/hooks/useDesktop';
import { useSidebarInset } from '@/hooks/useSidebarCollapsed';
import { useScreenLandmark } from '@/hooks/useScreenLandmark';
import { fonts } from '@/constants/colors';
import { barContentTop, headerBarHeight, phoneGutter } from '@/constants/layout';
import { RADIUS, rounded } from '@/constants/radius';
import { heading } from '@/lib/semantics';
import { AnsariMarkBrass } from '@/components/AnsariMarkBrass';
import { GlassCircleButton } from '@/components/GlassCircleButton';
import { HeaderBar } from '@/components/HeaderBar';

/**
 * A page that holds one short account form — the two halves of a password
 * reset. It is the sign-in sheet's card set on the paper as a page of its
 * own, because these are reached by a link (the emailed one, the legacy
 * `/forgot-password` address) rather than raised over a screen: the same
 * mark, the same title and subtitle, the same fields, at the sheet's width.
 * Phones get the back bar the other pages wear; desktop keeps the rail.
 */
export function AuthPage({
  documentTitle,
  title,
  subtitle,
  children,
}: {
  documentTitle: string;
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  const colors = useColors();
  const desktop = useDesktop();
  const insets = useSafeAreaInsets();
  const sidebarInset = useSidebarInset();
  const screenLandmark = useScreenLandmark();
  const { width } = useWindowDimensions();
  const barHeight = headerBarHeight(desktop, insets.top);

  const goBack = () => (router.canGoBack() ? router.back() : router.replace('/'));

  return (
    <>
      {Platform.OS === 'web' && (
        <Head>
          <title>{documentTitle}</title>
        </Head>
      )}
      <Animated.View style={[styles.flex, desktop && sidebarInset]} {...screenLandmark}>
        <ScrollView
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={[
            styles.page,
            {
              paddingTop: barContentTop(desktop, insets.top) + (desktop ? 48 : 16),
              paddingBottom: insets.bottom + 48,
              paddingHorizontal: desktop ? 24 : phoneGutter(width),
            },
          ]}
        >
          <View style={styles.column}>
            <View style={styles.masthead}>
              <AnsariMarkBrass height={30} />
              <Text {...heading(1)} style={[styles.title, { color: colors.strongForeground }]}>
                {title}
              </Text>
              <Text style={[styles.subtitle, { color: colors.mutedForeground }]}>{subtitle}</Text>
            </View>
            {children}
          </View>
        </ScrollView>
      </Animated.View>
      {!desktop && (
        <>
          <HeaderBar height={barHeight} />
          <View
            style={[
              styles.header,
              { top: insets.top + 6, left: phoneGutter(width), right: phoneGutter(width) },
            ]}
            pointerEvents="box-none"
          >
            <GlassCircleButton
              onPress={goBack}
              size={38}
              testID="back-button"
              accessibilityLabel="Back"
            >
              <Feather name="chevron-left" size={20} color={colors.foreground} />
            </GlassCircleButton>
          </View>
        </>
      )}
    </>
  );
}

/** The form's own type and buttons, shared by the two reset pages. */
export const authPageStyles = StyleSheet.create({
  form: {
    gap: 12,
  },
  note: {
    fontSize: 14,
    lineHeight: 20,
    fontFamily: fonts.body,
    textAlign: 'center',
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
  link: {
    alignItems: 'center',
    paddingVertical: 7,
  },
  linkText: {
    fontSize: 14,
    fontFamily: fonts.bodyMedium,
    textDecorationLine: 'underline',
    textAlign: 'center',
  },
});

const styles = StyleSheet.create({
  flex: {
    flex: 1,
  },
  page: {
    flexGrow: 1,
  },
  column: {
    width: '100%',
    maxWidth: 420,
    alignSelf: 'center',
    gap: 22,
  },
  masthead: {
    alignItems: 'center',
    gap: 8,
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
    maxWidth: 320,
  },
  header: {
    position: 'absolute',
    zIndex: 20,
    flexDirection: 'row',
    alignItems: 'center',
  },
});
