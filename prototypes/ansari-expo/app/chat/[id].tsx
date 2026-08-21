import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useQueryClient } from '@tanstack/react-query';
import { router, useLocalSearchParams } from 'expo-router';
import Head from 'expo-router/head';
import {
  KeyboardAvoidingView,
  useReanimatedKeyboardAnimation,
} from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Animated, {
  FadeIn,
  FadeInDown,
  interpolate,
  ReduceMotion,
  useAnimatedStyle,
} from 'react-native-reanimated';
import { useColors } from '@/hooks/useColors';
import { useDesktop } from '@/hooks/useDesktop';
import { fonts } from '@/constants/colors';
import { screenInsets } from '@/lib/insets';
import { isHovered } from '@/lib/web';
import { AnswerMessage } from '@/components/AnswerMessage';
import { ChatInput } from '@/components/ChatInput';
import { CitationSheet } from '@/components/CitationSheet';
import { GlassCircleButton } from '@/components/GlassCircleButton';
import { HeaderBar } from '@/components/HeaderBar';
import { PaperBackground } from '@/components/PaperBackground';
import { WebNavButton } from '@/components/WebNavButton';
import {
  getGetConversationQueryKey,
  getListConversationsQueryKey,
  useGetConversation,
  useSendMessage,
  type Citation,
  type Message,
} from '@/vendor/api-client-react';

// The desktop reading column: message text lands near 70 characters a
// line — a book's measure, not a stretched web page.
const READING_COLUMN = 672;

// Key held by the question carried in from the home screen, and then
// by the server's copy of it once it arrives, so the row survives the
// hand-off without remounting.
const ECHO_ID = '__asked-question';

/**
 * The waiting state sits on the paper exactly as the answer will —
 * unboxed, so nothing has to dissolve away when the text arrives. It
 * only fades in (no travel), beneath the question that prompted it.
 */
function ThinkingIndicator() {
  const colors = useColors();
  return (
    <Animated.View
      entering={FadeIn.duration(320)
        .delay(260)
        .reduceMotion(ReduceMotion.System)}
      style={styles.thinking}
    >
      <ActivityIndicator size="small" color={colors.mutedForeground} />
      <Text style={[styles.thinkingText, { color: colors.mutedForeground }]}>
        Searching the sources…
      </Text>
    </Animated.View>
  );
}

export default function ChatScreen() {
  const colors = useColors();
  const insets = screenInsets(useSafeAreaInsets());
  const queryClient = useQueryClient();
  const { id, q } = useLocalSearchParams<{ id: string; q?: string }>();
  const conversationId = id ?? '';
  const [activeCitation, setActiveCitation] = useState<Citation | null>(null);
  const autoSent = useRef(false);

  // Floating chrome: one uniform frosted bar spans from the physical
  // top edge (behind the status bar) down through the title row, and
  // the transcript visibly blurs beneath it. The back button + title
  // row sits centered inside the bar's below-inset band. Desktop has
  // no status bar: the bar takes a steady height and the row aligns
  // with the reading column below it.
  const desktop = useDesktop();
  const { width: windowWidth } = useWindowDimensions();
  const chromeTop = desktop ? 13 : insets.top + 6;
  const barHeight = desktop ? 64 : insets.top + 50;
  const headerSidePad = desktop
    ? Math.max((windowWidth - READING_COLUMN) / 2 + 16, 24)
    : 16;

  // The composer hugs the keyboard: safe-area padding collapses in
  // step with the keyboard animation.
  const { progress: kb } = useReanimatedKeyboardAnimation();
  const composerPad = useAnimatedStyle(() => ({
    paddingBottom: interpolate(kb.value, [0, 1], [insets.bottom + 10, 10]),
  }));

  const conversationQuery = useGetConversation(conversationId, {
    query: {
      enabled: !!conversationId,
      queryKey: getGetConversationQueryKey(conversationId),
    },
  });

  const sendMessage = useSendMessage({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({
          queryKey: getGetConversationQueryKey(conversationId),
        });
        queryClient.invalidateQueries({
          queryKey: getListConversationsQueryKey(),
        });
      },
    },
  });

  const send = (content: string) => {
    if (!conversationId || sendMessage.isPending) return;
    sendMessage.mutate({ conversationId, data: { content } });
  };

  // Auto-send the question passed from the home screen, exactly once,
  // and only if the conversation is still empty.
  useEffect(() => {
    if (
      !autoSent.current &&
      q &&
      conversationQuery.data &&
      conversationQuery.data.messages.length === 0
    ) {
      autoSent.current = true;
      send(q);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, conversationQuery.data]);

  // Arriving from the home screen the question is already in hand, so
  // it goes on the paper at once — no spinner standing in for it while
  // the conversation loads and the auto-send round trip runs.
  //
  // Reconciliation is by identity, not by removal: when the server's
  // copy of that same question comes back it inherits the echo's key,
  // so the row is never unmounted and remounted — nothing duplicates,
  // nothing re-animates, nothing jumps.
  const serverMessages = conversationQuery.data?.messages;
  const messages = useMemo<Message[]>(() => {
    const server = serverMessages ?? [];
    if (!q) return server;
    let matched = false;
    const reconciled = server.map((m) => {
      if (!matched && m.role === 'user' && m.content === q) {
        matched = true;
        return { ...m, id: ECHO_ID };
      }
      return m;
    });
    if (matched) return reconciled;
    return [
      {
        id: ECHO_ID,
        conversationId,
        role: 'user',
        content: q,
        citations: [],
        createdAt: '',
      },
      ...reconciled,
    ];
  }, [serverMessages, q, conversationId]);

  const reversed = [...messages].reverse();

  // The thread is waiting on an answer while a follow-up is in flight,
  // or while the question we arrived with has yet to be answered.
  const lastMessage = messages[messages.length - 1];
  const awaitingAnswer =
    sendMessage.isPending ||
    (!!q &&
      !sendMessage.isError &&
      !conversationQuery.isError &&
      lastMessage?.role === 'user');

  // A full-screen spinner is only honest when there is genuinely
  // nothing to show; with a question in hand there always is.
  const showLoadingScreen = conversationQuery.isLoading && !q;

  return (
    <PaperBackground>
      {Platform.OS === 'web' && (
        <Head>
          <title>
            {conversationQuery.data?.title || q
              ? `${conversationQuery.data?.title || q} — Ansari`
              : 'Ansari'}
          </title>
        </Head>
      )}
      <KeyboardAvoidingView style={styles.flex} behavior="padding">
        {showLoadingScreen ? (
          <View style={styles.center}>
            <ActivityIndicator color={colors.primary} />
          </View>
        ) : conversationQuery.isError ? (
          <View style={styles.center}>
            <Feather name="alert-circle" size={22} color={colors.destructive} />
            <Text style={[styles.errorText, { color: colors.mutedForeground }]}>
              This conversation didn't load. Check your connection.
            </Text>
            <Pressable
              onPress={() => conversationQuery.refetch()}
              style={(state) => [
                styles.retryButton,
                {
                  backgroundColor: colors.primary,
                  borderRadius: colors.radius,
                  opacity: state.pressed ? 0.85 : isHovered(state) ? 0.92 : 1,
                },
              ]}
            >
              <Text style={[styles.retryText, { color: colors.primaryForeground }]}>
                Try again
              </Text>
            </Pressable>
          </View>
        ) : (
          <FlatList
            data={reversed}
            inverted
            keyExtractor={(m: Message) => m.id}
            scrollEnabled={!!reversed.length || awaitingAnswer}
            contentContainerStyle={[
              styles.messages,
              desktop && styles.messagesDesktop,
              // Inverted list: paddingBottom is the visual top. Keep at
              // least the bar height of clearance so nothing loads
              // trapped beneath the frosted bar.
              { paddingBottom: barHeight + (desktop ? 24 : 14) },
            ]}
            keyboardDismissMode={
              Platform.OS === 'ios' ? 'interactive' : 'on-drag'
            }
            keyboardShouldPersistTaps="handled"
            // Indicators are hidden by design, so none can ride under
            // the frosted bar; nothing needs indicator insets.
            showsVerticalScrollIndicator={false}
            // Inverted list: the header renders below index 0, so the
            // waiting state sits beneath the question that prompted it.
            ListHeaderComponent={awaitingAnswer ? <ThinkingIndicator /> : null}
            renderItem={({ item }) =>
              item.role === 'user' ? (
                // The reader's own voice: a soft card a step darker
                // than the paper — the same material as the suggested
                // questions it replaced — rising into place from the
                // composer's direction.
                <Animated.View
                  entering={(item.id === ECHO_ID
                    ? // The question the reader arrived with picks up
                      // where it left the composer — a card's height
                      // lower — and rises the rest of the way, so the
                      // hand-off between the two screens reads as one
                      // continuous lift.
                      // (No custom easing: reanimated has no easing
                      // support for web layout animations and warns.)
                      FadeInDown.duration(440).withInitialValues({
                        opacity: 0,
                        transform: [{ translateY: 56 }],
                      })
                    : FadeInDown.duration(300)
                  ).reduceMotion(ReduceMotion.System)}
                  style={styles.userRow}
                >
                  <View
                    style={[
                      styles.userBubble,
                      {
                        // Solid, unoutlined: the reader's own voice is
                        // the one filled block on the page, which is
                        // what keeps it from reading like the outlined
                        // source pills beneath the answer.
                        backgroundColor: colors.secondary,
                        borderRadius: colors.radius + 4,
                      },
                    ]}
                  >
                    <Text
                      selectable={Platform.OS === 'web'}
                      style={[
                        styles.userText,
                        { color: colors.secondaryForeground },
                      ]}
                    >
                      {item.content}
                    </Text>
                  </View>
                </Animated.View>
              ) : (
                <AnswerMessage
                  message={item}
                  onCitationPress={setActiveCitation}
                />
              )
            }
          />
        )}

        <Animated.View
          style={[
            styles.inputBarContainer,
            desktop && styles.composerDesktop,
            composerPad,
          ]}
        >
          <ChatInput
            onSend={send}
            sending={sendMessage.isPending}
            placeholder="Ask a follow-up…"
          />
        </Animated.View>
      </KeyboardAvoidingView>

      <HeaderBar height={barHeight} />
      <View
        style={[
          styles.header,
          { top: chromeTop, left: headerSidePad, right: headerSidePad },
        ]}
        pointerEvents="box-none"
      >
        {desktop ? (
          <WebNavButton
            label="Back"
            icon="chevron-left"
            onPress={() =>
              router.canGoBack() ? router.back() : router.replace('/')
            }
            testID="back-button"
          />
        ) : (
          <GlassCircleButton
            onPress={() =>
              router.canGoBack() ? router.back() : router.replace('/')
            }
            size={38}
            testID="back-button"
          >
            <Feather name="chevron-left" size={20} color={colors.foreground} />
          </GlassCircleButton>
        )}
        <Text
          style={[styles.headerTitle, { color: colors.foreground }]}
          numberOfLines={1}
        >
          {/* The question we arrived with titles the thread until the
              server's own title lands, so the bar never sits empty. */}
          {conversationQuery.data?.title || q || ''}
        </Text>
      </View>

      <CitationSheet
        citation={activeCitation}
        onClose={() => setActiveCitation(null)}
      />
    </PaperBackground>
  );
}

const styles = StyleSheet.create({
  flex: {
    flex: 1,
  },
  header: {
    position: 'absolute',
    zIndex: 20,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  headerTitle: {
    flex: 1,
    fontSize: 16,
    fontFamily: fonts.displayMedium,
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
  },
  errorText: {
    fontSize: 14,
    fontFamily: 'Inter_400Regular',
  },
  retryButton: {
    paddingHorizontal: 22,
    paddingVertical: 10,
  },
  retryText: {
    fontSize: 14,
    fontFamily: 'Inter_600SemiBold',
  },
  // Unboxed answers need air, not borders, to read as separate turns.
  messages: {
    paddingHorizontal: 16,
    paddingTop: 16,
    gap: 20,
  },
  // Desktop: the thread reads as a centered column with a book-like
  // measure and a touch more air between turns.
  messagesDesktop: {
    width: '100%',
    maxWidth: READING_COLUMN,
    alignSelf: 'center',
    paddingTop: 28,
    gap: 24,
  },
  userRow: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
  },
  userBubble: {
    maxWidth: '84%',
    paddingHorizontal: 15,
    paddingVertical: 11,
    borderWidth: StyleSheet.hairlineWidth,
  },
  userText: {
    fontSize: 15,
    lineHeight: 22,
    fontFamily: fonts.bodyMedium,
  },
  // No card: the same air the answer sits in, so the answer can simply
  // replace these words without a surface dissolving away.
  thinking: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 4,
    alignSelf: 'flex-start',
  },
  thinkingText: {
    fontSize: 15,
    fontFamily: fonts.displayItalic,
  },
  inputBarContainer: {
    paddingHorizontal: 16,
    paddingTop: 8,
  },
  composerDesktop: {
    width: '100%',
    maxWidth: READING_COLUMN,
    alignSelf: 'center',
  },
});
