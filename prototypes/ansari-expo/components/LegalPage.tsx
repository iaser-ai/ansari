import React from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { Feather } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Animated, { FadeIn, ReduceMotion } from 'react-native-reanimated';
import { useColors } from '@/hooks/useColors';
import { useDesktop } from '@/hooks/useDesktop';
import { useSidebarInset } from '@/hooks/useSidebarCollapsed';
import { useScreenLandmark } from '@/hooks/useScreenLandmark';
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
import type { LegalBlock, LegalDoc, LegalInline } from '@/constants/legal';
import { withAlpha } from '@/lib/color';
import { openEmail } from '@/lib/link';
import { heading } from '@/lib/semantics';
import { isHovered } from '@/lib/web';
import { GlassCircleButton } from '@/components/GlassCircleButton';
import { HeaderBar } from '@/components/HeaderBar';
import { InlineLink, Ornament, Para, Section } from '@/components/ReadingPage';

// The same single settle the About page makes — see `app/about.tsx`.
const PAGE_ENTER = FadeIn.duration(DURATION.enter)
  .easing(EASE_OUT)
  .reduceMotion(ReduceMotion.System);

function Inline({ part }: { part: LegalInline }) {
  if (typeof part === 'string') return <>{part}</>;
  if (part.kind === 'link') {
    return (
      <InlineLink onPress={() => router.push(part.href)}>
        {part.text}
      </InlineLink>
    );
  }
  return (
    <InlineLink
      onPress={() => openEmail(part.address)}
      label={`Email ${part.address}`}
    >
      {part.address}
    </InlineLink>
  );
}

function Spans({ parts }: { parts: LegalInline[] }) {
  return (
    <>
      {parts.map((part, i) => (
        <Inline key={i} part={part} />
      ))}
    </>
  );
}

/**
 * A bulleted list in the answer's own list setting (`AnswerProse`): a
 * fixed, right-aligned marker column, so a wrapped line begins under the
 * first word rather than under the bullet.
 */
function List({
  items,
  desktop,
  first,
}: {
  items: LegalInline[][];
  desktop: boolean;
  first: boolean;
}) {
  const colors = useColors();
  const { width } = useWindowDimensions();
  const size = answerSize(desktop, width);
  const leading = answerLeading(desktop, width);
  return (
    <View style={!first && styles.blockGap}>
      {items.map((item, i) => (
        <View key={i} style={[styles.listRow, i > 0 && styles.listRowGap]}>
          <Text
            style={[
              styles.listMarker,
              {
                fontSize: size * 0.9,
                lineHeight: leading,
                color: withAlpha(colors.foreground, 0.62),
              },
            ]}
          >
            {'•'}
          </Text>
          <View style={styles.listContent}>
            <Para desktop={desktop} first>
              <Spans parts={item} />
            </Para>
          </View>
        </View>
      ))}
    </View>
  );
}

function Blocks({
  blocks,
  desktop,
}: {
  blocks: LegalBlock[];
  desktop: boolean;
}) {
  return (
    <>
      {blocks.map((block, i) =>
        block.type === 'p' ? (
          <Para key={i} desktop={desktop} first={i === 0}>
            <Spans parts={block.parts} />
          </Para>
        ) : (
          <List key={i} items={block.items} desktop={desktop} first={i === 0} />
        ),
      )}
    </>
  );
}

/**
 * A legal document — the Terms of Service or the Privacy Policy — set as
 * a reading page (#241).
 *
 * The same page About is: the reading column beside the rail, the
 * answer's prose size, sections parted by air under the same headings,
 * and on phones the thread's back bar. It opens on the document's own
 * title rather than the brass mark — a legal page should not dress up as
 * a title page — with the effective date under it in the standfirst's
 * italic, since that is the first thing anyone checking terms looks for.
 *
 * The words come from `constants/legal.ts` exactly as written; this
 * component only sets them. Each route names its own tab in a `<Head>`,
 * where the title scan in `lib/page-metadata.test.ts` can read it.
 */
export function LegalPage({
  doc,
  barTitle,
}: {
  doc: LegalDoc;
  /** The phone bar's short name for the page. */
  barTitle: string;
}) {
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
    <>
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
              ...(desktop ? null : { paddingHorizontal: phoneGutter(width) }),
            },
          ]}
          scrollIndicatorInsets={{ top: desktop ? 0 : barHeight }}
        >
          <Animated.View entering={PAGE_ENTER}>
            <View style={styles.masthead}>
              <Text
                {...heading(1)}
                style={[
                  desktop ? styles.titleDesktop : styles.title,
                  { color: colors.strongForeground },
                ]}
              >
                {doc.title}
              </Text>
              <Text
                style={[
                  styles.effective,
                  { color: withAlpha(colors.foreground, 0.72) },
                ]}
              >
                Effective Date: {doc.effectiveDate}
              </Text>
            </View>

            <Ornament />

            <Blocks blocks={doc.preamble} desktop={desktop} />

            {doc.sections.map((section) => (
              <Section
                key={section.heading}
                title={section.heading}
                desktop={desktop}
              >
                <Blocks blocks={section.blocks} desktop={desktop} />
              </Section>
            ))}

            <View
              style={[styles.closingRule, { backgroundColor: colors.border }]}
            />

            <Pressable
              onPress={goBack}
              accessibilityRole="link"
              accessibilityLabel="Back to asking Ansari a question"
              testID="legal-back-to-ask"
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
          About and the thread wear. Desktop keeps its navigation in the
          rail. */}
      {!desktop && (
        <>
          <HeaderBar height={barHeight} />
          <View
            style={[
              styles.header,
              {
                top: chromeTop,
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
              {barTitle}
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
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  headerTitle: {
    flex: 1,
    fontSize: 16,
    fontFamily: fonts.displayMedium,
  },
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
    gap: 10,
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
  effective: {
    fontSize: 15,
    lineHeight: 23,
    fontFamily: fonts.displayItalic,
    textAlign: 'center',
  },
  blockGap: {
    marginTop: 15,
  },
  listRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
  },
  listRowGap: {
    marginTop: 7,
  },
  listMarker: {
    minWidth: 17,
    marginRight: 9,
    textAlign: 'right',
    fontFamily: fonts.prose,
  },
  listContent: {
    flex: 1,
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
