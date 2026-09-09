import React, { useEffect } from 'react';
import { ActivityIndicator, Platform, StyleSheet, View } from 'react-native';
import { ZodError } from 'zod';
import {
  DarkTheme,
  DefaultTheme,
  ThemeProvider,
  type Theme,
} from '@react-navigation/native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { KeyboardProvider } from 'react-native-keyboard-controller';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AccountChrome } from '@/components/AccountChrome';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { AmbientVideo } from '@/components/AmbientVideo';
import { MessageActionSheet } from '@/components/MessageActionSheet';
import { PaperBackground } from '@/components/PaperBackground';
import { Sidebar } from '@/components/Sidebar';
import { SidebarDrawer } from '@/components/SidebarDrawer';
import { ToastStack } from '@/components/ToastStack';
import { useAppFonts } from '@/hooks/useAppFonts';
import { useColors } from '@/hooks/useColors';
import { useDesktop } from '@/hooks/useDesktop';
import { useScheme } from '@/hooks/useScheme';
import { SCREEN_FADE_MS } from '@/constants/motion';
import { useAskExit } from '@/lib/askExit';
import { Stack, usePathname } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import * as SystemUI from 'expo-system-ui';
import * as NavigationBar from 'expo-navigation-bar';
import { StatusBar } from 'expo-status-bar';
import { ApiError, setBaseUrl } from '@/lib/api';
import { resolveBaseUrl } from '@/lib/api/config';
import { AuthProvider, useAuth } from '@/lib/auth/context';
import { SELF_INKED_FOCUS } from '@/lib/semantics';

// Expo bundles run outside any web proxy; the API client needs an absolute URL.
// Defaults to the deployed staging backend; override with EXPO_PUBLIC_API_URL.
setBaseUrl(resolveBaseUrl());

// Prevent the splash screen from auto-hiding before asset loading is complete.
SplashScreen.preventAutoHideAsync();

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (failureCount, error) => {
        // A shape mismatch (ZodError) or a 4xx will not fix itself, and a shape
        // mismatch MUST surface as an error state (the loud-failure gate) rather
        // than being retried into a spinner. Retry only transient failures.
        if (error instanceof ZodError) return false;
        if (
          error instanceof ApiError &&
          error.status >= 400 &&
          error.status < 500
        ) {
          return false;
        }
        return failureCount < 2;
      },
    },
  },
});

/**
 * Web-only page manners, kept in step with the color scheme: the
 * browser page and the document element both take the paper colour (no
 * white band beyond the app root on overscroll, and no white flash
 * before the first paint), the browser is told which mode it is in so
 * scrollbars and form widgets follow, text selection and the caret pick
 * up the palette, and keyboard focus draws a visible ring. Pointer
 * cursors and hover states live with each pressable; this covers only
 * what a real stylesheet can reach. Renders nothing, everywhere.
 */
function WebManners() {
  const colors = useColors();
  const scheme = useScheme();

  useEffect(() => {
    if (Platform.OS !== 'web' || typeof document === 'undefined') return;

    document.body.style.backgroundColor = colors.background;
    document.documentElement.style.backgroundColor = colors.background;
    // Scrollbars, spinners and the rest of the browser's own furniture.
    document.documentElement.style.colorScheme = scheme;

    // The bands a phone browser draws over the page — behind the status
    // bar, behind the address bar — take their colour from this and
    // nothing else. There is one such element in the document and this
    // writes that one: `public/index.html` declares it, with this id and
    // no `media` attribute, and sets the scheme's value on it before the
    // first paint. A second meta added here would leave the browser
    // choosing between two, which is the ambiguity that shell exists to
    // remove; the `create` below is only for a document that never had
    // one.
    const themeId = 'ansari-theme-color';
    let themeColor = document.getElementById(themeId) as HTMLMetaElement | null;
    if (!themeColor) {
      themeColor = document.createElement('meta');
      themeColor.id = themeId;
      themeColor.name = 'theme-color';
      document.head.prepend(themeColor);
    }
    themeColor.content = colors.background;

    const id = 'ansari-web-manners';
    let style = document.getElementById(id) as HTMLStyleElement | null;
    if (!style) {
      style = document.createElement('style');
      style.id = id;
      document.head.appendChild(style);
    }
    style.textContent = `
      ::selection {
        background: ${colors.selection};
      }
      input, textarea {
        caret-color: ${colors.caret};
      }
      /* The one focus treatment, applied to anything the browser
         decides is focusable — scoped to buttons and links, a keyboard
         reader landed on scroll containers and grouping elements with
         nothing but the UA's own thin white rectangle to follow.
         Drawn in ink now rather than the old emerald, which clears
         11.7:1 or better on every surface it can land on in either
         mode. */
      :focus-visible {
        outline: 2px solid ${colors.focusRing} !important;
        outline-offset: 2px;
      }
      /* Two text fields answer focus in their own material — the search
         field inks the rim it already wears, the composer's whole bar
         lifts — so they opt out rather than wear two cues on one edge.
         They opt out *by name*: exempting every input and textarea left
         any field added later with no focus indicator at all, which is
         the one outcome this rule exists to prevent. See
         SELF_INKED_FOCUS in lib/semantics. */
      [id^="${SELF_INKED_FOCUS}"]:focus-visible {
        outline: none !important;
      }
    `;
  }, [
    colors.background,
    colors.caret,
    colors.focusRing,
    colors.selection,
    scheme,
  ]);

  return null;
}

/**
 * The chrome the app doesn't draw but still owns: the window behind the
 * React root (visible for a frame between the launch screen and first
 * paint, and behind anything translucent), and the Android navigation
 * bar's button icons. Both have to be told the mode explicitly —
 * neither follows the stylesheet. The status bar is handled by
 * `<StatusBar style="auto" />`, which reads the same scheme.
 */
function NativeChrome() {
  const colors = useColors();
  const scheme = useScheme();

  useEffect(() => {
    if (Platform.OS === 'web') return;
    SystemUI.setBackgroundColorAsync(colors.background).catch(() => {});
    if (Platform.OS === 'android') {
      // Edge-to-edge draws the page under a transparent bar, so only the
      // gesture pill / button icons need to be flipped for the mode.
      NavigationBar.setButtonStyleAsync(
        scheme === 'dark' ? 'light' : 'dark',
      ).catch(() => {});
    }
  }, [colors.background, scheme]);

  return <StatusBar style="auto" />;
}

/**
 * The furniture that is supposed to stand still while the reader moves
 * around inside the app.
 *
 * The paper, the desktop rail and the account cluster used to be
 * rendered by each screen. That made them screen furniture: asking a
 * question unmounted one copy and mounted another, so the rail re-laid
 * itself out and lost its scroll, the account links blinked, and the
 * page's own texture vanished at the cut — all for a navigation whose
 * whole intent is that only the writing on the page changes.
 *
 * Mounted here instead, once, above the navigator. The screens draw
 * onto this paper rather than each bringing their own, so the hand-off
 * cannot disturb anything but the words.
 */
function AppFrame({ children }: { children: React.ReactNode }) {
  const desktop = useDesktop();
  // The rail and the grain both need to know which screen is showing,
  // and the route is the honest source for that — a prop passed down by
  // whichever screen happens to be mounted is exactly the coupling this
  // component exists to remove.
  const path = usePathname();
  // The exit begins before the route changes, and both the shadow and
  // the grain have to begin with it rather than at the cut — see
  // `lib/askExit`. The ask takes at least 460ms to hand over and the
  // texture crosses in 260, so by the time the route changes the page
  // is already wearing the thread's surface and the cut changes only
  // what is written on it.
  const leaving = useAskExit();
  // Login and register draw a centred form onto the shared paper — no
  // rail, no account cluster, and no grain competing with the fields.
  const authRoute =
    path.startsWith('/login') || path.startsWith('/register');
  const reading =
    leaving ||
    authRoute ||
    path.startsWith('/chat') ||
    path.startsWith('/about');

  return (
    <PaperBackground
      // Grain is a texture for an empty page; under a full column of
      // body text — an answer or the About page — it competes with the
      // letterforms. The paper fades between the two rather than
      // cutting — see `PaperBackground`.
      grain={!reading}
    >
      {/* The palm shadow is cast *on* the paper, so it hangs here with
          the grain rather than inside the home screen. At night it
          multiplies onto the page, and a blend can only reach what is
          painted beneath it in the same layer: rendered inside a screen,
          the navigator's own containers stand between the clip and the
          paper, and the near-white wall arrives as light on a dark page
          instead of darkening it. Here it has the paper directly under
          it, the way the grain does. */}
      <AmbientVideo dismissed={path !== '/' || leaving} />
      {children}
      {/* After the navigator, so the standing chrome sits over the
          page rather than under it. Both are absolutely positioned and
          occupy only their own corner of the paper. */}
      {/* One rail, two ways of standing. A desktop keeps it beside the
          page; a phone has no width to give it, so the same component
          arrives over the page and leaves again. */}
      {!authRoute && (desktop ? <Sidebar /> : <SidebarDrawer />)}
      {!authRoute && desktop && <AccountChrome />}
    </PaperBackground>
  );
}

/**
 * Holds the first frame while the persisted session is still being
 * restored, so no screen (and none of its data queries) mounts before
 * the transport knows whether it has a token. Ansari works signed-out —
 * `apps/api` serves guest and anonymous threads — so there is no forced
 * redirect: signing in is an optional add-on reached from the rail.
 */
function AuthGate({ children }: { children: React.ReactNode }) {
  const { status } = useAuth();
  const colors = useColors();

  if (status === 'loading') {
    return (
      <View style={[styles.authGate, { backgroundColor: colors.background }]}>
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }

  return <>{children}</>;
}

function RootLayoutNav() {
  const dark = useScheme() === 'dark';

  return (
    <ThemeProvider value={transparentNavigationTheme(dark)}>
      <Stack
        screenOptions={{
          headerShown: false,
          // Asking a question should read as one continuous move, not
          // as a new page arriving: the paper stays exactly where it is
          // and only the content on it cross-dissolves. Web's stack has
          // no real animation layer — it simply cuts, which is still a
          // still page rather than a sideways slide.
          animation: 'fade',
          animationDuration: SCREEN_FADE_MS,
          // A fade is a custom transition, so ask explicitly for the
          // iOS back-swipe rather than inheriting the slide's default.
          gestureEnabled: true,
        }}
      >
        <Stack.Screen name="index" />
        <Stack.Screen name="chat/[id]" />
        <Stack.Screen name="about" />
        <Stack.Screen name="login" />
        <Stack.Screen name="register" />
      </Stack>
    </ThemeProvider>
  );
}

export default function RootLayout() {
  // Native loads the bundled faces at runtime and is held back until
  // they land, which costs nothing behind the splash screen. The web
  // never waits: the browser already owns the faces (declared and
  // preloaded in `public/index.html`), so `useAppFonts` there is
  // immediately ready and the first paint is not withheld while several
  // megabytes of type download. See `hooks/useAppFonts.web.ts`.
  const fontsReady = useAppFonts();

  useEffect(() => {
    if (fontsReady) {
      SplashScreen.hideAsync();
    }
  }, [fontsReady]);

  if (!fontsReady) return null;

  return (
    <SafeAreaProvider>
      <ErrorBoundary>
        <QueryClientProvider client={queryClient}>
          {/* Owns the tokens and registers the transport bridges (bearer
              attach + 401 refresh) for both `custom-fetch` and the SSE
              path. Inside the query client because a principal change
              clears its cache. */}
          <AuthProvider>
            <GestureHandlerRootView>
              <KeyboardProvider>
                <WebManners />
                <NativeChrome />
                <AuthGate>
                  <AppFrame>
                    <RootLayoutNav />
                  </AppFrame>
                </AuthGate>
                {/* Mounted once, over every screen and every piece of
                    floating chrome: a notice belongs to the app, not to
                    the page that happened to raise it. */}
                <ToastStack />
                {/* Likewise the menu a held message raises: the press
                    comes from a row inside a virtualized thread, and a
                    sheet per message would be a modal in every row for
                    the sake of the one being held. */}
                <MessageActionSheet />
              </KeyboardProvider>
            </GestureHandlerRootView>
          </AuthProvider>
        </QueryClientProvider>
      </ErrorBoundary>
    </SafeAreaProvider>
  );
}

/**
 * The navigator's own paper, made transparent.
 *
 * Every screen react-navigation renders is wrapped in a view filling
 * the window and painted with the theme's `background` — a plain light
 * grey that has nothing to do with Ansari's palette. While each screen
 * brought its own paper that view was harmlessly hidden; now that the
 * paper is mounted once *underneath* the navigator, that grey sits on
 * top of it and the app has no page of its own. (By day it passes for
 * paper, which is exactly why it hides: at night it turns the whole
 * screen light.)
 *
 * So the navigator is told it has no background. The frame's paper is
 * the only page, and the screens draw straight onto it — which is also
 * what lets the grain and the ambient shadow blend against the real
 * page colour rather than against a grey rectangle in between.
 */
function transparentNavigationTheme(dark: boolean): Theme {
  const base = dark ? DarkTheme : DefaultTheme;
  return { ...base, colors: { ...base.colors, background: 'transparent' } };
}

const styles = StyleSheet.create({
  authGate: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
