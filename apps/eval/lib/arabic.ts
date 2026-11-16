/**
 * Arabic text normalization for comparing a quoted Quran passage with its source.
 *
 * The source (Kalimat) is Uthmani script with full marks: `ٱلصَّلَوٰةَ`, `ٱلسَّمَـٰوَٰتِ`.
 * A model may copy it, drop the marks, or retype it in standard spelling: `الصلاة`,
 * `السماوات`. A raw comparison would call all of those misquotes, so the comparison runs
 * on letters only, at three levels. Each level is a pure function of the text; a quote
 * matches a verse at a level when its normalized letters are a contiguous substring of the
 * verse's normalized letters.
 *
 *  - `verbatim`: marks removed, nothing respelled. Passes when the quote carries the same
 *    letters as the source. This is what a copy of the search result gives.
 *  - `standard`: the documented Uthmani-to-standard spelling rules below. Passes for a
 *    correct quote retyped in standard spelling. THIS is the level that decides a pass.
 *  - `skeleton`: `standard` with every plain alef removed. Passes when the only remaining
 *    difference is whether an alef is written. It can hide a real error (قال / قل), so a
 *    quote that matches only here is reported for a human to read, not counted as exact.
 *
 * `standard` rules, applied word by word so no rule can reach across a word boundary
 * (a quote may begin or end anywhere in a verse):
 *  1. Remove vowel marks, tanwin, shadda, sukun, madda, Quranic pause and annotation
 *     signs, tatweel, and everything that is not an Arabic letter.
 *  2. Alef wasla ٱ and alef madda آ are alef. Hamza on any seat (أ إ ؤ ئ, or the hamza
 *     mark on a tatweel) is a bare hamza ء; the seat is not kept, because the two
 *     spellings seat it differently (يَـُٔودُهُ / يؤوده).
 *  3. ى and Farsi ی are ي; ک is ك.
 *  4. Dagger alef (U+0670) is a written alef (ٱلْكِتَـٰبُ → الكتاب), except: on a waw that
 *     carries no vowel of its own the pair is one alef (ٱلصَّلَوٰةَ → الصلاة); on a final ى
 *     it is dropped (عَلَىٰ → علي); on a ى inside a word the pair is one alef
 *     (ٱلتَّوْرَىٰةَ → التوراة).
 *  5. Small waw ۥ is dropped. Small ya ۦ is dropped after ه (بِهِۦ) and is ي elsewhere
 *     (يُحْىِۦ → يحيي). Small high ya ۧ is ي; small high noon ۨ is ن.
 *  6. Inside a word, ءا is ا (ءَامَنُوا / آمنوا) and a run of alefs is one alef.
 *  7. The few words standard spelling writes without the alef the dagger stands for, and
 *     the lam words Uthmani writes with one lam, are folded to one form (WORD_FOLDS).
 *
 * Known residue, which lands in `skeleton` or as a mismatch and is listed in the report
 * for a human: open ta for ta marbuta (رحمت / رحمة), a silent letter standard spelling
 * drops (مِا۟ئَةَ / مئة), and a hamza dropped by the writer (باعيننا for بأعيننا).
 */

const FATHA = 0x064e;
const DAMMA = 0x064f;
const KASRA = 0x0650;
const SHADDA = 0x0651;
const SUKUN = 0x0652;
const HAMZA_ABOVE = 0x0654;
const HAMZA_BELOW = 0x0655;
const DAGGER_ALEF = 0x0670;
const SMALL_HIGH_YEH = 0x06e7;
const SMALL_HIGH_NOON = 0x06e8;
const TATWEEL = 0x0640;
const SMALL_WAW = 0x06e5;
const SMALL_YEH = 0x06e6;

const ALEF = 'ا';
const HAMZA = 'ء';
const WAW = 'و';
const YEH = 'ي';
const HEH = 'ه';

/** A combining mark (Unicode category M). Every Arabic vowel and annotation sign is one. */
const MARK = /\p{M}/u;
/** An Arabic-script letter, as opposed to an Arabic digit, mark or punctuation sign. */
const ARABIC_LETTER = /(?=\p{L})\p{Script=Arabic}/u;
const ARABIC_LETTER_G = /(?=\p{L})\p{Script=Arabic}/gu;

export function isArabicLetter(ch: string): boolean {
  return ARABIC_LETTER.test(ch);
}

/** How many Arabic letters a text holds (marks, digits and punctuation not counted). */
export function arabicLetterCount(text: string): number {
  return text.match(ARABIC_LETTER_G)?.length ?? 0;
}

/** Letter-level folds shared by every level. */
function foldLetter(ch: string): string {
  switch (ch) {
    case 'ٱ': // alef wasla
      return ALEF;
    case 'ى': // alef maqsura
    case 'ی': // Farsi yeh
      return YEH;
    case 'ک': // keheh
      return 'ك';
    default:
      return ch;
  }
}

/**
 * `verbatim`: the text's Arabic letters as written, marks removed. NFC first, so a
 * decomposed أ (alef + hamza mark) and a precomposed one compare equal.
 */
export function normalizeVerbatim(text: string): string {
  let out = '';
  for (const ch of text.normalize('NFC')) {
    const cp = ch.codePointAt(0)!;
    if (cp === TATWEEL || cp === SMALL_WAW || cp === SMALL_YEH) continue;
    if (!isArabicLetter(ch)) continue;
    out += foldLetter(ch);
  }
  return out;
}

/** Rule 7. Applied to a single normalized word, so it cannot reach across a boundary. */
const WORD_FOLDS: ReadonlyArray<readonly [string, string]> = [
  ['هاذا', 'هذا'],
  ['هاذه', 'هذه'],
  ['هاذان', 'هذان'],
  ['هاءلاء', 'هءلاء'],
  ['ذالك', 'ذلك'],
  ['لاكن', 'لكن'],
  ['ءولاءك', 'ءولءك'],
  ['الرحمان', 'الرحمن'],
  ['ءلاه', 'ءله'],
  ['الليل', 'اليل'],
  ['اللاتي', 'الاتي'],
  ['اللاءي', 'الاءي'],
];

interface Cluster {
  base: string;
  marks: number[];
}

/** One word (no whitespace) as base characters, each with the marks that follow it. */
function clusters(word: string): Cluster[] {
  const out: Cluster[] = [];
  for (const ch of word.normalize('NFD')) {
    if (MARK.test(ch)) {
      if (out.length > 0) out[out.length - 1].marks.push(ch.codePointAt(0)!);
      continue;
    }
    out.push({ base: ch, marks: [] });
  }
  return out;
}

function hasOwnVowel(marks: number[]): boolean {
  return marks.some((m) => m === FATHA || m === DAMMA || m === KASRA || m === SHADDA || m === SUKUN);
}

function normalizeStandardWord(word: string): string {
  const cs = clusters(word);
  let out = '';
  for (let i = 0; i < cs.length; i++) {
    const { base, marks } = cs[i];
    const cp = base.codePointAt(0)!;
    const hamza = marks.includes(HAMZA_ABOVE) || marks.includes(HAMZA_BELOW);
    const dagger = marks.includes(DAGGER_ALEF);
    const tail =
      (marks.includes(SMALL_HIGH_YEH) ? YEH : '') + (marks.includes(SMALL_HIGH_NOON) ? 'ن' : '');

    if (cp === TATWEEL) {
      // A tatweel only carries what is written above it.
      out += (hamza ? HAMZA : '') + (dagger ? ALEF : '') + tail;
      continue;
    }
    if (cp === SMALL_WAW) continue;
    if (cp === SMALL_YEH) {
      if (!out.endsWith(HEH)) out += YEH;
      continue;
    }
    if (!isArabicLetter(base)) continue;

    const letter = foldLetter(base);
    if (hamza && (letter === ALEF || letter === WAW || letter === YEH)) {
      // Rule 2: the seat is not kept.
      out += HAMZA + (dagger ? ALEF : '') + tail;
      continue;
    }
    if (dagger && letter === WAW && !hasOwnVowel(marks)) {
      out += ALEF + tail; // rule 4: ٱلصَّلَوٰةَ
      continue;
    }
    if (dagger && (base === 'ى' || base === 'ی')) {
      const moreLetters = cs.slice(i + 1).some((c) => isArabicLetter(c.base));
      out += (moreLetters ? ALEF : YEH) + tail; // rule 4: ٱلتَّوْرَىٰةَ / عَلَىٰ
      continue;
    }
    out += letter + (hamza ? HAMZA : '') + (dagger ? ALEF : '') + tail;
  }

  out = out.replace(/ءا/g, ALEF).replace(/ا{2,}/g, ALEF); // rule 6
  for (const [from, to] of WORD_FOLDS) {
    if (out.includes(from)) out = out.split(from).join(to);
  }
  return out;
}

/** The `standard` form of each whitespace-separated word, empty words dropped. */
export function standardWords(text: string): string[] {
  return text
    .split(/\s+/u)
    .map(normalizeStandardWord)
    .filter((w) => w.length > 0);
}

/** `standard`: see the rules at the top of this file. */
export function normalizeStandard(text: string): string {
  return standardWords(text).join('');
}

/** `skeleton`: `standard` with every plain alef removed. */
export function normalizeSkeleton(text: string): string {
  return normalizeStandard(text).split(ALEF).join('');
}

export type MatchLevel = 'verbatim' | 'standard' | 'skeleton';

export interface NormalizedText {
  verbatim: string;
  standard: string;
  skeleton: string;
}

export function normalizeAll(text: string): NormalizedText {
  const standard = normalizeStandard(text);
  return {
    verbatim: normalizeVerbatim(text),
    standard,
    skeleton: standard.split(ALEF).join(''),
  };
}

/**
 * The strictest level at which `quote` is a contiguous part of `source`, or null. A quote
 * with no letters at a level cannot match at that level.
 */
export function matchLevel(quote: NormalizedText, source: NormalizedText): MatchLevel | null {
  if (quote.verbatim && source.verbatim.includes(quote.verbatim)) return 'verbatim';
  if (quote.standard && source.standard.includes(quote.standard)) return 'standard';
  if (quote.skeleton && source.skeleton.includes(quote.skeleton)) return 'skeleton';
  return null;
}

/**
 * The share of `quote`'s 4-letter windows (at `skeleton`) that occur in `source`. Used
 * only to name the verse a failed quote was probably attempting; never to pass one.
 */
export function overlap(quote: NormalizedText, source: NormalizedText): number {
  const q = quote.skeleton;
  const s = source.skeleton;
  if (q.length < 4) return 0;
  let hit = 0;
  const total = q.length - 3;
  for (let i = 0; i < total; i++) {
    if (s.includes(q.slice(i, i + 4))) hit++;
  }
  return hit / total;
}

/**
 * Where a quote departs from its source, word by word at `standard`: `extra` is the
 * quote's words that are not in the source in order; `missing` is the source's words the
 * quote should have had in their place (the words it skipped between its matched words,
 * and as many source words before its first and after its last matched word as it has
 * unmatched words there). For the report; a human reads it.
 */
export function wordDiff(quoteText: string, sourceText: string): { extra: string[]; missing: string[] } {
  const q = standardWords(quoteText);
  const s = standardWords(sourceText);
  // Longest common subsequence over words.
  const lcs: number[][] = Array.from({ length: q.length + 1 }, () => new Array<number>(s.length + 1).fill(0));
  for (let i = q.length - 1; i >= 0; i--) {
    for (let j = s.length - 1; j >= 0; j--) {
      lcs[i][j] = q[i] === s[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const matchedQuote: number[] = [];
  const matchedSource: number[] = [];
  let i = 0;
  let j = 0;
  while (i < q.length && j < s.length) {
    if (q[i] === s[j]) {
      matchedQuote.push(i++);
      matchedSource.push(j++);
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      i++;
    } else {
      j++;
    }
  }
  const inQuote = new Set(matchedQuote);
  const extra = q.filter((_, k) => !inQuote.has(k));
  if (matchedSource.length === 0) return { extra, missing: [] };

  const inSource = new Set(matchedSource);
  const first = matchedSource[0];
  const last = matchedSource[matchedSource.length - 1];
  const leading = matchedQuote[0];
  const trailing = q.length - 1 - matchedQuote[matchedQuote.length - 1];
  const missing: string[] = [];
  for (let k = Math.max(0, first - leading); k <= Math.min(s.length - 1, last + trailing); k++) {
    if (!inSource.has(k)) missing.push(s[k]);
  }
  return { extra, missing };
}
