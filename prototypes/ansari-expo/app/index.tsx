import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Keyboard,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';
import * as Haptics from 'expo-haptics';
import { Feather } from '@expo/vector-icons';
import { useQueryClient } from '@tanstack/react-query';
import { router, useFocusEffect } from 'expo-router';
import Head from 'expo-router/head';
import {
  KeyboardAvoidingView,
  KeyboardController,
  useReanimatedKeyboardAnimation,
} from 'react-native-keyboard-controller';
import Animated, {
  Easing,
  FadeInDown,
  interpolate,
  ReduceMotion,
  useAnimatedStyle,
  useDerivedValue,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useColors } from '@/hooks/useColors';
import { useDesktop } from '@/hooks/useDesktop';
import { fonts } from '@/constants/colors';
import { withAlpha } from '@/lib/color';
import { screenInsets } from '@/lib/insets';
import { showNotice } from '@/lib/notice';
import { isHovered } from '@/lib/web';
import { AmbientVideo } from '@/components/AmbientVideo';
import { AnsariWordmark } from '@/components/AnsariWordmark';
import { ChatInput } from '@/components/ChatInput';
import { GlassCircleButton } from '@/components/GlassCircleButton';
import { HistorySheet } from '@/components/HistorySheet';
import { PaperBackground } from '@/components/PaperBackground';
import { WebNavButton } from '@/components/WebNavButton';
import {
  getListConversationsQueryKey,
  getListSuggestedQuestionsQueryKey,
  useCreateConversation,
  useDeleteConversation,
  useListConversations,
  useListSuggestedQuestions,
  type Conversation,
} from '@/lib/api';
import { useAuth } from '@/lib/auth/context';

// The ask is a single move, so the thread must not arrive before the
// paper has finished clearing. Conversation creation is usually faster
// than the eye: if it returns early we hold the push until the home
// screen's exit — the greeting clearing, the question lifting out of
// the composer — has actually been seen.
const MIN_EXIT_MS = 320;

export default function HomeScreen() {
  const colors = useColors();
  const { logout } = useAuth();
  // The home screen stays mounted beneath open conversations, so
  // "first prompt sent" state must not strand it: the ambient layer
  // and chips reset whenever the screen comes back into focus.
  const [isFocused, setIsFocused] = useState(true);
  useFocusEffect(
    React.useCallback(() => {
      setIsFocused(true);
      // Coming back to the paper resets the ask: the wordmark, chips
      // and footer settle in again. (The pending flag is deliberately
      // *not* cleared when the conversation is created — clearing it
      // there would fade the greeting back in behind the arriving
      // thread, mid-dissolve.)
      setPendingQuestion(null);
      return () => setIsFocused(false);
    }, []),
  );
  const insets = screenInsets(useSafeAreaInsets());
  const queryClient = useQueryClient();
  const [pendingQuestion, setPendingQuestion] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);

  // Search over past questions and answers. The query lives here (not in
  // the sheet) so it can drive the server-side `q` filter, which searches
  // full answer text — not just the titles and previews the client holds.
  const [searchText, setSearchText] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  useEffect(() => {
    const handle = setTimeout(() => setDebouncedSearch(searchText.trim()), 250);
    return () => clearTimeout(handle);
  }, [searchText]);
  const searching = debouncedSearch.length > 0;
  const listParams = searching ? { q: debouncedSearch } : undefined;

  // The lowercase wordmark holds a third of the screen's width — small
  // enough to read as a quiet mark, capped so wide windows stay calm.
  // On desktop it steps up once, deliberately, and holds there.
  const desktop = useDesktop();
  const { width: screenWidth } = useWindowDimensions();
  const logoWidth = desktop ? 190 : Math.min(Math.round(screenWidth / 3), 150);

  // When the keyboard opens, the composer should hug it: the safe-area
  // padding and the footer line collapse in step with the keyboard.
  const { progress: kb } = useReanimatedKeyboardAnimation();

  // Dismissing the keyboard by tapping the paper must not depend on any
  // single mechanism: core Keyboard.dismiss() rides JS focus tracking
  // that can silently no-op on the new architecture, so blur the field
  // directly through its ref and also ask the keyboard library's native
  // module (provably alive on device — it animates the composer) to
  // resign the keyboard itself.
  const inputRef = useRef<TextInput>(null);
  const dismissComposer = () => {
    if (Platform.OS !== 'web' && kb.value > 0.05) {
      // A quiet tick confirms the paper heard the tap.
      Haptics.selectionAsync();
    }
    inputRef.current?.blur();
    if (Platform.OS !== 'web') {
      KeyboardController.dismiss();
    }
    Keyboard.dismiss();
  };
  const bottomPad = useAnimatedStyle(() => ({
    paddingBottom: interpolate(kb.value, [0, 1], [insets.bottom + 10, 8]),
  }));
  // How far the home screen has cleared itself for the ask (0 → 1).
  // Driven below, but declared here so the footer can ride it too.
  const heroGone = useSharedValue(0);
  const footerCollapse = useAnimatedStyle(() => ({
    // The disclaimer steps aside for the keyboard and, once a question
    // is on its way, clears with the rest of the empty-screen furniture.
    opacity: (1 - kb.value) * (1 - heroGone.value),
    height: interpolate(kb.value, [0, 1], [15, 0]),
    marginTop: interpolate(kb.value, [0, 1], [0, -12]),
  }));

  // The suggested-question chips step aside while the user composes.
  // On native their collapse rides the keyboard's own animated progress —
  // the same shared value that makes the composer hug the keyboard, so if
  // one moves the other must. (Keyboard *events* and input blur have both
  // proven unreliable on device; the progress value is the only signal
  // we've watched work there.) On web, where that progress never moves,
  // field focus stands in. Once a question is on its way the chips stay
  // away until it settles.
  const [composerActive, setComposerActive] = useState(false);
  // Returning to this screen must never leave the chips hidden by a
  // stale focus flag from before navigation.
  useEffect(() => {
    if (isFocused) setComposerActive(false);
  }, [isFocused]);
  const jsHidden = pendingQuestion !== null || composerActive;
  const jsGone = useSharedValue(0);
  useEffect(() => {
    jsGone.value = withTiming(jsHidden ? 1 : 0, {
      duration: 220,
      easing: Easing.out(Easing.quad),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jsHidden]);
  const nativeKeyboard = Platform.OS !== 'web';
  const chipsGone = useDerivedValue(() =>
    Math.max(jsGone.value, nativeKeyboard ? kb.value : 0),
  );
  const chipsHeight = useSharedValue(0);
  const chipsCollapse = useAnimatedStyle(() => {
    const gone = chipsGone.value;
    const style: {
      opacity: number;
      marginBottom: number;
      transform: { translateY: number }[];
      pointerEvents: 'none' | 'auto';
      height?: number;
    } = {
      opacity: 1 - gone,
      marginBottom: -12 * gone,
      transform: [{ translateY: 6 * gone }],
      // Collapsed chips must not eat taps meant for the composer.
      pointerEvents: gone > 0.05 ? 'none' : 'auto',
    };
    if (gone > 0 && chipsHeight.value > 0) {
      style.height = (1 - gone) * chipsHeight.value;
    }
    return style;
  });

  // Desktop's sample lines dissolve while the user composes — opacity
  // only, no height collapse, so the centered composer never shifts.
  const linesFade = useAnimatedStyle(() => ({
    opacity: 1 - chipsGone.value,
    pointerEvents:
      chipsGone.value > 0.05 ? ('none' as const) : ('auto' as const),
  }));

  // The ask starts the instant the question leaves the composer, not
  // when the server answers: the wordmark and greeting clear away at
  // once, so the conversation-creation round trip is covered by motion
  // rather than by a frozen screen. The paper and the composer never
  // move — only what is written on them changes.
  const reducedMotion = useReducedMotion();
  const asking = pendingQuestion !== null;
  useEffect(() => {
    heroGone.value = withTiming(asking ? 1 : 0, {
      duration: asking ? 240 : 280,
      easing: Easing.out(Easing.quad),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asking]);
  const heroExit = useAnimatedStyle(() => ({
    opacity: 1 - heroGone.value,
    // With reduce motion on, the greeting simply clears — no travel.
    transform: [{ translateY: reducedMotion ? 0 : -10 * heroGone.value }],
  }));

  const conversationsQuery = useListConversations(listParams, {
    query: { queryKey: getListConversationsQueryKey(listParams) },
  });
  const suggestedQuery = useListSuggestedQuestions({
    query: { queryKey: getListSuggestedQuestionsQueryKey() },
  });

  const createConversation = useCreateConversation({
    mutation: {
      onSuccess: (conversation, variables) => {
        queryClient.invalidateQueries({
          queryKey: getListConversationsQueryKey(),
        });
        const push = () =>
          router.push({
            pathname: '/chat/[id]',
            params: { id: conversation.id, q: variables.data.title ?? '' },
          });
        const seen = Date.now() - askedAt.current;
        if (seen >= MIN_EXIT_MS) push();
        else setTimeout(push, MIN_EXIT_MS - seen);
      },
      onError: () => {
        setPendingQuestion(null);
        showNotice(
          "Couldn't start that question",
          'Check your connection and ask again.',
        );
      },
    },
  });

  const deleteConversation = useDeleteConversation({
    mutation: {
      onSuccess: () =>
        queryClient.invalidateQueries({
          queryKey: getListConversationsQueryKey(),
        }),
    },
  });

  const askedAt = useRef(0);
  const ask = (question: string) => {
    if (pendingQuestion) return;
    askedAt.current = Date.now();
    setPendingQuestion(question);
    createConversation.mutate({ data: { title: question } });
  };

  const conversations = conversationsQuery.data ?? [];
  const questions = useMemo(
    () => (suggestedQuery.data ?? []).flatMap((topic) => topic.questions),
    [suggestedQuery.data],
  );

  // Suggested questions. Phones keep the horizontal chip shelf under
  // the thumb. Desktop shows three quiet sample lines beneath the
  // centered composer — plain inked text, no chip furniture.
  // Chips borrow the wordmark's own material: heroInk — the debossed
  // tone the logo is set in — as a translucent wash over the paper. They
  // read as pressed into the page exactly like the logo does (same hue,
  // same see-through quality against the moving shadow), while the
  // darker label ink keeps them comfortably readable.
  const chipElements = questions.map((question) => (
    <Pressable
      key={question}
      onPress={() => ask(question)}
      style={(state) => [
        styles.chip,
        {
          backgroundColor: withAlpha(
            colors.heroInk,
            isHovered(state) ? 0.45 : 0.32,
          ),
          borderColor: withAlpha(colors.heroInk, 0.25),
          opacity: state.pressed ? 0.75 : 1,
        },
      ]}
    >
      <Text
        style={[styles.chipText, { color: colors.secondaryForeground }]}
        numberOfLines={2}
      >
        {question}
      </Text>
    </Pressable>
  ));

  // Each suggestion reads as a trending search: a small trend mark,
  // then the question. The rows' left edge lines up exactly with the
  // text inside the composer (card inset 16 + card padding 12 + field
  // padding 4 = 32).
  const suggestionLines = questions.slice(0, 3).map((question) => (
    <Pressable key={question} onPress={() => ask(question)} style={styles.line}>
      {(state) => {
        const ink = isHovered(state)
          ? colors.foreground
          : colors.mutedForeground;
        return (
          <>
            <Feather name="trending-up" size={15} color={ink} />
            <Text numberOfLines={1} style={[styles.lineText, { color: ink }]}>
              {question}
            </Text>
          </>
        );
      }}
    </Pressable>
  ));

  const showAbout = () => {
    showNotice(
      'About Ansari',
      "Ansari answers questions about the Qur'an and Sunnah. Verify important matters with scholars.",
    );
  };

  return (
    <PaperBackground>
      {Platform.OS === 'web' && (
        <Head>
          <title>Ansari — Ask about the Qur&apos;an and Sunnah</title>
          <meta
            name="description"
            content="Ask Ansari about the Qur'an and Sunnah."
          />
        </Head>
      )}
      <AmbientVideo dismissed={pendingQuestion !== null || !isFocused} />
      <View
        style={[
          styles.chrome,
          desktop ? styles.chromeDesktop : { top: insets.top + 10 },
        ]}
        pointerEvents="box-none"
      >
        {desktop ? (
          <>
            <WebNavButton
              label="History"
              onPress={() => setHistoryOpen(true)}
              testID="menu-button"
            />
            <View style={styles.chromeCluster}>
              <WebNavButton
                label="About"
                onPress={showAbout}
                testID="about-button"
              />
              <WebNavButton
                label="Log out"
                onPress={logout}
                testID="logout-button"
              />
            </View>
          </>
        ) : (
          <>
            <GlassCircleButton
              onPress={() => setHistoryOpen(true)}
              testID="menu-button"
            >
              <Feather name="menu" size={19} color={colors.foreground} />
            </GlassCircleButton>
            <GlassCircleButton onPress={showAbout} testID="about-button">
              <Feather
                name="more-horizontal"
                size={19}
                color={colors.foreground}
              />
            </GlassCircleButton>
          </>
        )}
      </View>

      <KeyboardAvoidingView
        style={[styles.flex, desktop && styles.stageDesktop]}
        behavior="padding"
      >
        {/* Tapping the open paper dismisses the keyboard. */}
        <Pressable
          style={[styles.hero, desktop && styles.heroDesktop]}
          onPress={dismissComposer}
          accessible={false}
        >
          <Animated.View
            style={[styles.heroInner, heroExit]}
            pointerEvents="none"
          >
            <AnsariWordmark width={logoWidth} color={colors.heroInk} />
            <Text
              style={[
                styles.greeting,
                desktop && styles.greetingDesktop,
                { color: colors.heroInk },
              ]}
            >
              Welcome, seeker of knowledge
            </Text>
          </Animated.View>
        </Pressable>

        <Animated.View
          style={[styles.bottom, desktop && styles.bottomDesktop, bottomPad]}
        >
          {!desktop && questions.length > 0 && (
            <Animated.View style={[styles.chipsClip, chipsCollapse]}>
              <View
                onLayout={(e) => {
                  chipsHeight.value = e.nativeEvent.layout.height;
                }}
              >
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  contentContainerStyle={styles.chips}
                  keyboardShouldPersistTaps="handled"
                >
                  {chipElements}
                </ScrollView>
              </View>
            </Animated.View>
          )}

          <View style={styles.inputBar}>
            {/* The question lifts out of the composer and settles just
                above it, on the same beige card it will keep in the
                thread — so when the thread arrives, the card is already
                where the eye left it and simply rises into place. */}
            {asking && isFocused && (
              <Animated.View
                style={styles.lift}
                pointerEvents="none"
                entering={FadeInDown.duration(260).reduceMotion(
                  ReduceMotion.System,
                )}
              >
                <View
                  style={[
                    styles.liftCard,
                    { backgroundColor: colors.secondary },
                  ]}
                >
                  <Text
                    numberOfLines={3}
                    style={[
                      styles.liftText,
                      { color: colors.secondaryForeground },
                    ]}
                  >
                    {pendingQuestion}
                  </Text>
                </View>
              </Animated.View>
            )}
            <ChatInput
              onSend={ask}
              sending={pendingQuestion !== null}
              clearGlass
              inputRef={inputRef}
              onFocusChange={(focused) => {
                if (Platform.OS === 'web') setComposerActive(focused);
              }}
            />
          </View>

          {desktop && questions.length > 0 && (
            <Animated.View style={[styles.lines, linesFade]}>
              {suggestionLines}
            </Animated.View>
          )}

          {!desktop && (
            <Animated.View style={[styles.footerWrap, footerCollapse]}>
              <Text style={[styles.footer, { color: colors.mutedForeground }]}>
                Verify results with scholars.
              </Text>
            </Animated.View>
          )}
        </Animated.View>
      </KeyboardAvoidingView>

      {desktop && (
        <View style={styles.footerDesktop} pointerEvents="none">
          <Text style={[styles.footer, { color: colors.mutedForeground }]}>
            Verify results with scholars.
          </Text>
        </View>
      )}

      <HistorySheet
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        conversations={conversations}
        loading={conversationsQuery.isLoading || conversationsQuery.isFetching}
        query={searchText}
        onQueryChange={setSearchText}
        searching={searching}
        onOpenConversation={(conversation: Conversation) => {
          setHistoryOpen(false);
          router.push({
            pathname: '/chat/[id]',
            params: { id: conversation.id },
          });
        }}
        onDeleteConversation={(conversation: Conversation) =>
          deleteConversation.mutate({ conversationId: conversation.id })
        }
        onLogout={() => {
          setHistoryOpen(false);
          logout();
        }}
      />
    </PaperBackground>
  );
}

const styles = StyleSheet.create({
  flex: {
    flex: 1,
  },
  // On desktop the stage centers its content vertically, held a touch
  // above true center so the composition sits optically balanced.
  stageDesktop: {
    justifyContent: 'center',
    paddingBottom: 56,
  },
  chrome: {
    position: 'absolute',
    left: 18,
    right: 18,
    zIndex: 10,
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  // About and Log in read as one quiet cluster on the right.
  chromeCluster: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  // Desktop has no status bar to clear: the floating buttons take a
  // steady margin instead of the phone's inset-driven offset.
  chromeDesktop: {
    top: 22,
    left: 26,
    right: 26,
  },
  hero: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // Desktop centers the whole ask — wordmark, greeting, composer,
  // sample lines — as one block; the hero stops stretching and sits
  // just above the composer. (Longhands, not `flex: 0`: RN-web maps
  // the shorthand to a zero flex-basis, which collapses the block.)
  heroDesktop: {
    flexGrow: 0,
    flexShrink: 0,
    flexBasis: 'auto',
    marginBottom: 44,
  },
  heroInner: {
    alignItems: 'center',
    gap: 2,
  },
  greeting: {
    fontSize: 19,
    fontFamily: fonts.displayItalic,
    marginTop: 10,
  },
  greetingDesktop: {
    fontSize: 21,
    marginTop: 12,
  },
  bottom: {
    gap: 12,
  },
  // The composer block holds a comfortable capped width on wide
  // windows — the centered single-column sanctuary, scaled up.
  bottomDesktop: {
    width: '100%',
    maxWidth: 640,
    alignSelf: 'center',
    gap: 18,
  },
  chipsClip: {
    overflow: 'hidden',
  },
  chips: {
    paddingHorizontal: 16,
    gap: 10,
  },
  chip: {
    borderRadius: 18,
    paddingHorizontal: 16,
    paddingVertical: 12,
    maxWidth: 260,
    justifyContent: 'center',
    cursor: 'pointer',
    borderWidth: StyleSheet.hairlineWidth,
  },
  chipText: {
    fontSize: 14.5,
    lineHeight: 20,
    fontFamily: fonts.bodyMedium,
  },
  lines: {
    gap: 2,
  },
  line: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 7,
    paddingLeft: 32,
    paddingRight: 16,
    cursor: 'pointer',
  },
  lineText: {
    flexShrink: 1,
    fontSize: 15,
    lineHeight: 21,
    fontFamily: fonts.body,
  },
  footerWrap: {
    overflow: 'hidden',
  },
  // Desktop pins the disclaimer to the paper's very bottom edge,
  // clear of the centered composition.
  footerDesktop: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 18,
    alignItems: 'center',
  },
  footer: {
    // 13px sits at the top of the industry's disclaimer range (AI
    // chat disclaimers run 12–13px) — present but still a whisper.
    fontSize: 13,
    lineHeight: 16,
    fontFamily: fonts.body,
    textAlign: 'center',
  },
  inputBar: {
    paddingHorizontal: 16,
  },
  // Sits directly above the composer without taking any space from it,
  // so the paper and the composer never move while the question leaves.
  lift: {
    position: 'absolute',
    left: 16,
    right: 16,
    bottom: '100%',
    marginBottom: 10,
    alignItems: 'flex-end',
  },
  liftCard: {
    maxWidth: '86%',
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  liftText: {
    fontSize: 15.5,
    lineHeight: 22,
    fontFamily: fonts.bodyMedium,
  },
});
