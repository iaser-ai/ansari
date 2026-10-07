import React from 'react';
import {
  Platform,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useColors } from '@/hooks/useColors';
import { fonts } from '@/constants/colors';
import { answerLeading, answerSize } from '@/constants/layout';
import { RADIUS, rounded } from '@/constants/radius';
import { withAlpha } from '@/lib/color';
import { heading } from '@/lib/semantics';
import { isHovered } from '@/lib/web';
import { PressableScale } from '@/components/PressableScale';

/**
 * The parts a long-form reading page is set from — About, and the Terms
 * and Privacy pages after it. One copy, so the three pages a reader can
 * move between from the rail's colophon keep the same headings, the
 * same measure and the same links.
 */

/**
 * A word or two of prose that leaves the page.
 *
 * A nested `<Text>` rather than a control: these sit inside sentences,
 * and a pressable wrapped around a phrase would break the line it lives
 * in. react-native-web gives anything with a link role a tab stop of
 * its own, so the keyboard reaches each one and the app's focus ring
 * draws around it.
 */
export function InlineLink({
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
 * held to a hand's width in the middle of the measure. Used once, on
 * About, to close the prose before the appendix — never between every
 * section, where it would stop being an ornament and become a divider.
 */
export function Ornament() {
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

/**
 * A section heading in the reading pages' voice. Second level: the
 * masthead above carries the page's name, and these are its parts. A
 * flat "header" role made the outline one long row of peers with no
 * page title in it.
 */
export function SectionHeading({
  children,
  desktop,
}: {
  children: string;
  desktop: boolean;
}) {
  const colors = useColors();
  return (
    <Text
      {...heading(2)}
      style={[
        desktop ? styles.headingDesktop : styles.heading,
        { color: colors.strongForeground },
      ]}
    >
      {children}
    </Text>
  );
}

export function Section({
  title,
  children,
  desktop,
}: {
  title: string;
  children: React.ReactNode;
  desktop: boolean;
}) {
  return (
    <View style={desktop ? styles.sectionDesktop : styles.section}>
      <SectionHeading desktop={desktop}>{title}</SectionHeading>
      {children}
    </View>
  );
}

export function Para({
  children,
  desktop,
  first,
}: {
  children: React.ReactNode;
  desktop: boolean;
  first?: boolean;
}) {
  const colors = useColors();
  // A reading page is set at the reading page's size — including the
  // step down the smallest phones take, which is decided in one place
  // for every column of prose in the app.
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
 * The way out at the foot of a reading page: the rail's own "Ask
 * Ansari" button, at a size the end of a long column can carry. A
 * filled control rather than a line of type, so the one thing the page
 * asks of the reader at its end reads as something to press.
 */
export function AskAnsariButton({
  onPress,
  testID,
}: {
  onPress: () => void;
  testID: string;
}) {
  const colors = useColors();
  return (
    <PressableScale
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel="Ask Ansari a question"
      testID={testID}
      style={(state) => [
        styles.askButton,
        {
          backgroundColor: withAlpha(
            colors.foreground,
            isHovered(state) ? 0.2 : 0.12,
          ),
          opacity: state.pressed ? 0.7 : 1,
        },
      ]}
    >
      <Feather name="plus" size={17} color={colors.foreground} />
      <Text style={[styles.askButtonText, { color: colors.foreground }]}>
        Ask Ansari a question
      </Text>
    </PressableScale>
  );
}

const styles = StyleSheet.create({
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
  paraGap: {
    marginTop: 15,
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
  inlineLink: {
    textDecorationLine: 'underline',
  },
  askButton: {
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    height: 46,
    paddingHorizontal: 22,
    ...rounded(RADIUS.md),
    cursor: 'pointer',
  },
  askButtonText: {
    fontSize: 15,
    fontFamily: fonts.bodyMedium,
  },
});
