import React from 'react';
import {
  Platform,
  Pressable,
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
import Animated, { FadeIn, ReduceMotion } from 'react-native-reanimated';
import { useColors } from '@/hooks/useColors';
import { useDesktop } from '@/hooks/useDesktop';
import { useSidebarInset } from '@/hooks/useSidebarCollapsed';
import { fonts } from '@/constants/colors';
import {
  answerLeading,
  answerSize,
  barContentTop,
  headerBarHeight,
  phoneGutter,
  READING_COLUMN,
} from '@/constants/layout';
import { DURATION, EASE_OUT } from '@/constants/motion';
import {
  FEATURED,
  featuredMonth,
  featuredYear,
  type FeaturedItem,
} from '@/constants/featured';
import { withAlpha } from '@/lib/color';
import { openEmail, openExternalLink } from '@/lib/link';
import { isHovered } from '@/lib/web';
import { heading } from '@/lib/semantics';
import { useScreenLandmark } from '@/hooks/useScreenLandmark';
import { AnsariMarkBrass } from '@/components/AnsariMarkBrass';
import { GlassCircleButton } from '@/components/GlassCircleButton';
import { HeaderBar } from '@/components/HeaderBar';

const FEEDBACK_EMAIL = 'feedback@ansari.chat';
const DOCS_URL = 'https://docs.ansari.chat/';
const BACKEND_URL = 'https://github.com/ansari-project/ansari-backend';
const FRONTEND_URL = 'https://github.com/ansari-project/ansari-frontend';
const PROJECT_URL = 'https://github.com/ansari-project';

// The page settling onto the paper. One fade, once — front matter is
// read, not performed, and a section that slides in from somewhere is
// a section the reader watches instead of reads.
const PAGE_ENTER = FadeIn.duration(DURATION.enter)
  .easing(EASE_OUT)
  .reduceMotion(ReduceMotion.System);

/**
 * A word or two of prose that leaves the page.
 *
 * A nested `<Text>` rather than a control: these sit inside sentences,
 * and a pressable wrapped around a phrase would break the line it lives
 * in. react-native-web gives anything with a link role a tab stop of
 * its own, so the keyboard reaches each one and the app's focus ring
 * draws around it.
 */
function InlineLink({
  children,
  onPress,
  label,
}: {
  children: string;
  onPress: () => void;
  label?: string;
}) {
  const colors = useColors();
  return (
    <Text
      accessibilityRole="link"
      accessibilityLabel={label}
      onPress={onPress}
      style={[
        styles.inlineLink,
        {
          color: colors.strongForeground,
          textDecorationColor: withAlpha(colors.foreground, 0.4),
        },
      ]}
    >
      {children}
    </Text>
  );
}

/**
 * The break between passages: the illuminated folio's own ornament,
 * held to a hand's width in the middle of the measure. Used twice — to
 * open the page under the masthead, and to close the prose before the
 * appendix — rather than between every section, where it would stop
 * being an ornament and become a divider.
 */
function Ornament() {
  const colors = useColors();
  return (
    <View
      style={styles.ornamentRow}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <View style={[styles.ornamentRule, { backgroundColor: colors.accent }]} />
      <Text style={[styles.ornament, { color: colors.accent }]}>۝</Text>
      <View style={[styles.ornamentRule, { backgroundColor: colors.accent }]} />
    </View>
  );
}

function Section({
  title,
  children,
  desktop,
}: {
  title: string;
  children: React.ReactNode;
  desktop: boolean;
}) {
  const colors = useColors();
  return (
    <View style={desktop ? styles.sectionDesktop : styles.section}>
      {/* Second level: the masthead above carries the page's name, and
          these are its parts. A flat "header" role made the outline one
          long row of peers with no page title in it. */}
      <Text
        {...heading(2)}
        style={[
          desktop ? styles.headingDesktop : styles.heading,
          { color: colors.strongForeground },
        ]}
      >
        {title}
      </Text>
      {children}
    </View>
  );
}

function Para({
  children,
  desktop,
  first,
}: {
  children: React.ReactNode;
  desktop: boolean;
  first?: boolean;
}) {
  const colors = useColors();
  // The About page is a reading page, so it is set at the reading
  // page's size — including the step down the smallest phones take,
  // which is decided in one place for every column of prose in the app.
  const { width } = useWindowDimensions();
  return (
    <Text
      selectable={Platform.OS === 'web'}
      style={[
        desktop ? styles.proseDesktop : styles.prose,
        {
          fontSize: answerSize(desktop, width),
          lineHeight: answerLeading(desktop, width),
        },
        { color: colors.foreground },
        !first && styles.paraGap,
      ]}
    >
      {children}
    </Text>
  );
}

/**
 * One entry in the appendix, set the way a bibliography is: the year
 * hangs in its own right-aligned column and everything else begins at
 * the same left edge, so the eye runs down the titles and can still
 * date any of them without hunting.
 *
 * The whole record is the target, not just the title — three lines of
 * type about one thing should not need the reader to aim at the top one.
 */
function FeaturedEntry({
  item,
  first,
  desktop,
}: {
  item: FeaturedItem;
  first: boolean;
  desktop: boolean;
}) {
  const colors = useColors();
  const month = featuredMonth(item.date);
  return (
    <Pressable
      onPress={() => openExternalLink(item.href)}
      accessibilityRole="link"
      accessibilityLabel={`${item.title}. ${item.venue}. ${month}.`}
      accessibilityHint="Opens in a new tab"
      style={(state) => [
        styles.entry,
        !first && [styles.entryRuled, { borderTopColor: colors.border }],
        { opacity: state.pressed ? 0.62 : 1 },
      ]}
    >
      {(state) => (
        <>
          <Text
            style={[
              styles.entryYear,
              {
                color: withAlpha(colors.foreground, 0.5),
                lineHeight: desktop ? 25 : 24,
              },
            ]}
          >
            {featuredYear(item.date)}
          </Text>
          <View style={styles.entryBody}>
            <Text
              style={[
                desktop ? styles.entryTitleDesktop : styles.entryTitle,
                {
                  color: colors.strongForeground,
                  textDecorationLine: isHovered(state) ? 'underline' : 'none',
                  textDecorationColor: withAlpha(colors.foreground, 0.4),
                },
              ]}
            >
              {item.title}
            </Text>
            <Text
              style={[
                styles.entryVenue,
                { color: withAlpha(colors.foreground, 0.72) },
              ]}
            >
              {item.venue} · {month}
            </Text>
            <Text
              style={[
                styles.entryDescription,
                { color: withAlpha(colors.foreground, 0.82) },
              ]}
            >
              {item.description}
            </Text>
          </View>
        </>
      )}
    </Pressable>
  );
}

/**
 * About Ansari — the front matter of the book.
 *
 * Everything a curious reader might want to know about Ansari used to
 * live either in a two-sentence notice or on a documentation site that
 * looks nothing like the app. This is that material, set as a title
 * page and a colophon: a centred masthead, a standfirst, then sections
 * parted by air rather than by boxes, and an appendix of what has been
 * written and said about the project.
 *
 * No cards, no chips, no coloured bands. The distinction between a
 * podcast, a paper and a conference talk is carried by the words that
 * name them and by the type they are set in, which is how a printed
 * bibliography has always managed it.
 */
export default function AboutScreen() {
  const colors = useColors();
  const screenLandmark = useScreenLandmark();
  const desktop = useDesktop();
  const insets = useSafeAreaInsets();
  const sidebarInset = useSidebarInset();
  const { width } = useWindowDimensions();
  const barHeight = headerBarHeight(desktop, insets.top);
  const chromeTop = desktop ? 13 : insets.top + 6;

  const goBack = () =>
    router.canGoBack() ? router.back() : router.replace('/');

  return (
    // The paper, the rail and the account cluster stand above the
    // navigator (see `AppFrame`), which is also where the grain is
    // turned off for this route: under a full column of type the
    // texture only competes with the letters.
    <>
      {Platform.OS === 'web' && (
        <Head>
          <title>About Ansari — how it answers, and who builds it</title>
          <meta
            name="description"
            content="Ansari is a free, open-source assistant that answers from the Qur'an and Sunnah and cites its sources. How it works, how it has been checked, who builds it, and what has been written about it."
          />
        </Head>
      )}

      {/* The colophon is the page; the rail and the back bar are the
          chrome around it. See the same landmark on the other two
          screens — there is one `main` on screen at a time. */}
      <Animated.View
        style={[styles.flex, desktop && sidebarInset]}
        {...screenLandmark}
      >
        <ScrollView
          contentContainerStyle={[
            styles.page,
            desktop && styles.pageDesktop,
            {
              paddingTop: barContentTop(desktop, insets.top),
              paddingBottom: insets.bottom + (desktop ? 72 : 56),
              // The same side air a thread is read at, so moving between
              // the two pages does not move the column under the reader.
              ...(desktop ? null : { paddingHorizontal: phoneGutter(width) }),
            },
          ]}
          scrollIndicatorInsets={{ top: desktop ? 0 : barHeight }}
        >
          <Animated.View entering={PAGE_ENTER}>
            {/* The title page: the mark, the name, and one line saying
                what the thing is. Centred, and the only centred type on
                the page — everything below it is read, not presented. */}
            <View style={styles.masthead}>
              <AnsariMarkBrass height={desktop ? 46 : 40} />
              <Text
                {...heading(1)}
                style={[
                  desktop ? styles.titleDesktop : styles.title,
                  { color: colors.strongForeground },
                ]}
              >
                Ansari
              </Text>
              <Text
                style={[
                  desktop ? styles.standfirstDesktop : styles.standfirst,
                  { color: withAlpha(colors.foreground, 0.78) },
                ]}
              >
                An assistant for understanding Islam and practising it better —
                answering from the Qur&apos;an and the Sunnah, and showing you
                what it drew on.
              </Text>
            </View>

            <Ornament />

            <Section title="What Ansari is" desktop={desktop}>
              <Para desktop={desktop} first>
                Ansari answers questions about Islam. Ask it about a verse, a
                hadith, a du&apos;a for a particular moment, or a point of fiqh,
                and it replies from the Qur&apos;an and the Sunnah and cites
                what it used, so you can open the original text and read it
                yourself. The name means &ldquo;helper&rdquo; in Arabic.
              </Para>
            </Section>

            <Section title="How it answers" desktop={desktop}>
              <Para desktop={desktop} first>
                It is not a general chatbot with an Islamic manner. Before
                Ansari writes anything it searches the Qur&apos;an and the
                hadith collections and answers out of what it finds, which is
                what keeps it from inventing a verse or a narration. It stays on
                Islamic topics rather than ranging wherever a question leads.
              </Para>
              <Para desktop={desktop}>
                It is also not a scholar, and is not meant to stand in for one.
                Read an answer as a pointer to the sources beneath it, and take
                anything consequential to someone qualified to rule on it.
              </Para>
            </Section>

            <Section title="How it has been checked" desktop={desktop}>
              <Para desktop={desktop} first>
                BATIK — a hundred-question test of Islamic knowledge, drawn from
                the first 2,500 questions readers actually asked — is the
                standing measure, and Ansari now answers all of it correctly. It
                has sat the final exams of two Darul Qasim courses, on the
                Qur&apos;an and on theology, with no access to the course
                materials, and scored around eighty per cent on each. Before one
                Ramadan a panel rated thirty-four answers across fiqh,
                spirituality, Qur&apos;an and sira at 4.4 out of 5, and found
                nothing fabricated among them.
              </Para>
              <Para desktop={desktop}>
                More than 2,500 real conversations have been read by hand. Nine
                answers were uncertain enough to send to scholars, who judged
                eight of them correct; the one it got wrong was a knotty
                question of inheritance.
              </Para>
              <Para desktop={desktop}>
                So Ansari can be wrong, and it is better to assume it might be.
                If an answer looks off, tell it you want to flag the answer and
                a person will read the conversation — or write to{' '}
                <InlineLink
                  onPress={() => openEmail(FEEDBACK_EMAIL)}
                  label={`Email ${FEEDBACK_EMAIL}`}
                >
                  {FEEDBACK_EMAIL}
                </InlineLink>
                .
              </Para>
            </Section>

            <Section title="Who builds it" desktop={desktop}>
              <Para desktop={desktop} first>
                Waleed Kadous is Ansari&apos;s primary author. EndeavorPal
                builds the web and mobile apps. All of it is open source: the{' '}
                <InlineLink onPress={() => openExternalLink(BACKEND_URL)}>
                  backend
                </InlineLink>{' '}
                and the{' '}
                <InlineLink onPress={() => openExternalLink(FRONTEND_URL)}>
                  frontend
                </InlineLink>{' '}
                are public, along with the rest of the{' '}
                <InlineLink onPress={() => openExternalLink(PROJECT_URL)}>
                  Ansari Project
                </InlineLink>
                .
              </Para>
            </Section>

            <Section title="What it costs" desktop={desktop}>
              <Para desktop={desktop} first>
                Nothing, and there is nothing to sign up for. Serving an answer
                is not free — each exchange costs a few cents of model time —
                but that is carried by the people who build Ansari rather than
                by the person asking.
              </Para>
            </Section>

            <Section title="Getting in touch" desktop={desktop}>
              <Para desktop={desktop} first>
                Corrections, mistakes and suggestions go to{' '}
                <InlineLink
                  onPress={() => openEmail(FEEDBACK_EMAIL)}
                  label={`Email ${FEEDBACK_EMAIL}`}
                >
                  {FEEDBACK_EMAIL}
                </InlineLink>
                , which is read daily. The long version of all of this —
                everything Ansari can do, and the full results behind the
                testing — is at{' '}
                <InlineLink onPress={() => openExternalLink(DOCS_URL)}>
                  docs.ansari.chat
                </InlineLink>
                .
              </Para>
            </Section>

            <Ornament />

            <View>
              <Text
                {...heading(2)}
                style={[
                  desktop ? styles.headingDesktop : styles.heading,
                  { color: colors.strongForeground },
                ]}
              >
                Recently featured
              </Text>
              <Text
                style={[
                  styles.appendixNote,
                  { color: withAlpha(colors.foreground, 0.72) },
                ]}
              >
                Podcasts, talks, papers and writing about Ansari and the
                questions it raises.
              </Text>
              <View style={styles.entries}>
                {FEATURED.map((item, i) => (
                  <FeaturedEntry
                    key={item.href}
                    item={item}
                    first={i === 0}
                    desktop={desktop}
                  />
                ))}
              </View>
            </View>

            <View
              style={[styles.closingRule, { backgroundColor: colors.border }]}
            />

            <Pressable
              onPress={goBack}
              accessibilityRole="link"
              accessibilityLabel="Back to asking Ansari a question"
              testID="about-back-to-ask"
              style={(state) => [
                styles.closingLink,
                { opacity: state.pressed ? 0.55 : isHovered(state) ? 1 : 0.8 },
              ]}
            >
              <Text
                style={[styles.closingText, { color: colors.strongForeground }]}
              >
                Ask Ansari a question
              </Text>
            </Pressable>
          </Animated.View>
        </ScrollView>
      </Animated.View>

      {/* Phones have no rail, so the way back is the bar — the same one
          the thread wears, in the same place, carrying the same back
          button. Desktop keeps its navigation in the rail. */}
      {!desktop && (
        <>
          <HeaderBar height={barHeight} />
          <View
            style={[
              styles.header,
              { top: chromeTop },
              // The back disc stands on the page's own gutter, so it and
              // the first line of the column below share an edge.
              !desktop && {
                left: phoneGutter(width),
                right: phoneGutter(width),
              },
            ]}
            pointerEvents="box-none"
          >
            <GlassCircleButton
              onPress={goBack}
              size={38}
              testID="back-button"
              accessibilityLabel="Back"
            >
              <Feather
                name="chevron-left"
                size={20}
                color={colors.foreground}
              />
            </GlassCircleButton>
            <Text
              style={[styles.headerTitle, { color: colors.strongForeground }]}
              numberOfLines={1}
            >
              About
            </Text>
          </View>
        </>
      )}
    </>
  );
}

const styles = StyleSheet.create({
  flex: {
    flex: 1,
  },
  header: {
    position: 'absolute',
    zIndex: 20,
    left: 16,
    right: 16,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  headerTitle: {
    flex: 1,
    fontSize: 16,
    fontFamily: fonts.displayMedium,
  },
  // One column at the book's own measure, centred in whatever room is
  // left beside the rail. A phone gets a little more air at the edges
  // than the thread does: this is a page to read, not a conversation.
  page: {
    paddingHorizontal: 20,
  },
  pageDesktop: {
    width: '100%',
    maxWidth: READING_COLUMN,
    alignSelf: 'center',
    paddingHorizontal: 0,
  },
  masthead: {
    alignItems: 'center',
    gap: 14,
  },
  title: {
    fontSize: 28,
    lineHeight: 36,
    letterSpacing: 0.2,
    fontFamily: fonts.display,
    textAlign: 'center',
  },
  titleDesktop: {
    fontSize: 32,
    lineHeight: 41,
    letterSpacing: 0.2,
    fontFamily: fonts.display,
    textAlign: 'center',
  },
  // The standfirst is chrome, not reading copy: the serif's italic,
  // the same voice the greeting is set in, held to a shorter measure
  // than the prose below so it reads as a caption to the title.
  standfirst: {
    maxWidth: 400,
    fontSize: 16,
    lineHeight: 25,
    fontFamily: fonts.displayItalic,
    textAlign: 'center',
  },
  standfirstDesktop: {
    maxWidth: 440,
    fontSize: 17,
    lineHeight: 27,
    fontFamily: fonts.displayItalic,
    textAlign: 'center',
  },
  ornamentRow: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'center',
    gap: 12,
    width: 172,
    marginVertical: 34,
  },
  ornamentRule: {
    flex: 1,
    height: StyleSheet.hairlineWidth,
    opacity: 0.6,
  },
  ornament: {
    fontSize: 18,
    lineHeight: 24,
  },
  // Sections are parted by air. The space above a heading is what makes
  // the break; the small space below binds the heading to its own text.
  section: {
    marginTop: 34,
  },
  sectionDesktop: {
    marginTop: 40,
  },
  heading: {
    fontSize: 18,
    lineHeight: 25,
    fontFamily: fonts.displayMedium,
    marginBottom: 9,
  },
  headingDesktop: {
    fontSize: 19,
    lineHeight: 26,
    fontFamily: fonts.displayMedium,
    marginBottom: 10,
  },
  // The answer's own setting, exactly: Literata Light at a book size
  // with open leading, straight on the paper.
  prose: {
    fontSize: 17,
    lineHeight: 28.5,
    fontFamily: fonts.prose,
  },
  proseDesktop: {
    fontSize: 18,
    lineHeight: 30.5,
    fontFamily: fonts.prose,
  },
  paraGap: {
    marginTop: 15,
  },
  inlineLink: {
    textDecorationLine: 'underline',
  },
  appendixNote: {
    fontSize: 15,
    lineHeight: 24,
    fontFamily: fonts.proseItalic,
    marginBottom: 4,
  },
  entries: {
    marginTop: 18,
  },
  // The hanging indent: a fixed, right-aligned year column, so every
  // title starts at the same left edge and a wrapped line falls under
  // the words rather than under the date.
  entry: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingVertical: 14,
    cursor: 'pointer',
  },
  entryRuled: {
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  entryYear: {
    width: 42,
    marginRight: 14,
    textAlign: 'right',
    fontSize: 13.5,
    fontFamily: fonts.displayMedium,
  },
  entryBody: {
    flex: 1,
  },
  entryTitle: {
    fontSize: 16,
    lineHeight: 24,
    fontFamily: fonts.proseMedium,
  },
  entryTitleDesktop: {
    fontSize: 16.5,
    lineHeight: 25,
    fontFamily: fonts.proseMedium,
  },
  // The venue takes the chrome voice's italic — the same treatment a
  // source title gets in an answer's footnotes — so the kind of thing
  // an entry is reads differently from the title without a label.
  entryVenue: {
    marginTop: 3,
    fontSize: 14,
    lineHeight: 21,
    fontFamily: fonts.displayItalic,
  },
  entryDescription: {
    marginTop: 5,
    fontSize: 15,
    lineHeight: 24,
    fontFamily: fonts.prose,
  },
  closingRule: {
    width: 64,
    height: StyleSheet.hairlineWidth,
    alignSelf: 'center',
    marginTop: 36,
    marginBottom: 26,
  },
  closingLink: {
    alignSelf: 'center',
    paddingVertical: 6,
    paddingHorizontal: 8,
    cursor: 'pointer',
  },
  closingText: {
    fontSize: 16,
    lineHeight: 24,
    fontFamily: fonts.displayMedium,
  },
});
