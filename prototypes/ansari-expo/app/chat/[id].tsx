import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  FlatList,
  Platform,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useQueryClient } from '@tanstack/react-query';
import { router, useLocalSearchParams } from 'expo-router';
import Head from 'expo-router/head';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Animated, {
  FadeIn,
  FadeInDown,
  interpolate,
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';
import { useColors } from '@/hooks/useColors';
import { useDesktop } from '@/hooks/useDesktop';
import { useKeyboardProgress } from '@/hooks/useKeyboard';
import { useSidebarInset } from '@/hooks/useSidebarCollapsed';
import { openSidebarDrawer } from '@/hooks/useSidebarDrawer';
import {
  setSourcePanelOpen,
  useSourcePanelInset,
  useSourcePanelPresentation,
} from '@/hooks/useSourcePanel';
import { fonts } from '@/constants/colors';
import {
  answerLeading,
  composerBottomPad,
  COMPOSER_KEYBOARD_PAD,
  CHROME_TOP,
  COMPOSER_TOP_PAD,
  phoneGutter,
  READING_COLUMN,
  THREAD_BOTTOM_PAD,
  THREAD_GAP,
  threadContentTop,
} from '@/constants/layout';
import { DURATION, EASE_OUT, SPRING } from '@/constants/motion';
import { tapHaptic } from '@/lib/haptics';
import { openMessageActions } from '@/lib/messageActions';
import { isHovered } from '@/lib/web';
import { heading, OFFSCREEN } from '@/lib/semantics';
import { useScreenLandmark } from '@/hooks/useScreenLandmark';
import { announce } from '@/lib/announce';
import { Placeholder, PlaceholderLine } from '@/components/Placeholder';
import { AnswerMessage } from '@/components/AnswerMessage';
import { AskedQuestion } from '@/components/AskedQuestion';
import { ChatInput } from '@/components/ChatInput';
import { EdgeSwipe } from '@/components/EdgeSwipe';
import {
  answerExcerpt,
  SourcePanel,
  type SourceRequest,
} from '@/components/SourcePanel';
import { GlassCircleButton } from '@/components/GlassCircleButton';
import { KeyboardAvoidingViewCompat } from '@/components/KeyboardAvoidingViewCompat';
import { PressableScale } from '@/components/PressableScale';
import { ThinkingLine } from '@/components/ThinkingLine';
import {
  getGetConversationQueryKey,
  getListConversationsQueryKey,
  useGetConversation,
  useSendMessage,
  type Message,
} from '@/lib/api';
import { reconcileThread } from '@/lib/chat-reconcile';
import { traceReducer, type TraceEntry } from '@/lib/chat-trace';
import { RADIUS, rounded } from '@/constants/radius';

// Key held by the question carried in from the home screen, and then
// by the server's copy of it once it arrives, so the row survives the
// hand-off without remounting.
const ECHO_ID = '__asked-question';

// Per-turn list key for the in-progress assistant answer. The synthetic
// streaming bubble and the persisted message it hands off to share one key,
// so the row updates in place instead of re-animating; the turn suffix keeps
// successive answers from colliding. (Same identity trick as ECHO_ID.)
const STREAM_KEY_PREFIX = '__streaming-answer-';

/**
 * The measures the first lines of an answer are held open at while a
 * conversation loads. Six lines is about the height an opening answer
 * runs to, and the last one is short — prose ends mid-measure.
 */
const ANSWER_HELD_LINES = ['96%', '99%', '93%', '97%', '90%', '46%'] as const;

// A new turn taking its place at the foot of the thread, and the
// chrome settling onto the paper behind it. Both built once, here:
// rebuilt inline they allocate a fresh descriptor on every render.
const TURN_ENTER = FadeInDown.duration(DURATION.enter)
  .easing(EASE_OUT)
  .reduceMotion(ReduceMotion.System);
const CHROME_ENTER = FadeIn.duration(DURATION.enter)
  .easing(EASE_OUT)
  .delay(60)
  .reduceMotion(ReduceMotion.System);

function SendFailure({
  question,
  onRetry,
}: {
  question: string;
  onRetry: () => void;
}) {
  const colors = useColors();
  return (
    <View
      style={[
        styles.sendFailure,
        { borderColor: colors.destructive, backgroundColor: colors.card },
      ]}
      accessibilityRole="alert"
    >
      <Feather name="alert-circle" size={17} color={colors.destructive} />
      <View style={styles.failureCopy}>
        <Text style={[styles.failureTitle, { color: colors.strongForeground }]}>
          Answer not delivered
        </Text>
        <Text
          style={[styles.failureText, { color: colors.mutedForeground }]}
          numberOfLines={2}
        >
          “{question}” was not delivered. Check your connection, then retry.
        </Text>
      </View>
      <PressableScale
        onPress={onRetry}
        accessibilityRole="button"
        accessibilityLabel={`Retry question: ${question}`}
        style={(state) => [
          styles.retryInline,
          {
            backgroundColor: colors.primary,
            opacity: state.pressed ? 0.78 : 1,
          },
        ]}
      >
        <Text
          style={[styles.retryInlineText, { color: colors.primaryForeground }]}
        >
          Retry
        </Text>
      </PressableScale>
    </View>
  );
}

export default function ChatScreen() {
  const colors = useColors();
  const screenLandmark = useScreenLandmark();
  const insets = useSafeAreaInsets();
  const queryClient = useQueryClient();
  const { id, q } = useLocalSearchParams<{ id: string; q?: string }>();
  const conversationId = id ?? '';
  // Which answer's sources are being shown, and which of its marks the
  // reader came in on. A source is never shown alone: the apparatus
  // belongs to the answer, so the request carries the whole ordered
  // list and the panel anchors within it.
  const [sources, setSources] = useState<SourceRequest | null>(null);
  const sourceRequests = useRef(0);
  const [failedQuestion, setFailedQuestion] = useState<string | null>(null);
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);
  const autoSent = useRef(false);

  // The answer as it streams in: appended text and the live retrieval trace,
  // both reset at the start of each send. `streamKey` is this turn's list key
  // (see STREAM_KEY_PREFIX); `keyOverrides` remaps a landed server message's id
  // to that key so the `done` hand-off swaps content in place with no remount.
  // `sentAtCount` is the persisted message count captured at send — `null`
  // (no baseline) is deliberately distinct from `0` (a loaded, empty thread);
  // see lib/chat-reconcile.ts.
  const [streamingText, setStreamingText] = useState('');
  const [trace, setTrace] = useState<TraceEntry[]>([]);
  const [keyOverrides, setKeyOverrides] = useState<Record<string, string>>({});
  const turnSeq = useRef(0);
  const streamKey = useRef('');
  const sentAtCount = useRef<number | null>(null);
  const listRef = useRef<FlatList<Message>>(null);
  // A scroll to the foot of the thread, asked for before the content
  // that justifies it has been laid out, and spent once it has.
  const scrollPending = useRef(false);
  // Whether the reader is reading the newest turn. Starts false so that
  // opening an existing conversation lands at its beginning rather than
  // jumping to the end of the last answer.
  const atBottom = useRef(false);
  const listHeight = useRef(0);

  const desktop = useDesktop();
  // The rail eats the left edge of the window; the thread insets by
  // exactly the same amount the ask does, so the hand-off does not
  // shift the reading column.
  const sidebarInset = useSidebarInset();

  // The sources panel eats the right edge the same way, and on the same
  // progress it slides in on — so the reading column re-flows in step
  // with it rather than being covered.
  const sourcesAsPanel = useSourcePanelPresentation();
  const sourcesInset = useSourcePanelInset();
  const panelOpen = sources !== null && sourcesAsPanel;
  useEffect(() => {
    setSourcePanelOpen(panelOpen);
  }, [panelOpen]);
  // The edge is shared with chrome the root layout owns, so the thread
  // gives it back on the way out.
  useEffect(() => () => setSourcePanelOpen(false), []);

  const openSources = (message: Message, marker: number) => {
    sourceRequests.current += 1;
    setSources({
      messageId: message.id,
      // Marker order, which is reading order: the apparatus is a list
      // of notes at the foot of the page, not a bag of sources.
      citations: [...message.citations].sort((a, b) => a.marker - b.marker),
      marker,
      excerpt: answerExcerpt(message.content),
      requestKey: sourceRequests.current,
    });
  };

  // The composer hugs the keyboard: safe-area padding collapses in
  // step with the keyboard animation. Native reads the real keyboard;
  // the web infers it from the viewport (see `hooks/useKeyboard`).
  const kb = useKeyboardProgress();
  const composerPad = useAnimatedStyle(() => ({
    paddingBottom: interpolate(
      kb.get(),
      [0, 1],
      [composerBottomPad(insets.bottom), COMPOSER_KEYBOARD_PAD],
    ),
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
        // The persisted answer is re-read from the detail query; the
        // synthetic streaming bubble stays up until it actually lands
        // (see the hand-off effect), so there is no gap at `done`.
        setFailedQuestion(null);
        queryClient.invalidateQueries({
          queryKey: getGetConversationQueryKey(conversationId),
        });
        queryClient.invalidateQueries({
          queryKey: getListConversationsQueryKey(),
        });
      },
      onError: (_error, variables) => {
        // A network error or a `type:"error"` SSE frame. The partial
        // `streamingText` is deliberately left on screen — the synthetic
        // bubble carries it above the failure notice.
        setFailedQuestion(variables.data.content);
      },
    },
    // Drive the incremental render: append `text` deltas, fold tool events
    // into the retrieval trace. `consume()` fires onEvent before validating,
    // so guard the non-string case before it throws.
    onEvent: (event) => {
      if (event.type === 'text') {
        if (typeof event.content === 'string') {
          setStreamingText((prev) => prev + event.content);
        }
      } else if (event.type === 'tool_call' || event.type === 'tool_result') {
        setTrace((prev) => traceReducer(prev, event));
      }
    },
  });

  // A follow-up asked from the foot of a long thread must not be
  // answered off-screen, so sending one brings the waiting line into
  // view. The question carried in from the ask is the exception: it
  // opens the thread at the head of the page and must stay there.
  //
  // Which is which cannot be inferred from the thread's contents — by
  // the time the carried-in question is sent it has already been drawn,
  // so the thread is not empty. Only the caller knows.
  const send = (content: string, opening = false) => {
    // Require the detail query to have RESOLVED: the reconciler's baseline
    // is the persisted message count at send, and without loaded data we
    // cannot capture a real one (`?? 0` would read an unloaded thread as
    // empty and make a pre-existing answer look like this turn's). The
    // composer is disabled until then too — this is defence in depth.
    if (!conversationId || !conversationQuery.data || sendMessage.isPending) {
      return;
    }
    setFailedQuestion(null);
    turnSeq.current += 1;
    streamKey.current = `${STREAM_KEY_PREFIX}${turnSeq.current}`;
    sentAtCount.current = conversationQuery.data.messages.length;
    setStreamingText('');
    setTrace([]);
    sendMessage.mutate({ conversationId, data: { content } });
    // Scrolling now would race the waiting line's own layout. The
    // request is parked and spent when the list reports its new size.
    if (!opening) scrollPending.current = true;
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
      send(q, true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, conversationQuery.data]);

  // Arriving from the home screen the question is already in hand, so it
  // goes on the paper at once — no spinner standing in for it. The pure
  // reconciler (lib/chat-reconcile.ts) does the identity reconciliation of
  // the carried-in question (ECHO_ID), the synthetic in-progress answer
  // bubble while text streams, and the landed-answer detection that drives
  // the `done` hand-off.
  const serverMessages = conversationQuery.data?.messages;
  const { messages, landedAnswer } = useMemo(
    () =>
      reconcileThread({
        serverMessages,
        q,
        conversationId,
        streamingText,
        streamKey: streamKey.current,
        sentAtCount: sentAtCount.current,
      }),
    // streamKey / sentAtCount are refs, current at each recompute; the
    // reactive inputs are the ones listed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [serverMessages, q, conversationId, streamingText],
  );

  // The row's stable list identity. On the `done` hand-off the landed
  // server message inherits the synthetic bubble's key, so the FlatList
  // row updates in place instead of remounting.
  const keyFor = useCallback(
    (m: Message) => keyOverrides[m.id] ?? m.id,
    [keyOverrides],
  );

  // A row in a virtualized list is unmounted as it scrolls out of the
  // window and mounted again on the way back, so an entrance attached
  // to one replays every time the reader scrolls up through a long
  // conversation — the thread appears to write itself all over again.
  //
  // Only genuinely new content animates. Everything the thread was
  // already holding when it first loaded is history and is simply
  // there; everything drawn since is recorded on the commit that drew
  // it, so it can only ever animate once. The record is keyed by list
  // identity (`keyFor`), not raw message id, so the streaming hand-off
  // — where a persisted id takes on the synthetic bubble's key — does
  // not read as a fresh row. The record is a ref, because reading it
  // decides what animates and writing it must not itself cause a render.
  const drawn = useRef<Set<string> | null>(null);
  const isNewContent = (key: string) =>
    drawn.current !== null && !drawn.current.has(key);
  useEffect(() => {
    // Nothing counts as history until the conversation has actually
    // loaded — otherwise the whole thread arrives "new" a beat later.
    if (!serverMessages) return;
    if (drawn.current === null) {
      drawn.current = new Set(messages.map(keyFor));
      return;
    }
    for (const message of messages) drawn.current.add(keyFor(message));
  }, [serverMessages, messages, keyFor]);

  // Hand-off on `done`: once this turn's answer is persisted, remap its
  // server id to the stream key its synthetic bubble used and clear the
  // streaming state in the same commit — no duplicate, no gap. The landed
  // message also inherits the bubble's "already drawn" status, so the
  // in-place swap is not mistaken for new content and re-animated.
  useEffect(() => {
    if (streamingText && landedAnswer) {
      const key = streamKey.current;
      const id = landedAnswer.id;
      setKeyOverrides((prev) =>
        prev[id] === key ? prev : { ...prev, [id]: key },
      );
      drawn.current?.add(key);
      setStreamingText('');
      setTrace([]);
    }
  }, [streamingText, landedAnswer]);

  // The thread is waiting on an answer while a follow-up is in flight,
  // or while the question we arrived with has yet to be answered.
  const lastMessage = messages[messages.length - 1];
  const awaitingAnswer =
    sendMessage.isPending ||
    (!!q &&
      !sendMessage.isError &&
      !conversationQuery.isError &&
      lastMessage?.role === 'user');

  // Said out loud, because nothing else says it.
  //
  // The waiting mark and the answer appearing are both visual: the page
  // changes under a reader who is not looking at it, and neither change
  // moves the focus, so a screen reader has no reason to speak. Without
  // this, asking a question is followed by silence, and the reply is
  // simply there the next time the reader thinks to go looking.
  //
  // Twice per answer and no more. The stream is not narrated — an
  // assistant message grows a word at a time, and announcing its
  // content, or announcing it again on each chunk, would talk over the
  // reader for as long as the answer takes to write. What is announced
  // is the turn: work started, work finished. The answer itself is on
  // the page to be read at the reader's own pace.
  const wasAwaiting = useRef(false);
  useEffect(() => {
    if (awaitingAnswer) {
      wasAwaiting.current = true;
      announce('Ansari is working on your answer.');
      return;
    }
    // Only for a wait this screen actually saw begin: opening a
    // finished conversation from the rail arrives with the answer
    // already written, and has nothing to announce.
    if (!wasAwaiting.current) return;
    wasAwaiting.current = false;
    if (lastMessage?.role === 'assistant') {
      announce('Ansari has answered. The reply is on the page.');
    }
  }, [awaitingAnswer, lastMessage?.role]);

  // A full-screen spinner is only honest when there is genuinely
  // nothing to show; with a question in hand there always is.
  const showLoadingScreen = conversationQuery.isLoading && !q;

  // Arriving from the ask, the question and the waiting line are
  // already on screen — the home screen drew them, in these positions,
  // before handing over. Replaying their entrances here is what made
  // the transition read as a stutter, so they are held still.
  //
  // The test is identity, not timing: the carried-in question is the
  // only message that ever holds ECHO_ID, and the waiting line is the
  // carried-in one exactly while that is the message it sits under.
  // Everything else — a follow-up typed here, its waiting line, every
  // answer — is genuinely new and animates in.
  const carriedInWait = lastMessage?.id === ECHO_ID;

  // What this thread is called, wherever its name is shown: the rail on
  // desktop, the frosted bar on a phone, the browser tab on both.
  const threadTitle = conversationQuery.data?.title || q || '';
  const jumpToLatest = () => {
    listRef.current?.scrollToEnd({ animated: true });
    setShowJumpToLatest(false);
  };

  // Out of the thread with a swipe from the left edge.
  //
  // The page goes with the finger rather than waiting for it to be
  // let go, which is the whole difference between a gesture and a
  // hidden button: a reader can start the swipe, see the home screen
  // behind, change their mind and put the thread back. The travel is
  // the width of the screen, so carrying it 40% of the way over is
  // what commits — the same fraction a sheet is dismissed on.
  const { width: screenWidth } = useWindowDimensions();
  // The phone's page: side air, and with it the reading measure, come
  // from the window rather than from one figure used at every size.
  const gutter = phoneGutter(screenWidth);
  // How tall the composer block stands, safe area and all. The
  // jump-to-latest pill is placed off this rather than off a guessed
  // number — the composer grows with a long follow-up and shrinks onto
  // the keyboard, and a fixed offset lands the pill on top of it in one
  // state or floating in the middle of the paper in the other.
  const [composerBlock, setComposerBlock] = useState(0);
  const backSwipe = useSharedValue(0);
  const backSlide = useAnimatedStyle(() => ({
    transform: [{ translateX: backSwipe.get() * screenWidth }],
  }));
  const settleBackSwipe = useCallback(
    (committed: boolean, velocity: number) => {
      if (!committed) {
        backSwipe.set(
          withSpring(0, {
            ...SPRING.snap,
            velocity,
            reduceMotion: ReduceMotion.System,
          }),
        );
        return;
      }
      // Carry it the rest of the way out while the route changes under
      // it, so the page leaves at the speed the hand was moving.
      backSwipe.set(
        withSpring(1, {
          ...SPRING.glide,
          velocity,
          reduceMotion: ReduceMotion.System,
        }),
      );
      // A thread opened from the rail replaces the one before it, so
      // there is not always something behind: leaving always means the
      // page a reader started from.
      if (router.canGoBack()) router.back();
      else router.replace('/');
    },
    [backSwipe],
  );

  return (
    // The paper is mounted once by the root layout, above every screen,
    // along with the rail and the account cluster: they are on the ask
    // too, in these positions, and re-mounting them at the hand-off is
    // what made the rail lose its place and the account links blink.
    // The root layout also takes the grain off for this route — under a
    // full column of answer text the tile only competes with the
    // letterforms — and fades it rather than cutting it.
    <EdgeSwipe
      progress={backSwipe}
      span={screenWidth}
      onSettle={settleBackSwipe}
      enabled={!desktop}
    >
      <Animated.View style={[styles.flex, backSlide]}>
        {Platform.OS === 'web' && (
          <Head>
            <title>{threadTitle ? `${threadTitle} — Ansari` : 'Ansari'}</title>
          </Head>
        )}
        {/* The inset is animated, so it sits on a wrapper of its own: the
          thread's left edge is driven by the rail's own collapse
          progress, exactly as the ask's is, so the reading column
          travels with the rail's edge rather than jumping to meet it. */}
        <Animated.View
          style={[
            styles.flex,
            desktop && sidebarInset,
            sourcesAsPanel && sourcesInset,
          ]}
          {...screenLandmark}
        >
          {/* Every screen owes a reader one top-level heading, and a
              thread's title is written in the chrome — the rail and the
              browser tab — rather than on the page, because the
              question is the page's first line and a title above it
              would say the same thing twice. So the outline gets one
              that is never painted. */}
          {Platform.OS === 'web' && !!threadTitle && (
            <Text style={OFFSCREEN} {...heading(1)}>
              {threadTitle}
            </Text>
          )}
          <KeyboardAvoidingViewCompat style={styles.flex}>
            {showLoadingScreen ? (
              // The thread's opening turn, held open at the geometry it
              // will arrive in: the question at the head of the page,
              // where the ask left it, and the first lines of its answer
              // beneath. The conversation fills these shapes rather than
              // replacing a centred spinner with a page of text.
              <Placeholder
                style={[
                  styles.messages,
                  !desktop && { paddingHorizontal: gutter },
                  desktop && styles.messagesDesktop,
                  { paddingTop: threadContentTop(desktop, insets.top) },
                ]}
              >
                <View style={styles.heldQuestionRow}>
                  <View style={styles.heldQuestionBubble}>
                    <PlaceholderLine width="100%" lineHeight={22} />
                  </View>
                </View>
                <View>
                  {ANSWER_HELD_LINES.map((width, index) => (
                    <PlaceholderLine
                      key={index}
                      width={width}
                      lineHeight={answerLeading(desktop, screenWidth)}
                    />
                  ))}
                </View>
              </Placeholder>
            ) : conversationQuery.isError ? (
              <View style={styles.center}>
                <Feather
                  name="alert-circle"
                  size={22}
                  color={colors.destructive}
                />
                <Text
                  style={[styles.errorText, { color: colors.mutedForeground }]}
                >
                  This conversation didn't load. Check your connection.
                </Text>
                <PressableScale
                  onPress={() => conversationQuery.refetch()}
                  // "Try again" alone says nothing about what would be
                  // tried; the message above it is not read with the
                  // button when a reader tabs straight to it.
                  accessibilityRole="button"
                  accessibilityLabel="Try loading this conversation again"
                  style={(state) => [
                    styles.retryButton,
                    {
                      backgroundColor: colors.primary,
                      ...rounded(RADIUS.md),
                      opacity: state.pressed
                        ? 0.85
                        : isHovered(state)
                          ? 0.92
                          : 1,
                    },
                  ]}
                >
                  <Text
                    style={[
                      styles.retryText,
                      { color: colors.primaryForeground },
                    ]}
                  >
                    Try again
                  </Text>
                </PressableScale>
              </View>
            ) : (
              <FlatList
                ref={listRef}
                data={messages}
                keyExtractor={keyFor}
                scrollEnabled={!!messages.length || awaitingAnswer}
                contentContainerStyle={[
                  styles.messages,
                  !desktop && { paddingHorizontal: gutter },
                  desktop && styles.messagesDesktop,
                  // Clearance for the frosted bar, so the opening question
                  // never loads trapped beneath it.
                  { paddingTop: threadContentTop(desktop, insets.top) },
                ]}
                keyboardDismissMode={
                  Platform.OS === 'ios' ? 'interactive' : 'on-drag'
                }
                keyboardShouldPersistTaps="handled"
                // Indicators are hidden by design, so none can ride under
                // the frosted bar; nothing needs indicator insets.
                showsVerticalScrollIndicator={false}
                onScroll={(event) => {
                  const { contentOffset, contentSize, layoutMeasurement } =
                    event.nativeEvent;
                  const fromBottom =
                    contentSize.height -
                    layoutMeasurement.height -
                    contentOffset.y;
                  atBottom.current = fromBottom <= 160;
                  setShowJumpToLatest(!atBottom.current);
                }}
                scrollEventThrottle={100}
                onContentSizeChange={() => {
                  if (!scrollPending.current) return;
                  scrollPending.current = false;
                  listRef.current?.scrollToEnd({ animated: true });
                }}
                onLayout={(event) => {
                  // The keyboard opening (and a window resize, and rotation)
                  // shortens the list without moving it. A reader who was on
                  // the newest turn would be left looking at the middle of
                  // it, with a "Latest" button offering to undo something
                  // they never did.
                  const { height } = event.nativeEvent.layout;
                  const shortened =
                    listHeight.current > 0 && height < listHeight.current;
                  listHeight.current = height;
                  if (shortened && atBottom.current) {
                    listRef.current?.scrollToEnd({ animated: false });
                  }
                }}
                // The waiting line sits beneath the question that prompted
                // it, at the foot of the thread. It carries the live
                // retrieval trace while the model searches; once the answer
                // itself is streaming, the synthetic bubble in the list
                // carries it and the line steps aside.
                ListFooterComponent={
                  awaitingAnswer && !streamingText ? (
                    <ThinkingLine animate={!carriedInWait} trace={trace} />
                  ) : failedQuestion ? (
                    <SendFailure
                      question={failedQuestion}
                      onRetry={() => send(failedQuestion)}
                    />
                  ) : null
                }
                renderItem={({ item }) => (
                  // The question carried in from the ask is already drawn,
                  // at the head of the page, on the screen we came from, so
                  // it is history the moment this thread loads and does not
                  // animate. A follow-up typed here, and every answer, is
                  // new: it rises into place, once.
                  <Animated.View
                    entering={
                      isNewContent(keyFor(item)) ? TURN_ENTER : undefined
                    }
                  >
                    {item.role === 'user' ? (
                      <ThreadQuestion text={item.content} />
                    ) : (
                      <AnswerMessage
                        message={item}
                        onSourcesOpen={openSources}
                      />
                    )}
                  </Animated.View>
                )}
              />
            )}
            {showJumpToLatest &&
              !showLoadingScreen &&
              !conversationQuery.isError && (
                <PressableScale
                  onPress={jumpToLatest}
                  accessibilityRole="button"
                  accessibilityLabel="Jump to latest message"
                  style={(state) => [
                    styles.jumpToLatest,
                    {
                      // Clear of the composer, whatever the composer is
                      // currently doing: it stands on the measured height
                      // of the whole block — safe area, keyboard padding
                      // and a grown field included — rather than on a
                      // number that was true of one state of it.
                      right: desktop ? 18 : gutter,
                      bottom: (composerBlock || 92) + 10,
                      backgroundColor: colors.card,
                      borderColor: colors.border,
                      opacity: state.pressed ? 0.72 : 1,
                    },
                  ]}
                >
                  <Feather
                    name="arrow-down"
                    size={15}
                    color={colors.foreground}
                  />
                  <Text style={[styles.jumpText, { color: colors.foreground }]}>
                    Latest
                  </Text>
                </PressableScale>
              )}

            <Animated.View
              style={[
                styles.inputBarContainer,
                !desktop && { paddingHorizontal: gutter },
                desktop && styles.composerDesktop,
                composerPad,
              ]}
              onLayout={(event) =>
                setComposerBlock(event.nativeEvent.layout.height)
              }
            >
              <ChatInput
                onSend={(content: string) => send(content)}
                sending={sendMessage.isPending}
                placeholder="Ask a follow-up…"
                disabled={conversationQuery.isError}
              />
            </Animated.View>
          </KeyboardAvoidingViewCompat>
        </Animated.View>

        {/* The ask clears its own floating controls on the way out, so
          the thread's chrome fades onto bare paper instead of swapping
          one set of buttons for another mid-cut. */}
        <Animated.View
          entering={CHROME_ENTER}
          style={StyleSheet.absoluteFill}
          pointerEvents="box-none"
        >
          {/* Desktop names the thread in the rail, where the rest of the
            navigation already is, and starts a new question from there
            too — so there is nothing left for a bar to carry, and an
            empty band of chrome ruled across the top of the page is
            worse than none.

            A phone reaches that same rail through the drawer, so the
            same reasoning now applies to it: back and a new question
            are both a tap into the rail, and the thread is already
            named at the head of the page by the question that opened
            it — far better read than a truncated copy of itself in a
            bar. With nothing left to carry, the bar goes with them.
            What remains is the one disc the empty screen floats, in
            the same place, so crossing from the ask to the thread
            leaves it apparently untouched. */}
          {!desktop && (
            <View
              style={[
                styles.chrome,
                { top: insets.top + CHROME_TOP, left: gutter, right: gutter },
              ]}
              pointerEvents="box-none"
            >
              <GlassCircleButton
                onPress={openSidebarDrawer}
                accessibilityLabel="Menu"
                testID="menu-button"
              >
                <Feather name="menu" size={19} color={colors.foreground} />
              </GlassCircleButton>
            </View>
          )}
        </Animated.View>

        <SourcePanel request={sources} onClose={() => setSources(null)} />
      </Animated.View>
    </EdgeSwipe>
  );
}

/**
 * A question in the thread, and what a thumb can do with it.
 *
 * Selection starts off on a phone and is switched on by the hold menu,
 * because a selectable <Text> claims the long press for the platform's
 * own magnifier — the menu that offers selection could not be opened
 * from words that were already selectable. Once it is on it stays on
 * for as long as the message is on screen, and the platform's own
 * selection menu takes over from there. The web has a cursor, no hold
 * menu, and nothing to arbitrate: the words are simply selectable.
 */
function ThreadQuestion({ text }: { text: string }) {
  const [selecting, setSelecting] = useState(Platform.OS === 'web');
  return (
    <AskedQuestion
      text={text}
      selectable={selecting}
      onLongPress={
        Platform.OS === 'web'
          ? undefined
          : () => {
              tapHaptic();
              openMessageActions({
                kind: 'question',
                text,
                onSelectText: () => setSelecting(true),
              });
            }
      }
    />
  );
}

const styles = StyleSheet.create({
  flex: {
    flex: 1,
  },
  // The empty screen's chrome box, to the point: the same edge margin
  // and the same row, so the menu disc lands on the identical pixels
  // on both screens.
  chrome: {
    position: 'absolute',
    left: 18,
    right: 18,
    zIndex: 20,
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
  },
  // The opening question's own box, from `AskedQuestion` — the same
  // right-hand alignment, the same measure and the same padding, so the
  // held turn and the real one occupy the same rectangle.
  heldQuestionRow: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
  },
  heldQuestionBubble: {
    width: '62%',
    maxWidth: '84%',
    paddingHorizontal: 15,
    paddingVertical: 11,
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
  //
  // A conversation reads downward from its opening question: the thread
  // hangs from the head of the page and grows toward the composer,
  // rather than sitting on the composer and pushing upward. That is
  // what lets the question the reader just asked stay put while its
  // answer is written beneath it.
  messages: {
    flexGrow: 1,
    paddingHorizontal: 16,
    paddingBottom: THREAD_BOTTOM_PAD.phone,
    gap: THREAD_GAP.phone,
  },
  // Desktop: the thread reads as a centered column with a book-like
  // measure and a touch more air between turns.
  messagesDesktop: {
    width: '100%',
    maxWidth: READING_COLUMN,
    alignSelf: 'center',
    paddingBottom: THREAD_BOTTOM_PAD.desktop,
    gap: THREAD_GAP.desktop,
  },
  sendFailure: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'stretch',
    gap: 10,
    borderWidth: StyleSheet.hairlineWidth,
    ...rounded(RADIUS.md),
    padding: 12,
  },
  failureCopy: { flex: 1, gap: 2 },
  failureTitle: { fontSize: 13.5, fontFamily: fonts.bodySemiBold },
  failureText: { fontSize: 12.5, lineHeight: 17, fontFamily: fonts.body },
  retryInline: {
    minHeight: 34,
    // A stadium: `pill` is larger than half the height, so the
    // platform clamps it back to exactly the 17 it drew before.
    ...rounded(RADIUS.pill),
    paddingHorizontal: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  retryInlineText: { fontSize: 12, fontFamily: fonts.bodySemiBold },
  // Placed at render: it stands on the page's gutter and on the
  // composer's measured height, neither of which is a constant.
  jumpToLatest: {
    position: 'absolute',
    zIndex: 15,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    minHeight: 38,
    paddingHorizontal: 13,
    ...rounded(RADIUS.pill),
    borderWidth: StyleSheet.hairlineWidth,
  },
  jumpText: { fontSize: 12.5, fontFamily: fonts.bodySemiBold },
  inputBarContainer: {
    paddingHorizontal: 16,
    paddingTop: COMPOSER_TOP_PAD,
  },
  composerDesktop: {
    width: '100%',
    maxWidth: READING_COLUMN,
    alignSelf: 'center',
  },
});
