import React, { useEffect } from 'react';
import { ActivityIndicator, Platform, View } from 'react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ZodError } from 'zod';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { KeyboardProvider } from 'react-native-keyboard-controller';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { useColors } from '@/hooks/useColors';
import { useScheme } from '@/hooks/useScheme';
import {
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
  Inter_700Bold,
  useFonts,
} from '@expo-google-fonts/inter';
import {
  Spectral_500Medium,
  Spectral_500Medium_Italic,
  Spectral_600SemiBold,
} from '@expo-google-fonts/spectral';
import {
  Literata_300Light,
  Literata_300Light_Italic,
  Literata_400Regular,
  Literata_500Medium,
} from '@expo-google-fonts/literata';
import { Amiri_400Regular } from '@expo-google-fonts/amiri';
import { Stack, useRouter, useSegments } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { ApiError, setBaseUrl } from '@/lib/api';
import { resolveBaseUrl } from '@/lib/api/config';
import { AuthProvider, useAuth } from '@/lib/auth/context';

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
        if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
          return false;
        }
        return failureCount < 2;
      },
    },
  },
});

/**
 * Web-only page manners, kept in step with the color scheme: the
 * browser page itself takes the paper color (no white band beyond the
 * app root on overscroll), text selection picks up the folio gold, and
 * keyboard focus draws a visible ring on buttons and links. Pointer
 * cursors and hover states live with each pressable; this covers only
 * what a real stylesheet can reach. Renders nothing, everywhere.
 */
function WebManners() {
  const colors = useColors();
  const scheme = useScheme();

  useEffect(() => {
    if (Platform.OS !== 'web' || typeof document === 'undefined') return;

    document.body.style.backgroundColor = colors.background;

    const id = 'ansari-web-manners';
    let style = document.getElementById(id) as HTMLStyleElement | null;
    if (!style) {
      style = document.createElement('style');
      style.id = id;
      document.head.appendChild(style);
    }
    style.textContent = `
      ::selection {
        background: ${
          scheme === 'dark'
            ? 'rgba(203, 164, 92, 0.40)'
            : 'rgba(185, 146, 74, 0.30)'
        };
      }
      [role="button"]:focus-visible,
      a:focus-visible {
        outline: 2px solid ${colors.primary} !important;
        outline-offset: 2px;
      }
    `;
  }, [colors.background, colors.primary, scheme]);

  return null;
}

/**
 * Redirects between the auth screens and the app based on session status.
 * Signed-out users are pushed to `/login`; signed-in users on an auth screen are
 * pushed to the app. While the persisted session is still loading, a quiet
 * spinner stands in so no protected screen (and its data queries) mounts early.
 */
function AuthGate({ children }: { children: React.ReactNode }) {
  const { status } = useAuth();
  const colors = useColors();
  const segments = useSegments();
  const router = useRouter();

  useEffect(() => {
    if (status === 'loading') return;
    const inAuthRoute = segments[0] === 'login' || segments[0] === 'register';
    if (status === 'signedOut' && !inAuthRoute) {
      router.replace('/login');
    } else if (status === 'signedIn' && inAuthRoute) {
      router.replace('/');
    }
  }, [status, segments, router]);

  if (status === 'loading') {
    return (
      <View
        style={{
          flex: 1,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: colors.background,
        }}
      >
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }

  return <>{children}</>;
}

function RootLayoutNav() {
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        // Asking a question should read as one continuous move, not as
        // a new page arriving: the paper stays exactly where it is and
        // only the content on it cross-dissolves. Web's stack has no
        // real animation layer — it simply cuts, which is still a still
        // page rather than a sideways slide.
        animation: 'fade',
        animationDuration: 260,
        // A fade is a custom transition, so ask explicitly for the
        // iOS back-swipe rather than inheriting the slide's default.
        gestureEnabled: true,
      }}
    >
      <Stack.Screen name="login" />
      <Stack.Screen name="register" />
      <Stack.Screen name="index" />
      <Stack.Screen name="chat/[id]" />
    </Stack>
  );
}

export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts({
    Inter_400Regular,
    Inter_500Medium,
    Inter_600SemiBold,
    Inter_700Bold,
    Spectral_500Medium,
    Spectral_500Medium_Italic,
    Spectral_600SemiBold,
    Literata_300Light,
    Literata_300Light_Italic,
    Literata_400Regular,
    Literata_500Medium,
    Amiri_400Regular,
  });

  useEffect(() => {
    if (fontsLoaded || fontError) {
      SplashScreen.hideAsync();
    }
  }, [fontsLoaded, fontError]);

  if (!fontsLoaded && !fontError) return null;

  return (
    <SafeAreaProvider>
      <ErrorBoundary>
        <QueryClientProvider client={queryClient}>
          <AuthProvider>
            <GestureHandlerRootView>
              <KeyboardProvider>
                <WebManners />
                <AuthGate>
                  <RootLayoutNav />
                </AuthGate>
              </KeyboardProvider>
            </GestureHandlerRootView>
          </AuthProvider>
        </QueryClientProvider>
      </ErrorBoundary>
    </SafeAreaProvider>
  );
}
