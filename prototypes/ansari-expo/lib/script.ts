/**
 * Which script a piece of answer text is written in — the one question
 * the answer's typesetting needs answered about Arabic.
 *
 * Two things hang on it. A line of Qur'an or hadith is set apart from
 * the prose around it (`lib/markdown.ts` lifts it into a `passage`), and
 * every other block has its base direction pinned rather than left to
 * the platform's first-strong-character guess, which is what used to
 * turn an English translation right-to-left whenever the Arabic it
 * translates opened the same block.
 *
 * "Arabic" here is the Arabic *script*, so Urdu and Persian count too:
 * the question is how the text runs and which face can set it, not
 * which language it is.
 */

const LETTER = /\p{L}/gu;
const ARABIC_LETTER = /\p{Script=Arabic}/gu;

/** The share of a text's letters that are in Arabic script (0 with no letters). */
function arabicShare(text: string): number {
  const letters = text.match(LETTER)?.length ?? 0;
  if (letters === 0) return 0;
  return (text.match(ARABIC_LETTER)?.length ?? 0) / letters;
}

/** More than half the letters are Arabic script. */
export function isMostlyArabic(text: string): boolean {
  return arabicShare(text) > 0.5;
}

/**
 * The direction a whole answer reads in.
 *
 * An answer written in Arabic or Urdu (the facilitator answers in the
 * reader's language) reads right-to-left throughout. An English answer
 * that quotes a great deal of Arabic stays left-to-right: its
 * translations and explanation outweigh the verses they translate, and
 * the bar sits above an even split so a verse-heavy English answer does
 * not tip over.
 */
export function answerDirection(source: string): 'ltr' | 'rtl' {
  return arabicShare(source) > 0.6 ? 'rtl' : 'ltr';
}

/** `[1]` source markers, which are not words in any script. */
const FOOTNOTE = /\[\d{1,4}\]/g;
/** A Markdown link keeps its label; its destination is not prose. */
const LINK = /\[([^\]]*)\]\([^)]*\)/g;
/**
 * One reference in parentheses at the very end of a line — `(2:255)`,
 * `(Qur'an 23:1)`, `(البقرة: ٢٥٥)` — allowing only punctuation and
 * source markers after it.
 */
const TRAILING_REFERENCE =
  /\s*\(([^()]*)\)(?=[\s.,;:!?،؛]*(?:\[\d{1,4}\][\s.,;:!?،؛]*)*$)/u;

/**
 * A line with its trailing reference taken out, and the reference
 * itself (without its parentheses), or null when it has none. The
 * source markers after a reference stay on the line.
 */
export function splitTrailingReference(line: string): {
  line: string;
  reference: string | null;
} {
  const m = TRAILING_REFERENCE.exec(line);
  const reference = m?.[1]?.trim();
  if (!m || !reference) return { line, reference: null };
  return {
    line: line.slice(0, m.index) + line.slice(m.index + m[0].length),
    reference,
  };
}

/**
 * Is this line a passage of Arabic — a verse, a hadith's words — rather
 * than prose that happens to contain some?
 *
 * The test is strict on purpose: every letter on the line must be Arabic
 * script, ignoring source markers, Markdown punctuation and a single
 * reference in parentheses at the end. So `Allah says: قَدْ أَفْلَحَ…`
 * stays an English sentence. The cost of that strictness is only that a
 * line with a Latin gloss in it is set as prose with its Arabic inline,
 * which still reads correctly; the opposite mistake would set an English
 * lead-in right-to-left, which does not.
 */
export function isArabicPassageLine(line: string): boolean {
  const text = splitTrailingReference(line.replace(LINK, '$1'))
    .line.replace(FOOTNOTE, '');
  const letters = text.match(LETTER)?.length ?? 0;
  const arabic = text.match(ARABIC_LETTER)?.length ?? 0;
  return arabic > 0 && arabic === letters;
}

/**
 * A run of Arabic inside other text: Arabic letters, and the marks,
 * joiners, spaces and Arabic punctuation between them — but never a
 * space at either end, which belongs to the sentence around the run.
 */
const ARABIC_RUN =
  /\p{Script=Arabic}(?:[\p{Script=Arabic}\p{M}‌‍\s]*[\p{Script=Arabic}\p{M}])?/gu;

/** A text split into its Arabic and non-Arabic runs, in order. */
export function splitArabicRuns(
  text: string,
): { text: string; arabic: boolean }[] {
  const out: { text: string; arabic: boolean }[] = [];
  let at = 0;
  for (const m of text.matchAll(ARABIC_RUN)) {
    const start = m.index;
    if (start > at) out.push({ text: text.slice(at, start), arabic: false });
    out.push({ text: m[0], arabic: true });
    at = start + m[0].length;
  }
  if (at < text.length) out.push({ text: text.slice(at), arabic: false });
  return out;
}
