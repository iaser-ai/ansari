import {
  FlatList,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewProps,
  type ViewStyle,
} from 'react-native';
import { Feather } from '@expo/vector-icons';
import { router, useGlobalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useQueryClient } from '@tanstack/react-query';
import { useColors } from '@/hooks/useColors';
import { fonts } from '@/constants/colors';
import { SIDEBAR_COLLAPSED_WIDTH, SIDEBAR_WIDTH } from '@/constants/layout';
import { coinTurnAt, DURATION, EASE_OUT } from '@/constants/motion';
import { hijriYear } from '@/lib/hijri';
import {
  narrowInkAt,
  setSidebarCollapsed,
  sidebarWidthAt,
  useSidebarCollapsed,
  useSidebarPhase,
  useSidebarProgress,
  wideInkAt,
} from '@/hooks/useSidebarCollapsed';
import { withAlpha } from '@/lib/color';
import { tapHaptic } from '@/lib/haptics';
import { confirmDestructive, showNotice } from '@/lib/notice';
import { isHovered } from '@/lib/web';
import { landmark } from '@/lib/semantics';
import { useAuth } from '@/lib/auth/context';
import { SearchField } from '@/components/SearchField';
import { Placeholder, PlaceholderLine } from '@/components/Placeholder';
import { AnsariMarkBrass } from '@/components/AnsariMarkBrass';
import { PressableScale } from '@/components/PressableScale';
import { SwipeToReveal } from '@/components/SwipeToReveal';
import {
  getListConversationsQueryKey,
  useDeleteConversation,
  useListConversations,
  type Conversation,
} from '@/lib/api';
import React, { useMemo, useState } from 'react';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { RADIUS, rounded } from '@/constants/radius';

/**
 * The rail's gutter, the same in both states. Nothing inside it may
 * shift sideways when the rail changes width, so the leading edge every
 * control is measured from has to be a constant — and it is chosen so
 * that the collapsed rail is exactly gutter, icon column, gutter.
 */
const RAIL_PAD = 15;

/**
 * The measures the reading list's held rows are drawn at while the
 * first load is in flight — real titles, ragged, not a stack of equal
 * bars. Each sits in a row of exactly the height a real one takes, so
 * the list arrives into the shape it was already occupying.
 */
const RAIL_PLACEHOLDER_TITLES = [
  '84%',
  '61%',
  '73%',
  '48%',
  '79%',
  '56%',
] as const;
/**
 * The column the mark, the toggle, the new-question button and the
 * strip's search button all share: the collapsed rail's whole content
 * box. Everything is centred on its centre line, so collapsing changes
 * what is beside a control, never where the control is.
 */
const ICON_COLUMN = SIDEBAR_COLLAPSED_WIDTH - RAIL_PAD * 2;

/**
 * The measure wide-only content is laid out at whatever the rail is
 * currently doing — the expanded content box. Frozen rather than
 * inherited, because a column that re-measures every frame re-wraps
 * every frame.
 */
const CONTENT_WIDTH = SIDEBAR_WIDTH - RAIL_PAD * 2;

const RAIL_TOP = 22;
const MARK_HEIGHT = 32;

/**
 * The toggle's box, centred on the mark's own centre line so the two
 * sit level across the rail's head.
 *
 * This is also why the toggle needs no travel of its own. It is pinned
 * to the trailing edge, and the collapsed rail is exactly a gutter, an
 * icon column and a gutter wide — so riding that edge inward lands it
 * precisely on the mark's square, to the pixel, with no second
 * animation to keep in step with the first.
 */
const TOGGLE_TOP = RAIL_TOP + (MARK_HEIGHT - ICON_COLUMN) / 2;

/** The rail's foot, answering its head. */
const RAIL_FOOT = 20;

/** The plus on the new-question button, and the box it is centred in. */
const NEW_QUESTION_GLYPH = 16;

/** `SearchField`'s own compact height, which the search slot centres. */
const COMPACT_FIELD_HEIGHT = 32;

/**
 * A layer that is still in the tree only because it has not finished
 * fading. Invisible must also mean unreadable and untabbable —
 * otherwise the collapsed strip still holds a search box that a
 * keyboard can land in.
 */
const DORMANT: ViewProps = {
  accessibilityElementsHidden: true,
  importantForAccessibility: 'no-hide-descendants',
  'aria-hidden': true,
};

/** And unclickable. Carried in the style, where RNW wants it. */
const UNTOUCHABLE: ViewStyle = { pointerEvents: 'none' };

/**
 * As a drawer the rail has one state and no strip to cross-fade to, so
 * it is simply, permanently, its wide self. Stated once rather than
 * branched at every reader of the phase.
 */
const DRAWER_PHASE = {
  wideLit: true,
  wideLive: true,
  narrowLit: false,
  narrowLive: false,
} as const;

/**
 * The desktop rail: the lockup tucked into the top-left corner, a way
 * to start a fresh question, and every past one listed beneath — the
 * familiar shape of a chat app's left-hand navigation.
 *
 * A phone gets the same rail rather than a navigation of its own — see
 * `SidebarDrawer`, which slides this over the page. `drawer` is the
 * handful of differences that follow from arriving over a page instead
 * of standing beside one: there is no strip to collapse to and so no
 * toggle, there is no cursor and so nothing can wait for hover, and the
 * rail is the full height of a screen with a notch at the top and a
 * home indicator at the bottom, so it keeps clear of both.
 *
 * The rail owns its own data. It is mounted once by the root layout,
 * above the screens, so that asking a question cannot unmount and
 * re-mount it — a re-mount would re-lay-out the column and throw away
 * its scroll for a navigation that is supposed to change only the
 * writing on the page. Which conversation is open is therefore read
 * from the route rather than passed down by whichever screen happens to
 * be showing.
 */
export function Sidebar({
  drawer = false,
  onNavigate,
  style,
  nativeID,
}: {
  /** Drawn over the page on a phone rather than beside it on a desktop. */
  drawer?: boolean;
  /**
   * Where the rail is, when something outside it is moving it — the
   * drawer's slide.
   *
   * It has to land on the rail's own box rather than on a wrapper
   * around it. The glass is a `backdrop-filter`, and a filter samples
   * only what is painted inside its backdrop root: put a transformed,
   * z-indexed layer between the rail and the page and the rail has
   * nothing behind it to frost, so the drawer arrives as a pane of
   * tinted cling film with the page legible straight through it.
   */
  style?: StyleProp<ViewStyle>;
  /**
   * The reader has gone somewhere. A rail standing beside the page has
   * nothing to do here; a drawer over it has to get out of the way, or
   * it is covering the very thing it was asked for.
   */
  onNavigate?: () => void;
  /**
   * The rail's own box, named, so the drawer's focus trap has something
   * to hold on the web. See `useOverlayFocus`.
   */
  nativeID?: string;
}) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  // The open conversation, straight from the URL. `q` is the question
  // the reader just typed, carried on the route while the thread is
  // being created: a conversation opened seconds ago may not have
  // reached the list yet, and this is what stands in for its title
  // until the query catches up.
  const { id, q } = useGlobalSearchParams<{ id?: string; q?: string }>();
  const activeConversationId = typeof id === 'string' ? id : undefined;
  const activeTitle = typeof q === 'string' ? q : undefined;
  const queryClient = useQueryClient();
  const { status, session, isGuest, logout } = useAuth();
  // A guest is signed in to a throwaway account, so the rail offers the
  // "keep your questions" sign-in upsell, exactly as for a signed-out app —
  // not a name and a "log out".
  const hasRealAccount = status === 'signedIn' && !isGuest;
  const [query, setQuery] = useState('');
  // Which row's actions button is showing. Held here rather than read
  // from each row's own press state: the button sits outside the row it
  // belongs to, so the two have to agree on when it is visible.
  const [hovered, setHovered] = useState<string | null>(null);
  // A row's actions button is revealed by hover, which a keyboard reader
  // never produces — so tabbing onto it used to land on something drawn
  // at zero opacity, focus ring and all. Focus arms the row too.
  const [actionFocused, setActionFocused] = useState<string | null>(null);
  // Which row has been swiped open. Held by the list rather than by the
  // row, because two rows open at once is a list that has come apart.
  const [revealed, setRevealed] = useState<string | null>(null);

  const conversationsQuery = useListConversations();
  const deleteConversation = useDeleteConversation({
    mutation: {
      onSuccess: () =>
        queryClient.invalidateQueries({
          queryKey: getListConversationsQueryKey(),
        }),
    },
  });

  // What is open is shown by highlighting its row in the list, so the
  // rail holds one list and not a list plus a copy of one of its
  // entries. A conversation opened seconds ago may not have reached the
  // list yet, so the screen's own title stands in for it at the head
  // until the query catches up.
  const conversations = useMemo(() => {
    const all = [...(conversationsQuery.data ?? [])];
    if (
      activeConversationId &&
      activeTitle &&
      !all.some((conversation) => conversation.id === activeConversationId)
    ) {
      all.unshift({
        id: activeConversationId,
        title: activeTitle,
        preview: '',
        updatedAt: new Date().toISOString(),
      } as Conversation);
    }
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return all;
    return all.filter(
      (conversation) =>
        conversation.title.toLocaleLowerCase().includes(needle) ||
        conversation.preview.toLocaleLowerCase().includes(needle),
    );
  }, [conversationsQuery.data, query, activeConversationId, activeTitle]);

  const confirmDelete = (conversation: Conversation) => {
    tapHaptic();
    confirmDestructive(
      'Delete conversation?',
      conversation.title,
      'Delete',
      () => deleteConversation.mutate({ conversationId: conversation.id }),
    );
  };

  // Said plainly, and only what is true today: Ansari generates its
  // answers, so the terms are about what that does and does not make
  // them, not about a licence nobody reads.
  const showTerms = () =>
    showNotice(
      'Terms of use',
      'Ansari is a study aid, not a mufti. Its answers are generated and can be incomplete or mistaken, so treat each one as a pointer to the sources it cites: read the original text, and take anything consequential to a qualified scholar. The service is offered as it stands, and may change or pause while it is being built.',
    );

  const showPrivacy = () =>
    showNotice(
      'Privacy',
      'Your question is sent to Ansari\u2019s answering service so it can be answered, and your conversations are kept so this list can show them. Until you sign in they sit on an automatic guest account for this device; sign in and they move to your account and follow you across devices. None of it is sold or used for advertising. Deleting a conversation removes it.',
    );

  const goToLogin = () => {
    onNavigate?.();
    router.push('/login');
  };

  const signOut = async () => {
    onNavigate?.();
    // Home first: an account-owned thread left mounted would refetch under
    // the new (signed-out / guest) principal and drop to its load-error
    // screen. `logout()` clears the query cache, so nothing stale survives.
    router.replace('/');
    await logout();
  };

  // What the account line shows once there is a session: the name given
  // at registration, or a plain fallback for a guest / an account with
  // no name on it.
  const accountName =
    [session?.firstName, session?.lastName]
      .map((part) => part?.trim())
      .filter(Boolean)
      .join(' ') || 'Signed in';

  // Dated the way the material it draws on is dated. Read once per
  // mount: the rail is not open across a turn of the year often enough
  // to be worth a ticking clock.
  const year = useMemo(() => hijriYear(new Date()), []);

  const collapsed = useSidebarCollapsed();
  const progress = useSidebarProgress();
  // The glint is a CSS filter, so it is web-only; native draws the turn
  // without it rather than warning once a frame.
  const glintable = Platform.OS === 'web';
  // What is mounted and what may be touched are read off the progress
  // too, never off the boolean: the toggle can be pressed again
  // mid-flight, and the state the rail is heading for says nothing
  // about what is on screen right now.
  const railPhase = useSidebarPhase();
  const phase = drawer ? DRAWER_PHASE : railPhase;

  // Everything the reader watches is drawn from the one progress: the
  // rail's own width, the mark's single turn, and the two cross-fades.
  const railStyle = useAnimatedStyle(() => ({
    width: sidebarWidthAt(progress.get()),
  }));

  // Exactly one revolution, mapped straight onto the width move, so the
  // turn cannot outlast the glide or finish before it. The slot the mark
  // sits in is the size of the mark itself, so this turns about the
  // artwork's own centre rather than about its bleed.
  //
  // It turns the way a struck coin turns — about its own vertical axis,
  // top staying up — rather than spinning flat like a wheel. That is
  // what makes it read as a piece of metal rather than as a loading
  // spinner, and it needs a perspective for the near edge to swing
  // toward the reader instead of the whole thing just squashing.
  //
  // A real coin does not turn at an even brightness: it catches the
  // light twice on the way round, as the face swings through the angle
  // that throws the light back. So the glint rides the same progress —
  // a narrow bloom of brightness and contrast as the face approaches
  // edge-on, dying away again at both rest angles, where the filter is
  // exactly identity and the mark is simply the mark.
  // The rail is not asked to hold a control until the reader shows some
  // interest in it. Cross the rail at all and the toggle is there; leave
  // and it goes, because a permanent button for a rare action is a
  // permanent piece of clutter at the top of every screen.
  //
  // Once the rail is a strip the reveal stops mattering: the strip has
  // no other way to be opened, so the toggle is simply always lit.
  const reveal = useSharedValue(0);
  const summonToggle = (near: boolean) => {
    reveal.set(
      withTiming(near ? 1 : 0, { duration: DURATION.state, easing: EASE_OUT }),
    );
  };

  const markStyle = useAnimatedStyle(() => {
    const p = progress.get();
    const coin = coinTurnAt(p);
    return {
      // The strip keeps one square at its head, and it belongs to the
      // mark: at rest the collapsed rail is still Ansari's, not a
      // button parked where the emblem used to be. The mark only yields
      // it once both things are true — the rail has narrowed to the
      // point where the two squares are the same square, and the cursor
      // is on the rail, so a control is actually wanted. Either alone
      // leaves the mark exactly as it was.
      opacity: 1 - narrowInkAt(p) * reveal.get(),
      transform: [
        { perspective: coin.perspective },
        { rotateY: `${coin.degrees}deg` },
      ],
      ...(glintable
        ? {
            filter: `brightness(${coin.brightness}) contrast(${coin.contrast})`,
          }
        : null),
    } as unknown as ViewStyle;
  });

  // Lit by the cursor being on the rail, in both states — the same
  // reveal, whether it is standing opposite the mark across an open
  // rail or dissolving through it on a strip. Reading from the one
  // value is what makes the collapsed swap a true cross-fade: the ink
  // the mark gives up is exactly the ink the toggle takes on.
  const toggleStyle = useAnimatedStyle(() => ({
    opacity: reveal.get(),
  }));

  // The two layers hand over rather than dissolve through each other:
  // the wide column is gone before the strip's controls start to arrive.
  const wideFade = useAnimatedStyle(() => ({
    opacity: wideInkAt(progress.get()),
  }));
  const narrowFade = useAnimatedStyle(() => ({
    opacity: narrowInkAt(progress.get()),
  }));

  // A layer that is not fully arrived is not a place to click, a thing
  // to read out, or a tab stop — whichever way it happens to be
  // travelling. Only the layer that has come to rest is live.
  const wideDormant = phase.wideLive ? null : DORMANT;
  const narrowDormant = phase.narrowLive ? null : DORMANT;
  const wideUntouchable = phase.wideLive ? null : UNTOUCHABLE;
  const narrowUntouchable = phase.narrowLive ? null : UNTOUCHABLE;

  // The rail floats over the paper — and, on the ask, over the moving
  // palm shadow — as frosted glass rather than as a panel cut out of it.
  //
  // The blur needs something to soften, so the fill stays thin enough
  // for the shadow to keep travelling underneath, and the brightness
  // shift is what separates the panel from the page. Which direction
  // that shift runs is a property of the mode, not of this component:
  // over paper the glass is lifted a touch, over charcoal it has to be
  // lifted hard, because a panel that dims can only read as a hole.
  // Both recipes, and the fill under them, come from the palette.
  //
  // On web the backdrop-filter has to sit on this wrapper itself: the
  // wrapper is z-indexed, so a child's filter would sample only what is
  // painted inside that stacking context, which is nothing.
  //
  // A drawer is not glass, and the reason is what is behind it. The
  // desktop rail stands over the app's own quiet paper, where a thin
  // wash reads as a pane with a page beneath it. Over a phone's screen
  // it is standing on a greeting, a shelf of questions and a composer —
  // and a wash thin enough to be glass leaves all of that legible
  // through the list the reader is trying to read. A panel that arrives
  // over the page and leaves again is a sheet in this app's language,
  // and every other sheet here is opaque. So is this one.
  const glass = drawer
    ? { backgroundColor: colors.sheet }
    : Platform.OS === 'web'
      ? ({
          backdropFilter: `blur(26px) ${colors.glassFilter}`,
          WebkitBackdropFilter: `blur(26px) ${colors.glassFilter}`,
          backgroundColor: colors.glassWashClear,
          // Held on its own composited layer for the life of the
          // screen. Left to decide for itself, Chromium re-rasterises a
          // backdrop-filter whenever anything inside the backdrop it
          // samples repaints — a suggestion line lighting up under the
          // cursor, three hundred pixels away, was enough to make the
          // whole rail flash.
          willChange: 'backdrop-filter',
          backfaceVisibility: 'hidden',
        } as unknown as ViewStyle)
      : { backgroundColor: withAlpha(colors.surface, 0.9) };

  // The rail's own corner control, where every application that has a
  // rail puts it. One glyph for both directions — the panel it draws is
  // the thing being shown and hidden, so it stays the same picture and
  // the label carries which way it will go; swapping the picture as
  // well says the same thing twice and reads as two different buttons.
  //
  // Text, not buttons: these are three references at the foot of a
  // page, and drawing them as controls would give the rail's quietest
  // corner more weight than the one thing in it worth pressing. They
  // brighten to full ink under the cursor, which is all a link owes.
  const footerLink = (label: string, onPress: () => void, testID: string) => (
    <PressableScale
      onPress={() => {
        onNavigate?.();
        onPress();
      }}
      accessibilityRole="button"
      testID={testID}
      style={(state) => [
        styles.footerLink,
        { opacity: state.pressed ? 0.5 : isHovered(state) ? 1 : 0.68 },
      ]}
    >
      <Text style={[styles.footerLinkText, { color: colors.foreground }]}>
        {label}
      </Text>
    </PressableScale>
  );

  const separator = (
    <Text style={[styles.footerLinkText, { color: colors.mutedForeground }]}>
      ·
    </Text>
  );

  // Pinned to the trailing edge at the head of the rail, so it keeps the
  // same inset from the border whatever width the rail is and rides that
  // border on every frame between the two states. Expanded, it stands
  // opposite the mark across the rail's head; collapsed, the edge has
  // come in far enough that the very same pin puts it exactly on the
  // mark's square — the strip's one emblem is the way back out of it.
  //
  // A cursor is not the only way to arrive, so focus lights it too: a
  // keyboard never lands on something drawn at zero.
  const toggle = (
    <Animated.View style={[styles.railToggle, toggleStyle]}>
      <PressableScale
        onPress={() => setSidebarCollapsed(!collapsed)}
        onFocus={() => summonToggle(true)}
        onBlur={() => summonToggle(false)}
        accessibilityRole="button"
        accessibilityLabel={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        testID="sidebar-toggle"
        style={(state) => [
          styles.iconButtonStacked,
          {
            backgroundColor: withAlpha(
              colors.foreground,
              isHovered(state) ? 0.08 : 0,
            ),
            opacity: state.pressed ? 0.6 : 1,
          },
        ]}
      >
        <Feather name="sidebar" size={17} color={colors.mutedForeground} />
      </PressableScale>
    </Animated.View>
  );

  return (
    <Animated.View
      style={[
        styles.rail,
        glass,
        // A drawer has one width and never leaves it. The static style
        // already carries it, so the animated width is simply not
        // applied rather than being driven to a constant.
        !drawer && railStyle,
        {
          // A light edge rather than a dark rule: glass catches the light
          // along its border, a cut-out panel casts a line. A solid
          // sheet is the opposite case — it needs the rule, because a
          // highlight on an opaque edge is invisible.
          borderRightColor: drawer ? colors.border : colors.glassRim,
        },
        style,
      ]}
      nativeID={nativeID}
      // The app's one navigation, wherever it is standing. On the web
      // this is a real <nav>, which is how a screen reader jumps to the
      // question history without reading the page first; it is named
      // because a landmark with no name is announced as "navigation"
      // and nothing else.
      {...landmark('navigation', 'Your questions')}
      // Over the page, the rail is the only thing on it: a screen
      // reader that could still reach the thread underneath would be
      // reading a page the finger cannot touch.
      accessibilityViewIsModal={drawer}
      // The whole rail is the hover region, not a corner of it. RNW's
      // hover callbacks on a Pressable go quiet the moment the cursor
      // is over a child, and this box is nothing but children — so the
      // pointer events, which do not care, are what can answer for the
      // rail as a whole.
      onPointerEnter={() => summonToggle(true)}
      onPointerLeave={() => summonToggle(false)}
    >
      {/* The clip is its own box rather than the rail itself. Chromium
          re-samples a backdrop-filter whenever the element carrying it
          also has to clip, so a hover anywhere on the page behind the
          glass flickered the whole rail. Filtering and clipping on two
          separate boxes leaves the glass a stable layer. */}
      <View
        style={[
          styles.clip,
          // A desktop rail is inside a browser window, which has no
          // notch. A drawer is the full height of a phone, so its head
          // clears the status bar and its foot the home indicator —
          // added to the rail's own margins rather than replacing them,
          // so on a phone without either it looks exactly as designed.
          drawer && {
            paddingTop: RAIL_TOP + insets.top,
            paddingBottom: RAIL_FOOT + insets.bottom,
          },
        ]}
      >
        {/* Once the rail is a strip, the strip itself is the way out of
            it. There is nothing to read at 68px and nothing to aim at
            but three small squares, so the whole surface answers — and
            the controls that sit on top of it still answer first,
            because this lies underneath them all.

            Silent to a screen reader, and skipped by a keyboard: the
            toggle above it is already the announced way to open the
            rail, and a second, nameless stop covering the same strip
            would only be a Tab into nothing. */}
        {phase.narrowLit && (
          <Pressable
            onPress={() => setSidebarCollapsed(false)}
            style={[StyleSheet.absoluteFill, styles.expandField]}
            focusable={false}
            {...DORMANT}
          />
        )}

        {/* Pinned: same gutter, same column, same top in both states, so
            the one thing the strip keeps is the one thing that never
            moves. Decorative — the product name is announced by the
            button below it, so the emblem is not read out again. */}
        <Animated.View style={[styles.markSlot, markStyle]} {...DORMANT}>
          <AnsariMarkBrass height={MARK_HEIGHT} />
        </Animated.View>

        {/* One button, not two: it is the rail's own content box, so it
          narrows in exact step with the edge and ends as the strip's
          square. The label is clipped rather than reflowed on the way. */}
        <PressableScale
          onPress={() => {
            onNavigate?.();
            router.replace('/');
          }}
          accessibilityRole="button"
          accessibilityLabel="Ask Ansari"
          testID="new-chat-button"
          style={(state) => [
            styles.newQuestion,
            {
              // No ring: the fill is the button. It is washed firmer
              // than it was behind the ring so the shape still reads on
              // the rail's glass at rest, and hover has been opened up
              // to match, so the step under the cursor stays as plain
              // as it was when the ring was there to darken as well.
              backgroundColor: withAlpha(
                colors.foreground,
                isHovered(state) ? 0.2 : 0.12,
              ),
              opacity: state.pressed ? 0.7 : 1,
            },
          ]}
        >
          <Feather
            name="plus"
            size={16}
            color={colors.foreground}
            style={styles.newQuestionIcon}
          />
          <Animated.Text
            numberOfLines={1}
            style={[
              styles.newQuestionText,
              wideFade,
              { color: colors.foreground },
            ]}
          >
            Ask Ansari
          </Animated.Text>
        </PressableScale>

        {/* The field and the strip's search button occupy one slot of a
          fixed height, so neither state's chrome shifts the column
          beneath it while the two cross-fade. */}
        <View style={styles.searchSlot}>
          {phase.narrowLit && (
            <Animated.View
              style={[styles.searchNarrow, narrowUntouchable, narrowFade]}
              {...narrowDormant}
            >
              <PressableScale
                onPress={() => setSidebarCollapsed(false)}
                accessibilityRole="button"
                accessibilityLabel="Search questions"
                testID="search-button"
                style={(state) => [
                  styles.iconButtonStacked,
                  {
                    backgroundColor: withAlpha(
                      colors.foreground,
                      isHovered(state) ? 0.08 : 0,
                    ),
                    opacity: state.pressed ? 0.6 : 1,
                  },
                ]}
              >
                <Feather
                  name="search"
                  size={16}
                  color={colors.mutedForeground}
                />
              </PressableScale>
            </Animated.View>
          )}

          {phase.wideLit && (
            <Animated.View
              style={[styles.searchWide, wideUntouchable, wideFade]}
              {...wideDormant}
            >
              {/* Deliberately unlike the button above it: recessed rather
                than raised — a place to type, not a thing to press. The
                material, radius and focus ring are the app's one search
                field, shared with the history sheet. */}
              <SearchField
                size="compact"
                value={query}
                onChangeText={setQuery}
                placeholder="Search"
                accessibilityLabel="Search questions"
                style={styles.searchFieldReset}
              />
            </Animated.View>
          )}
        </View>

        {/* Everything that needs the rail's full width is laid out at that
          width whatever the rail is currently doing, and the rail clips
          it. Re-measuring this column frame by frame is what would make
          the list re-wrap and the callout squash mid-move. */}
        {phase.wideLit && (
          <Animated.View
            style={[styles.wideColumn, wideUntouchable, wideFade]}
            {...wideDormant}
          >
            <Text
              style={[styles.sectionLabel, { color: colors.mutedForeground }]}
            >
              Questions
            </Text>

            {conversationsQuery.isLoading ? (
              // A first load only — `isLoading` is false the moment
              // there is data, so a background refresh never blanks a
              // list the reader is already looking down.
              <Placeholder style={[styles.list, styles.listContent]}>
                {RAIL_PLACEHOLDER_TITLES.map((width, index) => (
                  <View key={index} style={styles.row}>
                    <PlaceholderLine width={width} lineHeight={18} />
                  </View>
                ))}
              </Placeholder>
            ) : conversations.length === 0 ? (
              <View style={styles.listState}>
                <Text
                  style={[styles.emptyText, { color: colors.mutedForeground }]}
                >
                  {query.trim()
                    ? 'Nothing matches that yet.'
                    : 'Your questions will collect here.'}
                </Text>
              </View>
            ) : (
              <FlatList
                data={conversations}
                keyExtractor={(conversation: Conversation) => conversation.id}
                style={styles.list}
                contentContainerStyle={styles.listContent}
                showsVerticalScrollIndicator={false}
                // With the keyboard up the list is a short window, and
                // a finger arriving in it is either reaching past the
                // search to read — in which case the keyboard should
                // get out of the way — or opening a conversation, which
                // must work on the first tap rather than being spent
                // dismissing the keyboard.
                keyboardDismissMode="on-drag"
                keyboardShouldPersistTaps="handled"
                renderItem={({ item }: { item: Conversation }) => {
                  // A finger cannot hover, so a drawer's rows carry
                  // their actions button openly rather than waiting for
                  // a cursor that will never arrive.
                  const armed =
                    drawer || hovered === item.id || actionFocused === item.id;
                  // Showing the button is not the same as lighting the
                  // row, and only a cursor lights one. In the drawer,
                  // where every row is armed, washing them all would
                  // stack three filled pills edge to edge and read as
                  // one striped block — and it would say "here" about
                  // the whole list, which is what the open row's own,
                  // stronger wash is for.
                  const lit = hovered === item.id || actionFocused === item.id;
                  const open = item.id === activeConversationId;
                  // The gestures are the drawer's, and the phone's. A
                  // rail beside a page has a cursor over it: hover
                  // already reveals the control, and a mouse dragged
                  // sideways across a list is not a gesture anyone
                  // makes.
                  const gestures = drawer && Platform.OS !== 'web';
                  const swipedOpen = revealed === item.id;
                  const row = (
                    // The row and its actions button are siblings, not nested:
                    // a button inside a button is invalid HTML, and RNW renders
                    // both as real <button> elements on the web.
                    <View
                      style={styles.rowWrap}
                      onPointerEnter={() => setHovered(item.id)}
                      onPointerLeave={() =>
                        setHovered((current) =>
                          current === item.id ? null : current,
                        )
                      }
                    >
                      <PressableScale
                        onPress={() => {
                          // A row standing open is showing something;
                          // the tap that follows is for putting it away.
                          if (swipedOpen) {
                            setRevealed(null);
                            return;
                          }
                          onNavigate?.();
                          const target = {
                            pathname: '/chat/[id]' as const,
                            params: { id: item.id },
                          };
                          // From the ask, push — the home screen stays mounted
                          // beneath the thread, as the rest of the app expects.
                          // From one thread to another, replace, so hopping
                          // around the rail does not pile up a back stack.
                          if (activeConversationId) router.replace(target);
                          else router.push(target);
                        }}
                        // Held down, a row offers what its own control
                        // offers. One action for both ways in, and for
                        // the swipe: three routes to the same
                        // confirmation, not three behaviours.
                        onLongPress={
                          gestures ? () => confirmDelete(item) : undefined
                        }
                        accessibilityRole="button"
                        accessibilityLabel={item.title}
                        style={(state) => [
                          styles.row,
                          // A row a thumb has to hit, rather than one a
                          // cursor can land on precisely.
                          drawer && styles.rowTouch,
                          {
                            // What is being read is simply the lit row: a
                            // steady wash a step above the one hover gives,
                            // so the list says where you are without a second
                            // place to say it.
                            backgroundColor: withAlpha(
                              colors.foreground,
                              open ? 0.09 : lit ? 0.045 : 0,
                            ),
                            opacity: state.pressed ? 0.7 : 1,
                          },
                        ]}
                      >
                        {/* The title owns the whole row, so its tail runs under
                      the actions button rather than stopping short of a
                      control that is not there. When the button arrives
                      the ink dissolves beneath it. */}
                        <View
                          style={[
                            styles.rowTitle,
                            titleFade,
                            armed ? titleFadeArmed : titleFadeAtRest,
                          ]}
                        >
                          <Text
                            numberOfLines={1}
                            style={[
                              styles.rowText,
                              {
                                color: open
                                  ? colors.foreground
                                  : colors.secondaryForeground,
                                fontFamily: open
                                  ? fonts.bodyMedium
                                  : fonts.body,
                              },
                            ]}
                          >
                            {item.title}
                          </Text>
                        </View>
                      </PressableScale>

                      {/* What can be done to a row belongs on the row. It
                    surfaces on hover rather than sitting there always, so
                    a list at rest is a list of questions and not a column
                    of controls. */}
                      <PressableScale
                        onPress={() => confirmDelete(item)}
                        accessibilityRole="button"
                        accessibilityLabel={`Delete ${item.title}`}
                        testID={`conversation-actions-${item.id}`}
                        onFocus={() => setActionFocused(item.id)}
                        onBlur={() =>
                          setActionFocused((id) => (id === item.id ? null : id))
                        }
                        style={(state) => [
                          styles.rowAction,
                          {
                            opacity: armed ? 1 : 0,
                            backgroundColor: withAlpha(
                              colors.foreground,
                              isHovered(state) ? 0.1 : 0,
                            ),
                          },
                        ]}
                        // Invisible is untouchable: while the row is at rest the
                        // button must not swallow a click meant for the title.
                        pointerEvents={armed ? 'auto' : 'none'}
                      >
                        <Feather
                          name="more-horizontal"
                          size={15}
                          color={colors.mutedForeground}
                        />
                      </PressableScale>
                    </View>
                  );

                  if (!gestures) return row;

                  // The swipe is the third way to the one destructive
                  // action, and the least discoverable, so it changes
                  // nothing else: the visible control stays exactly
                  // where it was for the readers who never find it, and
                  // both still ask before deleting anything.
                  return (
                    <SwipeToReveal
                      enabled
                      open={swipedOpen}
                      onOpenChange={(next) =>
                        setRevealed((current) =>
                          next ? item.id : current === item.id ? null : current,
                        )
                      }
                      action={{
                        label: 'Delete',
                        accessibilityLabel: `Delete ${item.title}`,
                        onPress: () => {
                          setRevealed(null);
                          confirmDelete(item);
                        },
                      }}
                    >
                      {row}
                    </SwipeToReveal>
                  );
                }}
              />
            )}

            {/* Signed out, the reason to have an account, said where the
          questions the account would keep are listed. Signed in, who
          you are and the way out. No card around either: the rail's own
          glass is the surface, and the button underneath is the one
          thing here to press. */}
            <View style={styles.footer}>
              {hasRealAccount ? (
                <>
                  <Text
                    style={[styles.calloutTitle, { color: colors.foreground }]}
                    numberOfLines={1}
                  >
                    {accountName}
                  </Text>
                  <Text
                    style={[
                      styles.calloutText,
                      { color: colors.mutedForeground },
                    ]}
                  >
                    Your questions follow you across devices.
                  </Text>

                  <PressableScale
                    onPress={signOut}
                    accessibilityRole="button"
                    testID="sidebar-logout-button"
                    style={(state) => [
                      styles.loginButton,
                      {
                        backgroundColor: withAlpha(
                          colors.foreground,
                          isHovered(state) ? 0.2 : 0.12,
                        ),
                        opacity: state.pressed ? 0.7 : 1,
                      },
                    ]}
                  >
                    <Text
                      style={[styles.loginText, { color: colors.foreground }]}
                    >
                      Log out
                    </Text>
                  </PressableScale>
                </>
              ) : (
                <>
                  <Text
                    style={[styles.calloutTitle, { color: colors.foreground }]}
                  >
                    Keep what you&apos;ve learned
                  </Text>
                  <Text
                    style={[
                      styles.calloutText,
                      { color: colors.mutedForeground },
                    ]}
                  >
                    Sign in and your questions stay with you, with their
                    sources attached.
                  </Text>

                  <PressableScale
                    onPress={goToLogin}
                    accessibilityRole="button"
                    testID="sidebar-login-button"
                    style={(state) => [
                      styles.loginButton,
                      {
                        // Same borderless recipe as the new-chat button
                        // above it, so the rail's two buttons stay one
                        // material rather than two.
                        backgroundColor: withAlpha(
                          colors.foreground,
                          isHovered(state) ? 0.2 : 0.12,
                        ),
                        opacity: state.pressed ? 0.7 : 1,
                      },
                    ]}
                  >
                    <Text
                      style={[styles.loginText, { color: colors.foreground }]}
                    >
                      Log in
                    </Text>
                  </PressableScale>
                </>
              )}
            </View>

            {/* The rail's colophon, sharing its line with the toggle: the
                foot of a page carries the imprint and the small print,
                and one row of it is worth more than three stacked
                lines. The rule sits above it rather than above the
                callout, so it separates the two things the rail says
                about itself from the one thing it asks of the reader.

                The indent clears the toggle's column exactly, so the
                two sit side by side without either being placed
                relative to the other — the toggle is absolute and does
                not move, and this simply starts where it ends. */}
            <View style={[styles.colophon, { borderTopColor: colors.border }]}>
              <View style={styles.colophonRow}>
                <View style={styles.colophonLinks}>
                  {footerLink(
                    'About',
                    () => router.push('/about'),
                    'about-button',
                  )}
                  {separator}
                  {footerLink('Terms', showTerms, 'terms-button')}
                  {separator}
                  {footerLink('Privacy', showPrivacy, 'privacy-button')}
                </View>
                {/* The imprint is the quietest thing the rail says: half the
                    muted ink, so it sits under the links beside it rather
                    than level with them. Half of the mode's own muted
                    colour, not a fixed grey, so it stays a step behind at
                    night too. */}
                <Text
                  style={[
                    styles.copyright,
                    { color: withAlpha(colors.mutedForeground, 0.5) },
                  ]}
                >
                  © {year} AH · Ansari
                </Text>
              </View>
            </View>
          </Animated.View>
        )}

        {/* Last, so it paints over the column it shares a corner with,
            and absolute, so the wide content's own layout never decides
            where it lands. A drawer has nothing to collapse to — it is
            put away by tapping the page, not by narrowing to a strip —
            so it carries no toggle. */}
        {!drawer && toggle}
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  // Absolute rather than a flex sibling: the ask measures its own stage
  // to glide the composer into the thread's position, and a rail in the
  // flow would change that stage's box on one screen but not the other.
  rail: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 0,
    width: SIDEBAR_WIDTH,
    zIndex: 30,
    borderRightWidth: StyleSheet.hairlineWidth,
  },
  // The clip, and everything the rail lays out, one box in from the
  // glass. Wide content keeps its full-width measure at every width the
  // rail passes through; this is what turns that into a clip rather
  // than a reflow. Nothing the rail draws — not the mark at full tilt,
  // not the field's focus ring — reaches the gutter, so nothing else is
  // caught by it.
  clip: {
    flex: 1,
    alignSelf: 'stretch',
    paddingTop: RAIL_TOP,
    paddingHorizontal: RAIL_PAD,
    paddingBottom: RAIL_FOOT,
    alignItems: 'flex-start',
    overflow: 'hidden',
  },
  // Exactly the mark's own box, centred on the icon column, so the turn
  // is about the artwork's centre and the pinned position is the same
  // arithmetic in both states.
  markSlot: {
    width: ICON_COLUMN,
    height: MARK_HEIGHT,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 18,
  },
  // The head of the rail's trailing edge. Yoga measures an absolute
  // child from the border box rather than the padding box, so the
  // gutter is added back by hand — and because it is the same gutter
  // the mark keeps on the other side, narrowing the rail to a strip
  // slides this square exactly onto the mark's.
  railToggle: {
    position: 'absolute',
    top: TOGGLE_TOP,
    right: RAIL_PAD,
  },
  expandField: {
    cursor: 'pointer',
  },
  iconButtonStacked: {
    width: ICON_COLUMN,
    height: ICON_COLUMN,
    alignItems: 'center',
    justifyContent: 'center',
    ...rounded(RADIUS.sm),
    cursor: 'pointer',
  },
  newQuestion: {
    // The rail's own content box: at full width it is the wide button,
    // at the strip's width it is the square, and in between it is
    // whatever the edge is doing that frame.
    alignSelf: 'stretch',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    height: ICON_COLUMN,
    // Puts the plus on the icon column's centre line, where the search
    // button below it also sits. There is no border to measure the
    // padding box in from any more, so the inset is the plain half of
    // what the glyph leaves over; the hairline correction that used to
    // sit here would now push the plus off centre by the width it was
    // put there to take back.
    paddingLeft: (ICON_COLUMN - NEW_QUESTION_GLYPH) / 2,
    ...rounded(RADIUS.sm),
    overflow: 'hidden',
    cursor: 'pointer',
  },
  // The arithmetic above only lands the plus on the centre line if the
  // glyph really is that wide. Left to itself it is not: the label keeps
  // its full measure while the button narrows to the strip's square, so
  // the row overflows its own box, and the plus — the one item in it
  // that had not been told to hold its size — was the one the layout
  // took the difference out of. Squeezed narrower, it drifted off the
  // column. Fixed box, glyph centred in it, nothing left to give.
  newQuestionIcon: {
    flexShrink: 0,
    width: NEW_QUESTION_GLYPH,
    height: NEW_QUESTION_GLYPH,
    lineHeight: NEW_QUESTION_GLYPH,
    textAlign: 'center',
  },
  newQuestionText: {
    fontSize: 13.5,
    fontFamily: fonts.bodyMedium,
    // Keeps its natural measure while the button narrows around it: a
    // label that shrinks would re-wrap on its way out.
    flexShrink: 0,
  },
  // One slot, one height, both states drawn inside it — so the column
  // below does not step up or down as the two cross-fade.
  searchSlot: {
    alignSelf: 'stretch',
    height: ICON_COLUMN,
    marginTop: 10,
  },
  searchNarrow: {
    position: 'absolute',
    left: 0,
    top: 0,
  },
  searchWide: {
    position: 'absolute',
    left: 0,
    top: (ICON_COLUMN - COMPACT_FIELD_HEIGHT) / 2,
    width: CONTENT_WIDTH,
  },
  // The field carries its own top margin for the rail's old stacking;
  // the slot places it now.
  searchFieldReset: {
    marginTop: 0,
  },
  wideColumn: {
    width: CONTENT_WIDTH,
    flex: 1,
  },
  sectionLabel: {
    marginTop: 18,
    marginBottom: 6,
    paddingHorizontal: 6,
    fontSize: 12,
    lineHeight: 16,
    fontFamily: fonts.bodyMedium,
  },
  list: {
    flex: 1,
  },
  listContent: {
    paddingBottom: 8,
  },
  listState: {
    flex: 1,
    paddingTop: 14,
    paddingHorizontal: 6,
  },
  emptyText: {
    fontSize: 12.5,
    lineHeight: 18,
    fontFamily: fonts.body,
  },
  rowWrap: {
    justifyContent: 'center',
  },
  rowTouch: {
    minHeight: 44,
  },
  row: {
    minHeight: 34,
    justifyContent: 'center',
    // Even padding: no gutter is held back for the hover control, so a
    // title measures and truncates against the whole row and keeps that
    // measure whether or not the button is showing.
    paddingLeft: 8,
    paddingRight: 8,
    ...rounded(RADIUS.sm),
    cursor: 'pointer',
  },
  // The mask belongs on a box the width of the row, not on the text: a
  // short title's own box stops early, and fading its last words would
  // be a fade with nothing to hide.
  rowTitle: {
    alignSelf: 'stretch',
  },
  rowText: {
    fontSize: 13,
    lineHeight: 18,
  },
  rowAction: {
    position: 'absolute',
    right: 4,
    width: 24,
    height: 24,
    alignItems: 'center',
    justifyContent: 'center',
    ...rounded(RADIUS.xs),
    cursor: 'pointer',
    // The button arrives and leaves on the same 160ms as the fade under
    // it, so the two read as one movement.
    ...(Platform.OS === 'web'
      ? ({
          transitionProperty: 'opacity',
          transitionDuration: '160ms',
          transitionTimingFunction: 'ease-out',
        } as object)
      : {}),
  },
  footer: {
    paddingTop: 12,
    paddingBottom: 16,
    paddingHorizontal: 6,
    gap: 3,
  },
  colophon: {
    alignSelf: 'stretch',
    paddingTop: 13,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  colophonRow: {
    alignSelf: 'stretch',
    paddingHorizontal: 6,
  },
  colophonLinks: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  footerLink: {
    paddingVertical: 3,
    cursor: 'pointer',
  },
  copyright: {
    fontSize: 11,
    lineHeight: 16,
    fontFamily: fonts.body,
  },
  loginButton: {
    marginTop: 10,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 34,
    ...rounded(RADIUS.sm),
    cursor: 'pointer',
  },
  loginText: {
    fontSize: 13,
    fontFamily: fonts.bodyMedium,
  },
  calloutTitle: {
    fontSize: 12.5,
    lineHeight: 16,
    fontFamily: fonts.bodySemiBold,
  },
  calloutText: {
    fontSize: 11.5,
    lineHeight: 16,
    fontFamily: fonts.body,
  },
  footerLinkText: {
    fontSize: 12,
    lineHeight: 16,
    fontFamily: fonts.bodyMedium,
  },
});

/**
 * Where the actions button lands on a row, measured in from the right
 * edge of the title's own box, and how long the ink takes to dissolve
 * before it. The title is masked rather than painted over: a patch of
 * paint would have to guess at the row's composited colour — thin wash
 * over the rail's glass over the paper, and a step brighter again on
 * the row being read — and any guess that is slightly off reads as a
 * seam. Fading the ink itself lets whatever the row is showing come
 * through untouched, in all three states.
 */
const FADE_CLEAR = 20;
const FADE_LENGTH = 38;

const TITLE_MASK = `linear-gradient(to right, #000 calc(100% - ${
  FADE_CLEAR + FADE_LENGTH
}px), transparent calc(100% - ${FADE_CLEAR}px))`;

const titleFadeArmed =
  Platform.OS === 'web'
    ? ({ maskSize: '100% 100%' } as unknown as ViewStyle)
    : null;

const titleFade =
  Platform.OS === 'web'
    ? ({
        maskImage: TITLE_MASK,
        maskRepeat: 'no-repeat',
        // A gradient swapped for another gradient jumps; a length
        // interpolates. So the mask never changes — it is simply sized
        // wider than the row at rest, which parks its fade off the
        // right edge, and slides back in as the button arrives.
        transitionProperty: '-webkit-mask-size, mask-size',
        transitionDuration: '160ms',
        transitionTimingFunction: 'ease-out',
      } as unknown as ViewStyle)
    : null;

const titleFadeAtRest =
  Platform.OS === 'web'
    ? ({
        maskSize: `calc(100% + ${FADE_CLEAR + FADE_LENGTH + 4}px) 100%`,
      } as unknown as ViewStyle)
    : null;
