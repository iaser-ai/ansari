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
import { Feather } from '@expo/vector-icons';
import { useQueryClient } from '@tanstack/react-query';
import { router, useFocusEffect } from 'expo-router';
import Head from 'expo-router/head';
import { KeyboardController } from 'react-native-keyboard-controller';
import Animated, {
  FadeInDown,
  interpolate,
  ReduceMotion,
  useAnimatedStyle,
  useDerivedValue,
  useReducedMotion,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useColors } from '@/hooks/useColors';
import { useDesktop } from '@/hooks/useDesktop';
import { useKeyboardProgress } from '@/hooks/useKeyboard';
import { useSidebarEdge, useSidebarInset } from '@/hooks/useSidebarCollapsed';
import {
  openSidebarDrawer,
  settleSidebarDrawer,
  useSidebarDrawer,
  useSidebarDrawerProgress,
} from '@/hooks/useSidebarDrawer';
import { fonts } from '@/constants/colors';
import { DURATION, EASE_OUT, SPRING } from '@/constants/motion';
import {
  CHROME_TOP,
  composerBottomPad,
  COMPOSER_KEYBOARD_PAD,
  PHONE_SHORT_MAX_HEIGHT,
  phoneGutter,
  phoneMarkHeight,
  phoneSize,
  READING_COLUMN,
  SIDEBAR_WIDTH,
  THREAD_GAP,
  threadContentTop,
} from '@/constants/layout';
import { withAlpha } from '@/lib/color';
import { setAskExit } from '@/lib/askExit';
import { tickHaptic } from '@/lib/haptics';
import { toast } from '@/lib/toast';
import { heading } from '@/lib/semantics';
import { useScreenLandmark } from '@/hooks/useScreenLandmark';
import { AnsariMarkSpin } from '@/components/AnsariMarkSpin';
import { AskedQuestion } from '@/components/AskedQuestion';
import { ChatInput } from '@/components/ChatInput';
import { EdgeSwipe } from '@/components/EdgeSwipe';
import { GlassCircleButton } from '@/components/GlassCircleButton';
import { KeyboardAvoidingViewCompat } from '@/components/KeyboardAvoidingViewCompat';
import {
  Placeholder,
  PlaceholderLine,
  PlaceholderMark,
} from '@/components/Placeholder';
import { PressableScale } from '@/components/PressableScale';
import { ThinkingLine } from '@/components/ThinkingLine';
import {
  getListConversationsQueryKey,
  getListSuggestedQuestionsQueryKey,
  useCreateConversation,
  useListSuggestedQuestions,
} from '@/lib/api';
import { RADIUS, rounded } from '@/constants/radius';

// The ask is a single move, so the thread must not arrive before the
// paper has finished clearing. Conversation creation is usually faster
// than the eye: if it returns early we hold the push until the home
// screen's exit has actually played out — the greeting clearing, the
// composer settling to the foot of the page, the question lifting out
// of it, the waiting line appearing beneath. By the time it ends this
// screen is already showing the thread's first frame, so the hand-off
// has nothing left to animate and nothing left to jump.
const MIN_EXIT_MS = 460;

const QUESTION_ENTER = FadeInDown.duration(DURATION.enter)
  .easing(EASE_OUT)
  .reduceMotion(ReduceMotion.System);

/**
 * A web-only `touch-action: pan-x`, for the one scroller in the app
 * that runs sideways. `touchAction` is a real react-native-web style
 * key (its own ScrollView uses it) but not a react-native one, so it
 * is cast in rather than declared — and it is simply absent on native.
 */
const PAN_X =
  Platform.OS === 'web' ? ({ touchAction: 'pan-x' } as object) : null;
export default function HomeScreen() {
  const colors = useColors();
  const screenLandmark = useScreenLandmark();
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
      // The paper's ambient layer is listening for this: back on the
      // home screen, the shadow eases in again.
      setAskExit(false);
      return () => setIsFocused(false);
    }, []),
  );
  const insets = useSafeAreaInsets();
  const queryClient = useQueryClient();
  const [pendingQuestion, setPendingQuestion] = useState<string | null>(null);

  // The new symbol is portrait-oriented, so size it by height rather than
  // inheriting the old width-based logotype rule. Only the phone hero
  // draws it large; desktop wears the lockup small, in the rail.
  const desktop = useDesktop();
  const sidebarInset = useSidebarInset();
  const sidebarEdge = useSidebarEdge();
  const { width: screenWidth, height: screenHeight } = useWindowDimensions();
  // The phone's page resolves from its own scale rather than from one
  // set of numbers stretched across every handset: the side air, the
  // emblem's size and the greeting's setting all come from the width
  // (and, for the emblem, from the paper actually left above the
  // composer once the safe areas are taken out).
  const gutter = phoneGutter(screenWidth);
  const size = phoneSize(screenWidth);
  const shortWindow = screenHeight <= PHONE_SHORT_MAX_HEIGHT;
  const markHeight = phoneMarkHeight(
    screenWidth,
    screenHeight - insets.top - insets.bottom,
  );
  // The shelf is full-bleed and pans past both edges. Its questions
  // begin on the page's gutter and come to rest a clear step inside the
  // trailing one, so the shelf ends with air after it rather than
  // against the glass — and no single chip is ever allowed to fill the
  // width, which is what keeps the next one showing at the edge and the
  // shelf reading as something that continues.
  const shelfPad = {
    paddingLeft: gutter,
    paddingRight: gutter + 12,
  };
  const chipMax = { maxWidth: Math.min(260, screenWidth - gutter * 2 - 44) };

  // When the keyboard opens, the composer should hug it: the safe-area
  // padding and the footer line collapse in step with the keyboard.
  // Native reads the real keyboard; the web infers it from the
  // viewport, and both arrive here as the same 0 → 1.
  const kb = useKeyboardProgress();
  const nativeKeyboard = Platform.OS !== 'web';

  // Whether the composer holds the caret. On the web this is the only
  // notice the app gets that a keyboard is on its way: it arrives with
  // the tap, before the browser has begun to move.
  // The drawer's own state, read here so the edge swipe below can drive
  // it directly rather than through a second copy of it.
  const drawerOpen = useSidebarDrawer();
  const drawerProgress = useSidebarDrawerProgress();

  const [composerActive, setComposerActive] = useState(false);
  // Returning to this screen must never leave the furniture hidden by a
  // stale focus flag from before navigation.
  useEffect(() => {
    if (isFocused) setComposerActive(false);
  }, [isFocused]);

  // Dismissing the keyboard by tapping the paper must not depend on any
  // single mechanism: core Keyboard.dismiss() rides JS focus tracking
  // that can silently no-op on the new architecture, so blur the field
  // directly through its ref and also ask the keyboard library's native
  // module (provably alive on device — it animates the composer) to
  // resign the keyboard itself.
  const inputRef = useRef<TextInput>(null);
  const closeKeyboard = () => {
    inputRef.current?.blur();
    if (Platform.OS !== 'web') {
      KeyboardController.dismiss();
    }
    Keyboard.dismiss();
  };
  const dismissComposer = () => {
    // A quiet tick confirms the paper heard the tap.
    if (kb.get() > 0.05) tickHaptic();
    closeKeyboard();
  };
  const bottomPad = useAnimatedStyle(() => ({
    // The collapsed value matches the thread's composer exactly: a
    // question sent with the keyboard up must not land on a screen
    // that pads its composer differently.
    paddingBottom: interpolate(
      kb.get(),
      [0, 1],
      [composerBottomPad(insets.bottom), COMPOSER_KEYBOARD_PAD],
    ),
  }));
  // The emblem is the first thing to give up its room when the keyboard
  // takes the page. What the app is handed then is the strip left above
  // the keyboard — shorter than the hero's full stack — and a stack
  // centred in a box too small for it is cut off at both ends: on a
  // phone browser that shows as the mark sliced by the top of the
  // glass. Its height leaves with its opacity, so the hero closes up
  // around the greeting instead.
  //
  // Native only. A phone browser leaves more room than the keyboard
  // controller does — there is no navigation bar over the composer and
  // the chips have already stepped aside — and the emblem and greeting
  // fit above the keyboard there. The shell shortening around them is
  // the whole of the movement: they glide up into the band left between
  // the composer and the top of the screen, and stay legible while the
  // reader types.
  const lockupCollapse = useAnimatedStyle(() => ({
    opacity: 1 - (nativeKeyboard ? kb.get() : 0),
    height: markHeight * (1 - (nativeKeyboard ? kb.get() : 0)),
  }));
  // How far the home screen has cleared itself for the ask (0 → 1).
  // Driven below, but declared here so the footer can ride it too.
  const heroGone = useSharedValue(0);
  const footerCollapse = useAnimatedStyle(() => {
    // The disclaimer steps aside for the keyboard and, once a question
    // is on its way, clears with the rest of the empty-screen furniture.
    // It must collapse its *height* on the way out, not just fade: the
    // thread has no disclaimer, so leaving 15pt of ghost space here
    // would drop the composer by that much at the hand-off.
    // The keyboard term is native's alone, for the same reason the
    // emblem's is: on the web the shell has already made the room.
    const keyboard = nativeKeyboard ? kb.get() : 0;
    const away = Math.max(keyboard, heroGone.get());
    return {
      opacity: (1 - keyboard) * (1 - heroGone.get()),
      height: 15 * (1 - away),
      marginTop: -12 * away,
    };
  });

  // The suggested-question chips step aside while the user composes.
  // On native their collapse rides the keyboard's own animated progress —
  // the same shared value that makes the composer hug the keyboard, so if
  // one moves the other must. (Keyboard *events* and input blur have both
  // proven unreliable on device; the progress value is the only signal
  // we've watched work there.) On web, where that progress never moves,
  // field focus stands in. Once a question is on its way the chips stay
  // away until it settles.
  const jsHidden = pendingQuestion !== null || composerActive;
  const jsGone = useSharedValue(0);
  useEffect(() => {
    // A shelf of chips stepping aside is a small state change, and it
    // is leaving as often as it is arriving: the one ease-out curve
    // covers both directions.
    jsGone.set(
      withTiming(jsHidden ? 1 : 0, {
        duration: DURATION.state,
        easing: EASE_OUT,
      }),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jsHidden]);
  // The keyboard term is not native's alone. On the web the shell
  // shortens for the keyboard in a single frame, and a shelf easing
  // aside over its own two hundred milliseconds while everything around
  // it has already stepped is one movement too many — several speeds at
  // once is what reads as broken. Riding the same progress as the shell
  // puts the shelf's exit in the same frame as the reshape going in,
  // and lets it ease back with the shell coming out.
  const chipsGone = useDerivedValue(() => Math.max(jsGone.get(), kb.get()));
  const chipsHeight = useSharedValue(0);
  const chipsCollapse = useAnimatedStyle(() => {
    const gone = chipsGone.get();
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
    if (gone > 0 && chipsHeight.get() > 0) {
      style.height = (1 - gone) * chipsHeight.get();
    }
    return style;
  });

  // Desktop's sample lines dissolve while the user composes — opacity
  // only, no height collapse, so the centered composer never shifts.
  const linesFade = useAnimatedStyle(() => ({
    opacity: 1 - chipsGone.get(),
    pointerEvents:
      chipsGone.get() > 0.05 ? ('none' as const) : ('auto' as const),
  }));

  // The ask starts the instant the question leaves the composer, not
  // when the server answers: the wordmark and greeting clear away at
  // once, so the conversation-creation round trip is covered by motion
  // rather than by a frozen screen. The paper and the composer never
  // move — only what is written on them changes.
  const reducedMotion = useReducedMotion();
  const asking = pendingQuestion !== null;
  useEffect(() => {
    // Furniture leaving quicker than it comes back: nobody watches a
    // greeting go, but they do watch it return.
    heroGone.set(
      withTiming(asking ? 1 : 0, {
        duration: asking ? DURATION.exit : DURATION.enter,
        easing: EASE_OUT,
      }),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asking]);
  const heroExit = useAnimatedStyle(() => ({
    opacity: 1 - heroGone.get(),
    // With reduce motion on, the greeting simply clears — no travel.
    transform: [{ translateY: reducedMotion ? 0 : -10 * heroGone.get() }],
  }));
  // Everything else that belongs to the empty screen — the floating
  // controls, the desktop disclaimer — clears on the same curve.
  const heroFade = useAnimatedStyle(() => ({ opacity: 1 - heroGone.get() }));

  // Desktop centres the whole ask — wordmark, composer, sample lines —
  // in the middle of the page, while a thread pins its composer to the
  // foot. Cutting between the two positions is the single biggest jolt
  // in the hand-off, so the ask block *travels*: it glides down to the
  // exact spot the thread's composer will occupy, and the route change
  // then happens between two identical pictures.
  //
  // The distance is measured, not guessed: the stage's height, the
  // block's offset inside it, and the composer's own height are all
  // read from layout, so it stays right at any window size or font
  // scale. If any measurement is missing the block simply doesn't move.
  const stageHeight = useRef(0);
  const blockTop = useRef(0);
  const composerHeight = useRef(0);
  const [glideDistance, setGlideDistance] = useState(0);
  const measureGlide = React.useCallback(() => {
    // Never retarget mid-flight: a late layout pass (a font settling, a
    // scrollbar appearing) arriving during the exit would visibly yank
    // the block to a new destination.
    if (pendingQuestion !== null) return;
    // Every dimension must be in hand. A partial tuple — most often
    // blockTop still at its initial 0 because the centred layout hasn't
    // been measured yet — would compute a destination well past the
    // foot of the page.
    const measured =
      desktop &&
      stageHeight.current > 0 &&
      blockTop.current > 0 &&
      composerHeight.current > 0;
    const next = measured
      ? Math.max(
          0,
          Math.round(
            stageHeight.current -
              composerBottomPad(insets.bottom) -
              composerHeight.current -
              blockTop.current,
          ),
        )
      : 0;
    setGlideDistance((current) => (current === next ? current : next));
  }, [desktop, insets.bottom, pendingQuestion]);
  // Window resizes and inset changes reach the layout handlers, but a
  // change in `desktop` or the safe area alone must recompute too.
  useEffect(() => {
    measureGlide();
  }, [measureGlide]);
  const glide = useSharedValue(0);
  useEffect(() => {
    // The block is coming to rest, not fading, so it springs. Critically
    // damped, deliberately: the spot it lands on is the thread's
    // composer position, and a spring that overshot would push the
    // composer past the picture the next screen opens on.
    //
    // Reduce motion still needs the block to *be* in the right place at
    // the hand-off — it just gets there without the travel, which is
    // what ReduceMotion.System does to a spring.
    glide.set(
      withSpring(asking ? 1 : 0, {
        ...SPRING.settle,
        reduceMotion: ReduceMotion.System,
      }),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asking]);
  // `glideDistance` is frozen for the duration of the ask, so the
  // travel and its destination cannot change once it has begun.
  const glideDown = useAnimatedStyle(() => ({
    transform: [{ translateY: glide.get() * glideDistance }],
  }));

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
      onError: (_error, variables) => {
        setPendingQuestion(null);
        // The hand-off is off: the page is staying here, so the grain
        // and the shadow come back with the greeting.
        setAskExit(false);
        // The retry lives in the notice itself: the reader's question is
        // still in hand, so asking again is one tap rather than a modal
        // to clear and a composer to refill.
        const question = variables.data.title ?? '';
        toast.error("Couldn't start that question", {
          detail: 'Check your connection and ask again.',
          action: question
            ? { label: 'Try again', onPress: () => ask(question) }
            : undefined,
        });
      },
    },
  });

  const askedAt = useRef(0);
  const ask = (question: string) => {
    if (pendingQuestion) return;
    // Let the keyboard go before the exit begins. The thread arrives
    // with nothing focused, so leaving it up here would mean handing
    // over between a keyboard-raised composer and a keyboard-down one
    // — the composer would drop the keyboard's height at the cut.
    closeKeyboard();
    askedAt.current = Date.now();
    setPendingQuestion(question);
    // The ambient shadow lives on the paper, above the screens, so it
    // has to hear about the exit from here — its fade runs against the
    // glide rather than starting late, at the cut.
    setAskExit(true);
    createConversation.mutate({ data: { title: question } });
  };

  const questions = useMemo(
    () => (suggestedQuery.data ?? []).flatMap((topic) => topic.questions),
    [suggestedQuery.data],
  );

  // Suggested questions. Phones keep the horizontal chip shelf under
  // the thumb. Desktop shows three quiet sample lines beneath the
  // centered composer — plain inked text, no chip furniture.
  const chipElements = questions.map((question) => (
    <SuggestionChip
      key={question}
      question={question}
      maxWidth={chipMax}
      onPress={ask}
    />
  ));

  // Each suggestion reads as a trending search: a small trend mark,
  // then the question. The rows' left edge lines up exactly with the
  // text inside the composer (card inset 16 + card padding 12 + field
  // padding 10 = 38).
  const suggestionLines = questions
    .slice(0, 3)
    .map((question) => (
      <SuggestionLine key={question} question={question} onPress={ask} />
    ));

  // Held space for the suggestion row. The row is a first-load-only
  // shape: `isLoading` is false the moment there are questions, so a
  // background refresh never empties a shelf the reader is scrolling.
  const suggestionsPending = suggestedQuery.isLoading;

  return (
    // Dragged in from the left edge, the rail comes with the finger.
    // The button above is still the way most readers will open it; this
    // is the way the ones who have used a phone before will try first,
    // and the drawer is exactly the thing an edge swipe is for. It
    // writes into the drawer's own progress, so the panel and the scrim
    // follow the hand and the spring that finishes the move starts at
    // the speed the hand left at.
    <EdgeSwipe
      progress={drawerProgress}
      span={SIDEBAR_WIDTH}
      onSettle={settleSidebarDrawer}
      // Once it is open the drawer's own scrim is over the page, and
      // desktop has the rail standing beside it already.
      enabled={!desktop && !drawerOpen}
    >
      {/* The paper, the rail and the account cluster are the app's own
          furniture, mounted once by the root layout above every screen —
          so asking a question cannot unmount and re-mount them. This
          screen draws only what is written on that paper. */}
      {/* The screen's own subtree, and only it, is the page's `main`:
          the rail, the account cluster and the notices all stand
          outside it in `AppFrame`, so there is exactly one on screen
          and a reader can jump straight past the navigation to what
          they came for. Once the thread is on top, the ask is still
          mounted underneath — see `useScreenLandmark`, which is what
          keeps it from being described as a second page. */}
      <View style={styles.flex} {...screenLandmark}>
        {Platform.OS === 'web' && (
          <Head>
            <title>Ansari — Ask about the Qur&apos;an and Sunnah</title>
            <meta
              name="description"
              content="Ask Ansari about the Qur'an and Sunnah. Every answer cites its sources, so you can open the original text and verify."
            />
          </Head>
        )}
        {/* Desktop keeps its navigation in the rail, which stays put
          through the ask. A phone reaches the same rail through this
          one button, and it clears with the rest of the empty-screen
          furniture so the thread's own header has bare paper to fade
          into rather than swapping one set of chrome for another.

          One control, not two. Everything the second one used to reach
          — About, the terms, the privacy note — is in the rail's
          colophon, which is now a tap away on a phone as well. */}
        {!desktop && (
          <Animated.View
            style={[
              styles.chrome,
              // The disc stands on the same line as the first word of an
              // answer, so it takes the page's gutter rather than a
              // margin of its own.
              { top: insets.top + CHROME_TOP, left: gutter, right: gutter },
              heroFade,
            ]}
            pointerEvents={asking ? 'none' : 'box-none'}
          >
            <GlassCircleButton
              onPress={openSidebarDrawer}
              accessibilityLabel="Menu"
              testID="menu-button"
            >
              <Feather name="menu" size={19} color={colors.foreground} />
            </GlassCircleButton>
          </Animated.View>
        )}

        {/* The inset is animated, so it sits on a wrapper of its own: the
          page's left edge is driven by the rail's own collapse
          progress, which is what keeps the reading column travelling
          with the rail's edge instead of jumping once it lands. */}
        <Animated.View style={[styles.flex, desktop && sidebarInset]}>
          <KeyboardAvoidingViewCompat
            style={[styles.flex, desktop && styles.stageDesktop]}
            onLayout={(e) => {
              stageHeight.current = e.nativeEvent.layout.height;
              measureGlide();
            }}
          >
            {/* Tapping the open paper dismisses the keyboard. */}
            <Pressable
              style={[
                styles.hero,
                // The hero's box runs to the very top of the glass, but
                // the paper a reader actually sees begins under the
                // status bar and the floating menu button. Holding that
                // strip out of the box is what makes "centred" land where
                // the eye reads centre, on a notched phone as well as in
                // the preview.
                !desktop && {
                  paddingTop: insets.top + (shortWindow ? 12 : 24),
                  // Optically centred, not geometrically. A cluster set
                  // on the true middle of a tall phone reads as having
                  // sunk — the eye puts the centre of a page a little
                  // above its half. The taller the phone, the further
                  // the mark and the greeting have to rise to stay in
                  // the same place, so the correction is a share of the
                  // window rather than a fixed step.
                  paddingBottom: Math.round(screenHeight * 0.1),
                },
                desktop && styles.heroDesktop,
              ]}
              onPress={dismissComposer}
              accessible={false}
              // And not a Tab stop either. Tapping the paper to put the
              // composer away is a pointer's convenience; to a keyboard
              // it was a nameless first stop that drew the focus ring
              // around the whole greeting on the way to the field two
              // stops later.
              focusable={false}
            >
              <Animated.View
                style={[styles.heroInner, heroExit]}
                // `box-none`, not `none`, on a phone: the greeting is
                // still deaf to touch and a tap on the paper still reaches
                // the dismiss below, but the emblem inside has a turn of
                // its own to answer.
                pointerEvents={desktop ? 'none' : 'box-none'}
              >
                {/* Desktop wears the lockup in the rail's top-left corner,
                so the paper carries only the greeting; on a phone the
                mark crowns the hero — the same brass emblem the rail
                wears, struck at the hero's size.

                The mark alone. A name and a version number set under it
                is a title page for an application, and the emblem
                already says whose page this is; the empty screen is
                better for having one fewer thing written on it. */}
                {!desktop && markHeight > 0 && (
                  <Animated.View style={[styles.brandLockup, lockupCollapse]}>
                    <AnsariMarkSpin height={markHeight} />
                  </Animated.View>
                )}
                <Text
                  // The empty page's one piece of set type is also its
                  // title, so it carries the screen's only top-level
                  // heading rather than a hidden one being added beside
                  // it for the sake of the outline.
                  {...heading(1)}
                  style={[
                    styles.greeting,
                    // The greeting is set for the phone it is read on: a
                    // compact handset steps it down (and gives back some
                    // of its side air) rather than breaking "Welcome,
                    // seeker of / knowledge" across two lines, and a Max
                    // steps it up rather than leaving the largest page in
                    // the family looking under-set. A short window keeps
                    // the middle setting whatever its width, because there
                    // the greeting is competing for height, not for room
                    // across the page.
                    !desktop &&
                      !shortWindow &&
                      size === 'compact' &&
                      styles.greetingCompact,
                    !desktop &&
                      !shortWindow &&
                      size === 'roomy' &&
                      styles.greetingRoomy,
                    desktop && styles.greetingDesktop,
                    { color: colors.greetingInk },
                  ]}
                >
                  Welcome, seeker of knowledge
                </Text>
              </Animated.View>
            </Pressable>

            <Animated.View
              style={[
                styles.bottom,
                desktop && styles.bottomDesktop,
                bottomPad,
                glideDown,
              ]}
              onLayout={(e) => {
                blockTop.current = e.nativeEvent.layout.y;
                measureGlide();
              }}
            >
              {!desktop && (questions.length > 0 || suggestionsPending) && (
                <Animated.View style={[styles.chipsClip, chipsCollapse]}>
                  <View
                    onLayout={(e) => {
                      chipsHeight.set(e.nativeEvent.layout.height);
                    }}
                  >
                    {suggestionsPending ? (
                      // The shelf's own box, at the height a single-line
                      // chip takes, so the composer under it is already
                      // standing where it will stand once the questions
                      // land.
                      <Placeholder
                        style={[styles.chips, shelfPad]}
                        // The reader is not waiting on these. The screen
                        // is already whole and usable without them, so
                        // held marks that show for a moment and are
                        // replaced by real questions are just another
                        // layer arriving. A normal answer beats this.
                        grace={700}
                      >
                        {CHIP_PLACEHOLDER_WIDTHS.map((width, index) => (
                          <View
                            key={index}
                            style={[styles.chip, chipMax, styles.chipHeld]}
                          >
                            <PlaceholderLine width={width} lineHeight={20} />
                          </View>
                        ))}
                      </Placeholder>
                    ) : (
                      <ScrollView
                        horizontal
                        showsHorizontalScrollIndicator={false}
                        // The shelf pans sideways and claims nothing
                        // else: on a phone browser a horizontal
                        // scroller that leaves `touch-action` at its
                        // default swallows the vertical component of
                        // every drag that starts on it, so a thumb
                        // dragged up the chips moves neither them nor
                        // the page. Native ignores the style.
                        style={PAN_X}
                        contentContainerStyle={[styles.chips, shelfPad]}
                        keyboardShouldPersistTaps="handled"
                      >
                        {chipElements}
                      </ScrollView>
                    )}
                  </View>
                </Animated.View>
              )}

              <View
                style={[
                  styles.inputBar,
                  !desktop && { paddingHorizontal: gutter },
                ]}
                onLayout={(e) => {
                  composerHeight.current = e.nativeEvent.layout.height;
                  measureGlide();
                }}
              >
                <ChatInput
                  onSend={ask}
                  sending={pendingQuestion !== null}
                  // The clear glass is for sitting over the ambient shadow.
                  // Once the question is away the shadow fades out and the
                  // composer settles to the same material it wears in the
                  // thread, so the hand-off doesn't change it.
                  clearGlass={!asking}
                  // Once the question is away this composer is standing in
                  // for the thread's, and the thread's asks for a
                  // follow-up: matching the words here means the route
                  // change doesn't rewrite them.
                  placeholder={asking ? 'Ask a follow-up…' : undefined}
                  // The empty page's one live control: the brass catches
                  // the light once, after the greeting has settled, and
                  // never again.
                  shimmerSend
                  inputRef={inputRef}
                  onFocusChange={(focused) => {
                    if (Platform.OS === 'web') setComposerActive(focused);
                  }}
                />
              </View>

              {desktop && (questions.length > 0 || suggestionsPending) && (
                <Animated.View style={[styles.lines, linesFade]}>
                  {suggestionsPending ? (
                    <Placeholder style={styles.lines}>
                      {LINE_PLACEHOLDER_WIDTHS.map((width, index) => (
                        <View key={index} style={styles.line}>
                          <PlaceholderMark width={15} height={15} radius={4} />
                          <PlaceholderLine width={width} lineHeight={21} />
                        </View>
                      ))}
                    </Placeholder>
                  ) : (
                    suggestionLines
                  )}
                </Animated.View>
              )}

              {!desktop && (
                <Animated.View style={[styles.footerWrap, footerCollapse]}>
                  <Text
                    style={[styles.footer, { color: colors.mutedForeground }]}
                  >
                    Verify results with scholars.
                  </Text>
                </Animated.View>
              )}
            </Animated.View>
          </KeyboardAvoidingViewCompat>
        </Animated.View>

        {/* The last frame of the ask is the first frame of the thread. A
          conversation reads downward from its opening question, so the
          question takes its place at the head of the page — exactly
          where the thread's list will draw it — and the waiting line
          appears beneath it. Nothing has to move when the route
          changes; the greeting simply clears out of the way while the
          question rises into the space it leaves.
          (Kept mounted while the screen fades out: unmounting on blur
          would blank the card mid-dissolve.) */}
        {asking && (
          <Animated.View
            style={[
              styles.liftLayer,
              // The thread draws its column inside the rail's inset. This
              // layer is absolute over the whole screen, so without the
              // same inset the question and the waiting line sit a rail's
              // width to the left of where the thread will draw them —
              // and slide sideways the moment the route changes.
              desktop && sidebarInset,
              { top: threadContentTop(desktop, insets.top) },
            ]}
            pointerEvents="none"
          >
            <View
              style={[
                styles.lift,
                desktop && styles.liftDesktop,
                {
                  gap: desktop ? THREAD_GAP.desktop : THREAD_GAP.phone,
                  // The thread's column, repeated exactly: the phone's
                  // gutter is a function of the window, so the lifted
                  // question has to be given the same figure the list
                  // will hand its own rows.
                  paddingHorizontal: desktop ? 16 : gutter,
                },
              ]}
            >
              <Animated.View entering={QUESTION_ENTER}>
                <AskedQuestion text={pendingQuestion ?? ''} />
              </Animated.View>
              <ThinkingLine />
            </View>
          </Animated.View>
        )}

        {desktop && (
          <Animated.View
            style={[styles.footerDesktop, sidebarEdge, heroFade]}
            pointerEvents="none"
          >
            <Text style={[styles.footer, { color: colors.mutedForeground }]}>
              Verify results with scholars.
            </Text>
          </Animated.View>
        )}
      </View>
    </EdgeSwipe>
  );
}

/**
 * How solid a chip's paper is over the ambient shadow.
 *
 * Near-opaque rather than solid: the moving shadow ghosts through the
 * card instead of stopping dead at its edge, which is the reading the
 * shelf was given on a real phone. Near enough to opaque that the
 * label's contrast barely moves with the clip — 9.2:1 over the darkest
 * frond and 9.3:1 over the brightest wall by day, 10.4:1 and 10.3:1
 * after dark, against a 4.5:1 bar.
 */
const CHIP_FILL = 0.92;

/**
 * A suggested question: a quiet paper card, raised off the page.
 *
 * The fill is `secondary` — the palette's one quiet fill, which the
 * reader's own sent question wears as well, so the same shape in two
 * places is one decision rather than two colours. It is the rung above
 * the page and the rung below the composer's `card`, in both modes: the
 * eye lands on the composer, then on the shelf. (The wash this replaced
 * was `heroInk`, the debossed register the wordmark is set in, carried
 * at roughly double the heaviest wash in the app — so by day the
 * suggestions read as pressed *into* the paper while the composer under
 * them read as raised, and after dark they overshot the composer
 * entirely.)
 *
 * Under a pointer or a thumb the card lifts a rung, to the composer's
 * own `card`, and its ink lifts with it. Both moves are the direction
 * the rest of the ladder travels in, and the ink is what keeps the step
 * from costing the label anything: 9.2:1 at rest becomes 16.3:1 lifted
 * by day, 10.4:1 becomes 10.9:1 after dark. The old hover darkened the
 * chip and took the label the other way.
 *
 * Depth rather than an outline. In light mode the whole ladder above
 * the paper lives inside a 1.26:1 band (see the note on
 * `glassButtonFill`), so a quiet fill cannot say "raised" by value
 * alone — an inset pair does it instead: the light catching along the
 * top edge, a soft underside along the bottom. It is drawn *inside* the
 * box on purpose. The shelf clips, so a cast shadow would be cut off at
 * the chip's own edge, and giving it the air it needs would move the
 * composer down the page.
 */
function SuggestionChip({
  question,
  maxWidth,
  onPress,
}: {
  question: string;
  maxWidth: { maxWidth: number };
  onPress: (question: string) => void;
}) {
  const colors = useColors();
  const [hovered, setHovered] = useState(false);
  const [pressed, setPressed] = useState(false);
  // One state, two ways in: a pointer resting on the card and a thumb
  // held on it are the same lift, and a phone only ever has the second.
  const lifted = hovered || pressed;
  return (
    <PressableScale
      onPress={() => onPress(question)}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      onPressIn={() => setPressed(true)}
      onPressOut={() => setPressed(false)}
      // A chip is a button, and its name is the question written on it.
      accessibilityRole="button"
      style={[
        styles.chip,
        maxWidth,
        {
          backgroundColor: withAlpha(
            lifted ? colors.card : colors.secondary,
            CHIP_FILL,
          ),
          boxShadow: `inset 0 1px 0 ${colors.glassLip}, inset 0 -1px 0 ${colors.shadowTintSoft}`,
        },
      ]}
    >
      <Text
        style={[
          styles.chipText,
          {
            color: lifted
              ? colors.strongForeground
              : colors.secondaryForeground,
          },
        ]}
        numberOfLines={2}
      >
        {question}
      </Text>
    </PressableScale>
  );
}

/**
 * The measures the suggestion shelf holds open while its questions are
 * still in flight — chip widths on a phone, line widths on a desktop.
 * Ragged, and in the range real suggestions actually run to, so the
 * shelf reads as type that has not arrived rather than as a widget.
 */
const CHIP_PLACEHOLDER_WIDTHS = [156, 198, 124] as const;

/**
 * A desktop suggestion: a trend mark and the question, inked brighter
 * under the pointer. Both the mark and the label take the same ink, so
 * hover is held here rather than read inside a style callback — and the
 * line dips under a press like every other unglassed control.
 */
function SuggestionLine({
  question,
  onPress,
}: {
  question: string;
  onPress: (question: string) => void;
}) {
  const colors = useColors();
  const [hovered, setHovered] = useState(false);
  const ink = hovered ? colors.foreground : colors.mutedForeground;
  return (
    <PressableScale
      onPress={() => onPress(question)}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      // Named by the question it carries; the trend mark beside it is
      // ornament and adds nothing when read aloud.
      accessibilityRole="button"
      style={styles.line}
    >
      <Feather name="trending-up" size={15} color={ink} />
      <Text numberOfLines={1} style={[styles.lineText, { color: ink }]}>
        {question}
      </Text>
    </PressableScale>
  );
}
const styles = StyleSheet.create({
  flex: {
    flex: 1,
  },
  // On desktop the stage centers its content vertically, held a touch
  // above true center so the composition sits optically balanced.
  // The rail is absolute, so the stage clears it with padding — the
  // centered composition then centers in the paper that is left, and
  // the thread insets its own column by exactly the same amount.
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
  // The phone hero settles toward the composer rather than floating in
  // the middle of the page: the welcome belongs to the question box
  // under it, so it sits a comfortable step above it with the open
  // paper left above.
  // The lockup sits in the paper rather than on top of the composer.
  // Pinned to the foot of the hero it read as furniture stacked above
  // the input; centred in the space it has — lifted a little above true
  // centre, where the eye reads centre as being — it reads as the
  // subject of an otherwise empty page, which is what it is.
  hero: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    // However short the stage gets, nothing in the hero may be drawn
    // past its edge. A phone browser shrinks the app to whatever is
    // left above the keyboard, and without this the overflow appears
    // out from under the status bar as a sliced-off emblem.
    overflow: 'hidden',
  },
  // Desktop centers the whole ask — wordmark, greeting, composer,
  // sample lines — as one block; the hero stops stretching and sits
  // just above the composer. (Longhands, not `flex: 0`: RN-web maps
  // the shorthand to a zero flex-basis, which collapses the block.)
  heroDesktop: {
    flexGrow: 0,
    flexShrink: 0,
    flexBasis: 'auto',
    paddingBottom: 0,
    marginBottom: 22,
  },
  heroInner: {
    alignItems: 'center',
    gap: 0,
  },
  brandLockup: {
    alignItems: 'center',
    gap: 7,
  },
  // The greeting speaks in the reading voice — the light grade of the
  // one serif an answer is set in — so the welcome and the answer that
  // follows it are one voice rather than chrome introducing prose.
  greeting: {
    fontSize: 22,
    lineHeight: 30,
    fontFamily: fonts.prose,
    textAlign: 'center',
    paddingHorizontal: 24,
    marginTop: 15,
  },
  greetingCompact: {
    fontSize: 19,
    lineHeight: 26,
    paddingHorizontal: 16,
  },
  greetingRoomy: {
    fontSize: 24,
    lineHeight: 32,
    paddingHorizontal: 28,
  },
  greetingDesktop: {
    fontSize: 26,
    lineHeight: 34,
    marginTop: 18,
  },
  bottom: {
    gap: 12,
  },
  // The composer block holds a comfortable capped width on wide
  // windows — the centered single-column sanctuary, scaled up. It takes
  // the thread's reading column exactly, so the composer keeps its
  // width (and the question card its right edge) at the hand-off.
  bottomDesktop: {
    width: '100%',
    maxWidth: READING_COLUMN,
    alignSelf: 'center',
    gap: 18,
  },
  chipsClip: {
    overflow: 'hidden',
  },
  // A held chip is the chip's box and nothing else: same padding, same
  // radius, same hairline reserved for the border — drawn in nothing,
  // so the shelf occupies its final height without pretending to be a
  // row of buttons.
  chipHeld: {
    backgroundColor: 'transparent',
    borderColor: 'transparent',
  },
  // Side air comes from the page's gutter, applied at render: the shelf
  // itself runs edge to edge so its questions pan out from under both
  // margins rather than stopping at them.
  chips: {
    gap: 10,
  },
  chip: {
    ...rounded(RADIUS.lg),
    // A shelf of chips is the first thing a thumb reaches for on the
    // empty screen, so each one holds a full touch target even when its
    // question is short enough to sit on one line. The padding below
    // already carries a two-line chip past this; nothing about a chip
    // at rest changes.
    minHeight: 44,
    // The hairline the chip used to be ringed with sat inside its box,
    // so the padding takes it back: the chip keeps exactly the height
    // and the text inset it had when it was outlined.
    paddingHorizontal: 16 + StyleSheet.hairlineWidth,
    paddingVertical: 12 + StyleSheet.hairlineWidth,
    justifyContent: 'center',
    cursor: 'pointer',
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
    paddingLeft: 38,
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
  // The asked question sits over the paper, taking no space from the
  // composition beneath it, so nothing on the page moves while the
  // question leaves. Its column and padding are the thread list's own,
  // so the card keeps its width and both edges at the hand-off.
  liftLayer: {
    position: 'absolute',
    left: 0,
    right: 0,
    alignItems: 'center',
  },
  lift: {
    width: '100%',
  },
  liftDesktop: {
    maxWidth: READING_COLUMN,
  },
});

const LINE_PLACEHOLDER_WIDTHS = [268, 214, 302] as const;
