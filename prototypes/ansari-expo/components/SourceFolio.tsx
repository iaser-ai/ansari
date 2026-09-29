import React, { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useColors } from '@/hooks/useColors';
import { fonts } from '@/constants/colors';
import { openExternalLink } from '@/lib/link';
import { PressableScale } from '@/components/PressableScale';
import { toSuperscript } from '@/components/CitationChip';
import type { Citation } from '@/lib/api';

const SOURCE_LABEL: Record<string, string> = {
  quran: "Qur'an",
  hadith: 'Hadith',
  scholarly: 'Scholarly work',
};

/**
 * One source, set as a page from the book it came from — the app's
 * signature surface, the "illuminated folio".
 *
 * It used to be the whole of the citation sheet, which could only ever
 * show the one source a reader had touched. Sources belong to the
 * answer, not to a sentence, so the folio is now a card: the panel and
 * the phone sheet both stack these in marker order, and the card knows
 * nothing about which of the two is holding it.
 *
 * The order is the order of a note at the foot of a printed page: the
 * superior figure and the reference first, the work beneath it, then
 * the Arabic set in Amiri (classical Naskh) under a gold ornament rule,
 * the translation, and finally the way out to the full text.
 *
 * Everything below the reference is optional, because a source is:
 * a hadith often arrives with no Arabic, and a scholarly work with no
 * link. Each part simply does not draw, and what is left still reads as
 * a page rather than as a card with holes in it.
 */
export function SourceFolio({ citation }: { citation: Citation }) {
  const colors = useColors();

  return (
    <View style={styles.folio} testID={`source-folio-${citation.marker}`}>
      <View style={styles.head}>
        {/* One quiet ink for every kind. The label used to split brass
            for hadith and emerald for everything else, which asked
            colour to carry a distinction the word already states — and
            put a second hue in the folio, where the brass is meant to
            be the only one. */}
        <Text style={[styles.kind, { color: colors.mutedForeground }]}>
          {SOURCE_LABEL[citation.sourceType] ?? citation.sourceType}
        </Text>
        <Text style={[styles.reference, { color: colors.strongForeground }]}>
          <Text style={[styles.marker, { color: colors.accent }]}>
            {toSuperscript(citation.marker)}
            {'\u2009'}
          </Text>
          {citation.reference}
        </Text>
        <Text style={[styles.sourceTitle, { color: colors.mutedForeground }]}>
          {citation.sourceTitle}
        </Text>
      </View>

      {citation.arabicText && (
        <>
          <View style={styles.ornamentRow}>
            <View
              style={[styles.ornamentRule, { backgroundColor: colors.accent }]}
            />
            <Text style={[styles.ornament, { color: colors.accent }]}>۝</Text>
            <View
              style={[styles.ornamentRule, { backgroundColor: colors.accent }]}
            />
          </View>
          {/* A passage is the one thing on this page a reader is
              likely to want the words of, and the folio has no hold
              menu of its own competing for the press, so selection is
              simply on — on a phone as well as under a cursor. */}
          <Text
            selectable
            style={[styles.arabic, { color: colors.cardForeground }]}
          >
            {citation.arabicText}
          </Text>
        </>
      )}

      <Text
        selectable
        style={[
          styles.translation,
          { color: colors.cardForeground },
          citation.arabicText ? styles.translationSpacing : null,
        ]}
      >
        {citation.translationText}
      </Text>

      {/* The way out to the book, set as a line of the page rather than
          as a control laid on it. It used to be a filled block in the
          app's darkest ink, which on a stack of folios made the eye
          land on four black bars before it landed on a single word of
          the sources they belong to. A reader who has come this far is
          looking for the source; the link only has to be findable, and
          a rule under a line of type is how a book says "continued
          elsewhere". */}
      {citation.url && <SourceLink citation={citation} />}
    </View>
  );
}

/**
 * The line out to the book. Quiet at rest — muted ink with a brass rule
 * under it — and it takes the page's full ink under the pointer, which
 * is all a link has ever needed to do.
 */
function SourceLink({ citation }: { citation: Citation }) {
  const colors = useColors();
  const [hovered, setHovered] = useState(false);
  const ink = hovered ? colors.strongForeground : colors.mutedForeground;

  return (
    <PressableScale
      onPress={() => void openExternalLink(citation.url!)}
      hitSlop={10}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      style={(state) => [styles.link, { opacity: state.pressed ? 0.55 : 1 }]}
      testID={`source-open-${citation.marker}`}
      accessibilityRole="link"
      accessibilityLabel={`Read the full source for ${citation.reference}`}
    >
      <Text
        style={[
          styles.linkText,
          { color: ink, textDecorationColor: colors.accent },
        ]}
      >
        Read the full source
      </Text>
      <Feather
        name="arrow-up-right"
        size={13}
        color={hovered ? ink : colors.accent}
      />
    </PressableScale>
  );
}

const styles = StyleSheet.create({
  folio: {
    gap: 14,
  },
  head: {
    gap: 2,
  },
  // Every word on this page is the serif an answer is set in — the
  // folio is a leaf out of a book, and a grotesque label at the head of
  // it read as a form field. Only the case and the tracking say
  // "label".
  kind: {
    fontSize: 10.5,
    fontFamily: fonts.displayMedium,
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  reference: {
    fontSize: 19.5,
    fontFamily: fonts.display,
  },
  // The note's own number, kept in the brass the rest of the folio is
  // illuminated in, so a reader can see at a glance which mark in the
  // answer this page answers.
  marker: {
    fontFamily: fonts.displayMedium,
  },
  // The work itself, in the italic a bibliography sets a title in.
  sourceTitle: {
    fontSize: 13.5,
    lineHeight: 19,
    fontFamily: fonts.proseItalic,
  },
  ornamentRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginBottom: -4,
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
  arabic: {
    fontSize: 26,
    lineHeight: 52,
    fontFamily: fonts.arabic,
    textAlign: 'right',
    writingDirection: 'rtl',
  },
  // The translation reads in the answer's own voice, because that is
  // what it is: prose to be read, not a field to be scanned.
  translation: {
    fontSize: 15,
    lineHeight: 25,
    fontFamily: fonts.prose,
  },
  translationSpacing: {
    marginTop: -2,
  },
  link: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: 6,
    paddingVertical: 2,
    cursor: 'pointer',
  },
  linkText: {
    fontSize: 14,
    fontFamily: fonts.proseMedium,
    textDecorationLine: 'underline',
  },
});
