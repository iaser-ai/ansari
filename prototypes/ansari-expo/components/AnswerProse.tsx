import React, { useMemo } from 'react';
import {
  Platform,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
  type TextStyle,
} from 'react-native';
import { useColors } from '@/hooks/useColors';
import { useDesktop } from '@/hooks/useDesktop';
import { fonts } from '@/constants/colors';
import { answerLeading, answerSize } from '@/constants/layout';
import { withAlpha } from '@/lib/color';
import { openExternalLink } from '@/lib/link';
import { heading } from '@/lib/semantics';
import { answerDirection, isMostlyArabic, splitArabicRuns } from '@/lib/script';
import {
  parseAnswer,
  type Block,
  type ColumnAlign,
  type Emphasis,
  type Span,
  type TableCell,
} from '@/lib/markdown';
import { CitationChip } from '@/components/CitationChip';
import type { Citation } from '@/lib/api';
import { RADIUS, rounded } from '@/constants/radius';

/**
 * An answer's Markdown, set in the answer's own voice.
 *
 * The page this draws on already has a typography — Literata Light at a
 * book size with generous leading, unboxed on the paper, superscript
 * source markers inline. Every construct here is an extension of that
 * setting rather than a renderer's default:
 *
 *  - Headings are the same serif one weight up and a modest step
 *    larger, in the emphasis ink. A `#` in an answer is a section of
 *    prose, not a page title, so h1 lands nearer h2 than a web heading
 *    scale would put it, and the space above a heading is much larger
 *    than the space below it — a heading belongs to what follows.
 *  - Lists hang: the marker sits in its own right-aligned column and
 *    wrapped lines align under the *text*, as they do in print. Bullets
 *    are set in a lighter ink than the words, so the column reads as
 *    furniture rather than content.
 *  - A quotation is set the way a printed one is: indented behind a
 *    thin vertical rule, in the same face and size, with air above and
 *    below. No italics and no quotation marks — the indent is the
 *    signal.
 *  - Scripture is the exception, because it is what the answer stands
 *    on. A line written wholly in Arabic (a `passage`) is set the way
 *    the source folio sets it: Amiri, larger, with the open leading its
 *    marks need. The quotation holding it becomes a box in the folio's
 *    brass, with the verse and its upright translation centred as one
 *    unit and any reference written after the verse set beneath them as
 *    an attribution (`renderScripture`). The parser gives an unquoted
 *    verse a quotation of its own, so a verse looks the same however the
 *    answer wrote it. Shorter Arabic inside an English sentence is set
 *    in Amiri too, a step up so its letters stand level with Literata's.
 *  - Code, the one thing on this page that is not prose, gets the one
 *    non-serif: a quiet monospaced run, tinted rather than boxed
 *    inline, and a soft slab for a fenced block.
 *  - A thematic break is a short centred rule, distinct from the
 *    left-aligned hairline that opens the footnote block below.
 *  - A table is set the way a printed one is: rule-led rather than
 *    boxed, with a rule under the head, hairlines between rows, no
 *    vertical rules and no fill. Where a grid will not fit — three or
 *    more columns of prose in a phone's measure — each row is set
 *    instead as its own small two-column record, which is the same
 *    hanging-indent language the lists already use.
 *
 * Paragraph rhythm is untouched from before Markdown existed here: the
 * same size, leading and 15pt gap, so an answer with no formatting in
 * it renders exactly as it always did.
 *
 * Direction: every block's base direction is set from the answer's
 * (`answerDirection`) and never left to the platform. Left alone, a
 * block takes its direction from its first letter — on the web too,
 * where react-native-web gives a root <Text> `dir="auto"` — so a
 * translation sharing a block with the Arabic it translates was set
 * right-to-left. Arabic inside a left-to-right block still reads
 * right-to-left within the line; that much the bidi algorithm does on
 * its own once the block's direction is fixed.
 *
 * Text selection: `user-select` inherits on the web and a selectable
 * <Text> carries down to its children on native, so `selectable` on
 * each block's root <Text> carries down through emphasis, links and
 * markers, and a reader can drag a selection across the whole answer.
 * Whether it is on is the caller's decision, not this file's: a
 * selectable <Text> on a phone takes the long press for the platform's
 * own magnifier, so an answer that offers a hold menu has to be able to
 * hand selection over rather than always having it on.
 */
export function AnswerProse({
  content,
  byMarker,
  onCitationPress,
  selectable = Platform.OS === 'web',
}: {
  content: string;
  byMarker: Map<number, Citation>;
  onCitationPress: (citation: Citation) => void;
  selectable?: boolean;
}) {
  const colors = useColors();
  const desktop = useDesktop();
  const { width } = useWindowDimensions();
  const direction = useMemo(() => answerDirection(content), [content]);
  const blocks = useMemo(
    () => parseAnswer(content, { lift: direction === 'ltr' }),
    [content, direction],
  );

  const ctx: Ctx = {
    colors,
    desktop,
    width,
    byMarker,
    onCitationPress,
    selectable,
    direction,
    script: direction === 'ltr' ? 'prose' : 'none',
    centered: false,
  };

  return <>{renderBlocks(blocks, ctx, 0)}</>;
}

// ---------------------------------------------------------------------------

interface Ctx {
  colors: ReturnType<typeof useColors>;
  desktop: boolean;
  /** The window's width — what the phone's type scale is chosen against. */
  width: number;
  byMarker: Map<number, Citation>;
  onCitationPress: (citation: Citation) => void;
  selectable: boolean;
  /** The answer's own direction, which every block is pinned to. */
  direction: Direction;
  /**
   * How Arabic runs inside text are set: `prose` sets them in Amiri a
   * step up, `passage` sets them in Amiri at the passage's own size
   * (holding the face under emphasis, which would otherwise swap in
   * Literata), and `none` leaves the text alone — an answer written in
   * Arabic or Urdu is not scripture line by line, and Urdu is not set
   * in a Naskh.
   */
  script: 'prose' | 'passage' | 'none';
  /** Inside a scripture box, where the verse and its translation are centred as one. */
  centered: boolean;
}

type Direction = 'ltr' | 'rtl';

/**
 * What pins a root <Text> to a base direction, per platform.
 *
 * The web takes the `dir` attribute (react-native-web otherwise writes
 * `dir="auto"`), iOS takes `writingDirection`, and Android takes
 * neither, so there the block opens with an invisible directional mark,
 * which its first-strong-character rule then reads. Copy and Share use
 * the message's own text, so the mark never leaves the screen.
 */
function pinDirection(direction: Direction): {
  props: object;
  style: TextStyle | null;
  mark: string | null;
} {
  return {
    props: Platform.OS === 'web' ? { dir: direction } : {},
    style: Platform.OS === 'ios' ? { writingDirection: direction } : null,
    mark:
      Platform.OS === 'android'
        ? direction === 'ltr'
          ? '\u200E'
          : '\u200F'
        : null,
  };
}

/**
 * Amiri's letters run small beside Literata's at the same nominal size,
 * so Arabic inside an English sentence is set this much larger to stand
 * level with the words around it.
 */
const ARABIC_INLINE_SCALE = 1.15;

/** A passage is set this much above the prose, as the folio sets its Arabic. */
const PASSAGE_SCALE = 1.35;

/**
 * The em size an answer's body copy is set at, and its leading.
 *
 * Both come from the shared layout scale rather than from a pair of
 * numbers kept here: the thread's held placeholder lines have to stand
 * at exactly the leading the real answer will arrive at, and the phone's
 * setting is chosen against the phone's measure — which that same
 * module sets.
 */
function bodySize(desktop: boolean, width: number) {
  return answerSize(desktop, width);
}

/**
 * Headings step above body copy by ratio, not by a fixed table, so the
 * phone and desktop settings stay in proportion to each other. The
 * steps are small on purpose: h1 is a quarter larger than the prose,
 * where a web scale would make it double.
 */
const HEADING_SCALE = [1.26, 1.15, 1.06, 1, 1, 1] as const;

/** Faces for each combination of stress, at each of the two prose weights. */
function faceFor(
  emphasis: Emphasis | null,
  strong: boolean,
): string | undefined {
  switch (emphasis) {
    case 'bold':
      return fonts.proseSemiBold;
    case 'italic':
      // Inside a heading the italic has to hold the heading's weight,
      // or an emphasised word inside it reads as a lighter mistake.
      return strong ? fonts.proseSemiBoldItalic : fonts.proseItalic;
    case 'boldItalic':
      return fonts.proseSemiBoldItalic;
    default:
      return undefined;
  }
}

/** Bold inside italic (and the reverse) is bold-italic, not the last one wins. */
function combine(current: Emphasis | null, next: Emphasis): Emphasis {
  if (next === 'boldItalic' || current === 'boldItalic') return 'boldItalic';
  if (current && current !== next) return 'boldItalic';
  return next;
}

// ---------------------------------------------------------------------------
// Inline
// ---------------------------------------------------------------------------

function renderSpans(
  spans: Span[],
  ctx: Ctx,
  size: number,
  emphasis: Emphasis | null,
  strong: boolean,
): React.ReactNode[] {
  return spans.map((span, i) => {
    switch (span.type) {
      case 'text': {
        const runs =
          ctx.script === 'none' ? [] : splitArabicRuns(span.text);
        if (!runs.some((run) => run.arabic)) {
          return <Text key={i}>{span.text}</Text>;
        }
        return (
          <Text key={i}>
            {runs.map((run, ri) =>
              run.arabic ? (
                <Text
                  key={ri}
                  style={[
                    styles.arabicRun,
                    ctx.script === 'prose' && {
                      fontSize: size * ARABIC_INLINE_SCALE,
                    },
                  ]}
                >
                  {run.text}
                </Text>
              ) : (
                run.text
              ),
            )}
          </Text>
        );
      }

      case 'emphasis': {
        const next = combine(emphasis, span.style);
        return (
          <Text key={i} style={{ fontFamily: faceFor(next, strong) }}>
            {renderSpans(span.spans, ctx, size, next, strong)}
          </Text>
        );
      }

      case 'code':
        return (
          <Text
            key={i}
            style={[
              styles.inlineCode,
              {
                fontSize: size * 0.86,
                // Inline padding is ignored on native, so the breathing
                // room around a tinted run comes from thin spaces.
                backgroundColor: withAlpha(ctx.colors.heroInk, 0.22),
                color: ctx.colors.foreground,
              },
            ]}
          >
            {`\u2009${span.text}\u2009`}
          </Text>
        );

      case 'link': {
        const href = span.href;
        const inner = renderSpans(span.spans, ctx, size, emphasis, strong);
        if (!href) {
          // A destination the parser refused. The label stays as prose
          // rather than disappearing or leaving a bare URL behind.
          return <Text key={i}>{inner}</Text>;
        }
        return (
          <Text
            key={i}
            onPress={() => void openExternalLink(href)}
            // A nested <Text> has no hit slop of its own; keeping the
            // press alive as the thumb drifts is what makes a link in
            // the middle of a line comfortable to tap.
            pressRetentionOffset={{ top: 14, bottom: 14, left: 10, right: 10 }}
            suppressHighlighting
            accessibilityRole="link"
            accessibilityHint="Opens in your browser"
            style={[styles.link, { color: ctx.colors.link }]}
          >
            {inner}
          </Text>
        );
      }

      case 'footnote': {
        const citation = ctx.byMarker.get(span.marker);
        if (!citation) return <Text key={i}>{span.raw}</Text>;
        return (
          <CitationChip
            key={i}
            citation={citation}
            onPress={ctx.onCitationPress}
          />
        );
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

/** A run of sibling blocks, each knowing whether it opens the run and what it follows. */
function renderBlocks(blocks: Block[], ctx: Ctx, depth: number) {
  return blocks.map((block, i) =>
    renderBlock(block, i, i === 0, ctx, depth, blocks[i - 1]),
  );
}

function renderBlock(
  block: Block,
  key: React.Key,
  first: boolean,
  ctx: Ctx,
  depth: number,
  previous?: Block,
): React.ReactNode {
  const { colors, desktop } = ctx;
  const size = bodySize(desktop, ctx.width);
  const leading = answerLeading(desktop, ctx.width);
  const pinned = pinDirection(ctx.direction);
  const rtl = ctx.direction === 'rtl';

  switch (block.type) {
    case 'paragraph':
      return (
        <Text
          key={key}
          selectable={ctx.selectable}
          {...pinned.props}
          style={[
            styles.paragraph,
            { fontSize: size, lineHeight: leading, color: colors.foreground },
            pinned.style,
            ctx.centered && styles.centered,
            !first &&
              (previous?.type === 'passage'
                ? styles.translationSpacing
                : styles.blockSpacing),
          ]}
        >
          {pinned.mark}
          {renderSpans(block.spans, ctx, size, null, false)}
        </Text>
      );

    case 'passage': {
      const passageSize = Math.round(size * PASSAGE_SCALE * 2) / 2;
      const rtlPin = pinDirection('rtl');
      return (
        <Text
          key={key}
          selectable={ctx.selectable}
          {...rtlPin.props}
          style={[
            styles.passage,
            {
              fontSize: passageSize,
              lineHeight: Math.round(passageSize * 1.9),
              color: colors.strongForeground,
              marginTop: first ? 0 : 12,
            },
            rtlPin.style,
          ]}
        >
          {rtlPin.mark}
          {renderSpans(
            block.spans,
            { ...ctx, script: 'passage' },
            passageSize,
            null,
            false,
          )}
        </Text>
      );
    }

    case 'heading': {
      const scale = HEADING_SCALE[block.level - 1] ?? 1;
      const headingSize = Math.round(size * scale * 2) / 2;
      return (
        <Text
          key={key}
          selectable={ctx.selectable}
          // An answer's headings are sections *of* the page, not the
          // page's own title, so they start a level below it: the
          // Markdown's `#` becomes an `<h2>` and everything under it
          // follows. Flat "header" said only that a line was a heading,
          // which is no outline at all — a reader could not tell a
          // section from a sub-point, or skip one to reach the next.
          {...heading(block.level + 1)}
          {...pinned.props}
          style={[
            styles.heading,
            {
              fontSize: headingSize,
              lineHeight: headingSize * 1.38,
              color: colors.strongForeground,
              marginTop: first ? 0 : 26,
            },
            pinned.style,
          ]}
        >
          {pinned.mark}
          {renderSpans(block.spans, ctx, headingSize, null, true)}
        </Text>
      );
    }

    case 'list':
      return (
        <View key={key} style={!first && styles.blockSpacing}>
          {block.items.map((item, i) => (
            <View
              key={i}
              style={[
                styles.listRow,
                rtl && styles.listRowRtl,
                i > 0 && styles.listRowGap,
              ]}
            >
              <Text
                selectable={ctx.selectable}
                {...pinned.props}
                style={[
                  styles.listMarker,
                  rtl && styles.listMarkerRtl,
                  pinned.style,
                  {
                    fontSize: block.ordered ? size * 0.92 : size * 0.9,
                    lineHeight: leading,
                    color: withAlpha(colors.foreground, 0.62),
                    fontFamily: block.ordered ? fonts.proseMedium : fonts.prose,
                  },
                ]}
              >
                {block.ordered
                  ? `${block.start + i}.`
                  : depth > 0
                    ? '\u25E6'
                    : '\u2022'}
              </Text>
              <View style={styles.listContent}>
                {renderBlocks(item.blocks, ctx, depth + 1)}
              </View>
            </View>
          ))}
        </View>
      );

    case 'quote': {
      const passages = block.blocks.filter(
        (child): child is Extract<Block, { type: 'passage' }> =>
          child.type === 'passage',
      );
      if (passages.length > 0) {
        return renderScripture(block.blocks, passages, key, first, ctx, depth);
      }
      const rule = withAlpha(colors.heroInk, 0.9);
      return (
        <View
          key={key}
          style={[
            rtl ? styles.quoteRtl : styles.quote,
            rtl ? { borderRightColor: rule } : { borderLeftColor: rule },
            { marginTop: first ? 0 : 20 },
          ]}
        >
          {renderBlocks(block.blocks, ctx, depth)}
        </View>
      );
    }

    case 'codeBlock': {
      // Code reads left-to-right in an answer of either direction.
      const code = pinDirection('ltr');
      return (
        <View
          key={key}
          style={[
            styles.codeBlock,
            {
              backgroundColor: withAlpha(colors.heroInk, 0.16),
              borderColor: colors.border,
              ...rounded(RADIUS.sm),
              marginTop: first ? 0 : 16,
            },
          ]}
        >
          <Text
            selectable={ctx.selectable}
            {...code.props}
            style={[
              styles.codeBlockText,
              { color: colors.foreground },
              code.style,
            ]}
          >
            {code.mark}
            {block.text}
          </Text>
        </View>
      );
    }

    case 'table':
      return renderTable(block, key, first, ctx);

    case 'rule':
      return (
        <View
          key={key}
          accessibilityRole="none"
          style={[styles.rule, { backgroundColor: colors.border }]}
        />
      );
  }
}

// ---------------------------------------------------------------------------
// Scripture
// ---------------------------------------------------------------------------

/**
 * A quotation that holds scripture, set as a leaf of its own rather
 * than as one more indented quote.
 *
 * It is a box — a faint brass wash inside a brass hairline, at a card's
 * corner — because this is the one thing in an answer that is not the
 * answer's own words, and a rule down one side said only "quoted". The
 * verse and its translation are centred together, so the pair reads as
 * a single unit, the way a verse is set at the head of a chapter. The
 * reference that followed the Arabic is taken off its line and set
 * beneath the pair as the box's attribution, between two short brass
 * rules: the ornament row the folio opens its Arabic with, here closing
 * the passage instead.
 */
function renderScripture(
  blocks: Block[],
  passages: Extract<Block, { type: 'passage' }>[],
  key: React.Key,
  first: boolean,
  ctx: Ctx,
  depth: number,
): React.ReactNode {
  const { colors } = ctx;
  const references = passages.flatMap((p) => (p.reference ? [p.reference] : []));
  return (
    <View
      key={key}
      testID="answer-scripture"
      style={[
        styles.scripture,
        {
          backgroundColor: withAlpha(colors.accent, 0.06),
          borderColor: withAlpha(colors.accent, 0.32),
          ...rounded(RADIUS.lg),
          marginTop: first ? 0 : 20,
        },
      ]}
    >
      {renderBlocks(blocks, { ...ctx, centered: true }, depth)}
      {references.map((reference, i) => {
        const pinned = pinDirection(
          isMostlyArabic(plainText(reference)) ? 'rtl' : 'ltr',
        );
        return (
          <View
            key={`reference-${i}`}
            style={styles.bylineRow}
            testID="answer-scripture-reference"
          >
            <View
              style={[styles.bylineRule, { backgroundColor: colors.accent }]}
            />
            <Text
              selectable={ctx.selectable}
              {...pinned.props}
              style={[
                styles.byline,
                { color: colors.secondaryForeground },
                pinned.style,
              ]}
            >
              {pinned.mark}
              {renderSpans(reference, { ...ctx, script: 'none' }, 13, null, true)}
            </Text>
            <View
              style={[styles.bylineRule, { backgroundColor: colors.accent }]}
            />
          </View>
        );
      })}
    </View>
  );
}

/** The characters a run of spans reads as, for deciding its direction. */
function plainText(spans: Span[]): string {
  return spans
    .map((span) =>
      span.type === 'text' || span.type === 'code'
        ? span.text
        : span.type === 'footnote'
          ? span.raw
          : plainText(span.spans),
    )
    .join('');
}

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

/**
 * A table is reference matter sitting inside reading matter, so it is
 * set a little smaller and a little tighter than the prose around it —
 * the way a table in a book is.
 */
function tableSize(desktop: boolean, width: number) {
  return bodySize(desktop, width) - 1.5;
}

function renderTable(
  block: Extract<Block, { type: 'table' }>,
  key: React.Key,
  first: boolean,
  ctx: Ctx,
): React.ReactNode {
  const { colors, desktop } = ctx;
  const size = tableSize(desktop, ctx.width);
  const pinned = pinDirection(ctx.direction);
  const leading = Math.round(size * 1.5 * 2) / 2;

  // Three or more columns of prose will not survive a phone's measure:
  // each column ends up two or three words wide and the reader is left
  // decoding a grid instead of reading. Two columns fit anywhere.
  const stacked = !desktop && block.head.length > 2;

  const cellText = (
    cell: TableCell,
    align: ColumnAlign,
    strong: boolean,
    muted: boolean,
  ) => (
    <Text
      selectable={ctx.selectable}
      {...pinned.props}
      style={[
        pinned.style,
        styles.tableCellText,
        {
          fontSize: size,
          lineHeight: leading,
          fontFamily: strong ? fonts.proseSemiBold : fonts.prose,
          color: muted
            ? colors.mutedForeground
            : strong
              ? colors.strongForeground
              : colors.foreground,
          ...(align ? { textAlign: align } : null),
        },
      ]}
    >
      {pinned.mark}
      {renderSpans(cell.spans, ctx, size, null, strong)}
    </Text>
  );

  if (stacked) {
    return (
      <View key={key} style={!first && styles.blockSpacing}>
        {block.rows.map((row, ri) => (
          <View
            key={ri}
            style={[
              ri > 0 && styles.tableRecordGap,
              ri > 0 && { borderTopColor: colors.border },
            ]}
          >
            {row.map((cell, ci) => (
              <View key={ci} style={styles.tableField}>
                <View style={styles.tableFieldLabel}>
                  {cellText(block.head[ci] ?? { spans: [] }, null, false, true)}
                </View>
                <View style={styles.tableFieldValue}>
                  {cellText(cell, null, ci === 0, false)}
                </View>
              </View>
            ))}
          </View>
        ))}
      </View>
    );
  }

  const columns = block.head.length;
  const cellStyle = (ci: number) => [
    styles.tableCell,
    ci < columns - 1 && styles.tableCellGap,
  ];

  return (
    <View key={key} style={!first && styles.blockSpacing}>
      <View style={[styles.tableHeadRow, { borderBottomColor: colors.border }]}>
        {block.head.map((cell, ci) => (
          <View key={ci} style={cellStyle(ci)}>
            {cellText(cell, block.align[ci] ?? null, true, false)}
          </View>
        ))}
      </View>
      {block.rows.map((row, ri) => (
        <View
          key={ri}
          style={[
            styles.tableRow,
            { borderBottomColor: withAlpha(colors.border, 0.55) },
          ]}
        >
          {row.map((cell, ci) => (
            <View key={ci} style={cellStyle(ci)}>
              {cellText(cell, block.align[ci] ?? null, false, false)}
            </View>
          ))}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  // Unchanged from the pre-Markdown answer: Literata Light at a book
  // size with open leading, sitting straight on the paper.
  paragraph: {
    fontFamily: fonts.prose,
  },
  blockSpacing: {
    marginTop: 15,
  },
  // A translation belongs to the verse above it, as it does on the
  // folio, so it sits close under it rather than a paragraph away.
  translationSpacing: {
    marginTop: 4,
  },
  // Scripture, in the face the folio sets it in. Amiri's marks reach
  // well above and below the line, hence the open leading.
  passage: {
    fontFamily: fonts.arabic,
    textAlign: 'center',
  },
  centered: {
    textAlign: 'center',
  },
  scripture: {
    borderWidth: StyleSheet.hairlineWidth,
    paddingTop: 16,
    paddingBottom: 18,
    paddingHorizontal: 20,
    marginBottom: 5,
  },
  // The attribution: the folio's label voice — the serif with more ink,
  // tracked out — between two short brass rules.
  bylineRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    marginTop: 14,
  },
  bylineRule: {
    width: 18,
    height: StyleSheet.hairlineWidth,
    opacity: 0.7,
  },
  byline: {
    fontFamily: fonts.displayMedium,
    fontSize: 13,
    letterSpacing: 0.6,
    textAlign: 'center',
    flexShrink: 1,
  },
  arabicRun: {
    fontFamily: fonts.arabic,
  },
  // The space above a heading is what separates two sections; the small
  // space below is what binds the heading to its own paragraph.
  heading: {
    fontFamily: fonts.proseSemiBold,
    marginBottom: 3,
  },
  listRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
  },
  listRowGap: {
    marginTop: 7,
  },
  // The hanging indent: a fixed, right-aligned marker column, so a
  // wrapped line begins under the first word rather than under the
  // bullet, and two-digit numbers stay aligned with single digits.
  listMarker: {
    minWidth: 17,
    marginRight: 9,
    textAlign: 'right',
  },
  // An answer that reads right-to-left hangs its markers on the right.
  listRowRtl: {
    flexDirection: 'row-reverse',
  },
  listMarkerRtl: {
    marginRight: 0,
    marginLeft: 9,
    textAlign: 'left',
  },
  listContent: {
    flex: 1,
  },
  quote: {
    borderLeftWidth: 2,
    paddingLeft: 16,
    marginBottom: 5,
  },
  quoteRtl: {
    borderRightWidth: 2,
    paddingRight: 16,
    marginBottom: 5,
  },
  codeBlock: {
    borderWidth: StyleSheet.hairlineWidth,
    paddingVertical: 11,
    paddingHorizontal: 14,
  },
  codeBlockText: {
    fontFamily: fonts.mono,
    fontSize: 13.5,
    lineHeight: 20,
  } as TextStyle,
  inlineCode: {
    fontFamily: fonts.mono,
  } as TextStyle,
  link: {
    textDecorationLine: 'underline',
    cursor: 'pointer',
  },
  // Rule-led, not boxed: a rule under the head, a hairline between
  // rows, and nothing down the sides. Cells are equal fractions of the
  // measure, which is what keeps prose columns from collapsing.
  tableHeadRow: {
    flexDirection: 'row',
    borderBottomWidth: 1,
    paddingBottom: 6,
  },
  tableRow: {
    flexDirection: 'row',
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingVertical: 7,
  },
  tableCell: {
    flex: 1,
  },
  tableCellGap: {
    paddingRight: 14,
  },
  tableCellText: {
    fontFamily: fonts.prose,
  },
  // The stacked form: one record per row, each field a label hanging to
  // the left of its value, records parted by a hairline.
  tableRecordGap: {
    borderTopWidth: StyleSheet.hairlineWidth,
    marginTop: 12,
    paddingTop: 12,
  },
  tableField: {
    flexDirection: 'row',
    alignItems: 'flex-start',
  },
  tableFieldLabel: {
    flex: 0.72,
    paddingRight: 12,
  },
  tableFieldValue: {
    flex: 1,
  },
  // A break between passages, not a divider: short, centred, and set
  // apart from the left-aligned hairline that opens the footnotes.
  rule: {
    width: 64,
    height: StyleSheet.hairlineWidth,
    alignSelf: 'center',
    marginTop: 26,
    marginBottom: 24,
  },
});
