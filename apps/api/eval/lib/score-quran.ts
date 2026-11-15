/**
 * Does every Quran passage an answer quotes match the retrieved text of the verse it is
 * labelled with?
 *
 * The check is code, not judgement. For each run of Arabic in the answer:
 *  1. Find the references it is labelled with (`labelsFor`: same line, then paragraph,
 *     then the closest one nearby; a `[n]` marker counts as its citation entry's refs).
 *  2. Compare its letters with every verse text in hand (`matchLevel`, three levels; see
 *     arabic.ts). The texts in hand are the verses search_quran returned in this turn or
 *     an earlier one, plus a lookup of every reference the answer names that no search
 *     returned, so a quote written from memory is still checked against a source.
 *  3. Decide the outcome (QuoteOutcome).
 *
 * What it cannot see is stated rather than guessed: a quote with no reference near it and
 * no matching verse in hand is `unattributed`, and is counted, not scored.
 */
import { normalizeAll, matchLevel, overlap, wordDiff, type MatchLevel, type NormalizedText } from './arabic';
import { answerLabels, arabicSegments, arabicShare, labelsFor, parseAnswer, type LabelScope } from './answer';
import { formatRef, refVerses, parseRef, type QuranRef } from './quran-refs';
import type { RetrievedHadith } from './sources';

export type VerseOrigin = 'this_turn' | 'earlier_turn' | 'lookup';

export interface PoolVerse {
  key: string;
  ar: string;
  origin: VerseOrigin;
}

/**
 * - `exact`: the quote's letters are in a verse it is labelled with, as written there.
 * - `standard`: the same after the standard-spelling rules. Correct, retyped.
 * - `skeleton`: the same only once alefs are ignored. Probably correct; read it.
 * - `wrong_reference`: the text is a verse in hand, but not one named on its line or in
 *   its paragraph.
 * - `mismatch`: the text is not in any verse in hand, and either it is clearly an attempt
 *   at one of them (half its letter windows are that verse's) or a reference sits on its
 *   own line. The quoted text differs from its source.
 * - `suspect`: four or more words of Arabic with a reference in the paragraph or nearby,
 *   matching nothing. Could be a misquote, could be other Arabic; read it.
 * - `unlabelled`: the text is a verse in hand, with no reference near it.
 * - `unverifiable`: a reference is named but no source text for it could be fetched.
 * - `hadith_text`: the Arabic is from a hadith a search returned. Not Quran.
 * - `term`: under four words next to a reference and matching nothing: a phrase.
 * - `unattributed`: Arabic with no reference near it that matches nothing in hand.
 */
export type QuoteOutcome =
  | 'exact'
  | 'standard'
  | 'skeleton'
  | 'wrong_reference'
  | 'mismatch'
  | 'suspect'
  | 'unlabelled'
  | 'unverifiable'
  | 'hadith_text'
  | 'term'
  | 'unattributed';

export const QUOTE_OUTCOMES: readonly QuoteOutcome[] = [
  'exact', 'standard', 'skeleton', 'wrong_reference', 'mismatch', 'suspect', 'unlabelled',
  'unverifiable', 'hadith_text', 'term', 'unattributed',
];

/** The outcomes that mean the answer quoted Quran text (rightly or wrongly). */
const QURAN_QUOTE: ReadonlySet<QuoteOutcome> = new Set([
  'exact', 'standard', 'skeleton', 'wrong_reference', 'mismatch', 'unlabelled',
]);
/** The outcomes gate G1 counts. */
export const HARD_FAIL: ReadonlySet<QuoteOutcome> = new Set(['wrong_reference', 'mismatch']);

export interface QuoteScore {
  text: string;
  where: 'body' | 'citation';
  words: number;
  outcome: QuoteOutcome;
  /** References it was read against, e.g. ['68:48']. */
  labels: string[];
  labelScope: LabelScope | null;
  /** Verses in hand whose text contains the quote. */
  matched: string[];
  /** For a quote that matched nothing: the verse in hand it most resembles. */
  nearest?: { key: string; overlap: number };
  /** Where it departs from that verse: its own words not there, and the words it skipped. */
  diff?: { against: string; extra: string[]; missing: string[] };
  /**
   * Where the verse it quotes came from: a search in this turn, a search in an earlier
   * turn, or nowhere (`none`: no search ever returned it; the text was written from
   * memory). Null when the quote is not tied to a verse.
   */
  grounding: 'this_turn' | 'earlier_turn' | 'none' | null;
}

export interface ExpectedRefScore {
  ref: string;
  /** The answer names this reference. */
  labelled: boolean;
  /** A quote that passed is tied to it. */
  quoted: boolean;
}

export interface QuranScore {
  quotes: QuoteScore[];
  counts: Record<QuoteOutcome, number>;
  /** Quran quotes (any outcome that is Quran text). */
  quranQuotes: number;
  /** Of those, how many are tied to a verse no search in this turn returned. */
  notFromThisTurn: number;
  /** Of those, how many are tied to a verse no search ever returned. */
  fromMemory: number;
  /** Every verse the answer names. */
  labelled: string[];
  /** Named verses with no source text in hand. */
  unverifiable: string[];
  /** Runs of Arabic left out because the answer itself is in Arabic script and the run is neither quoted nor vowelled. */
  proseRunsSkipped: number;
  expected: ExpectedRefScore[];
}

const BASMALA = normalizeAll('بسم الله الرحمن الرحيم');
/**
 * Arabic an English answer writes that is not a quotation of anything: honorifics and
 * set phrases. A run made only of these is a `term`, whatever its length.
 */
const FORMULAE = [
  'صلى الله عليه وسلم', 'صلى الله عليه وآله وسلم', 'عليه الصلاة والسلام', 'عليه السلام', 'عليهم السلام',
  'عليها السلام', 'رضي الله عنه', 'رضي الله عنها', 'رضي الله عنهما', 'رضي الله عنهم', 'رحمه الله',
  'رحمهم الله', 'سبحانه وتعالى', 'عز وجل', 'جل جلاله', 'تبارك وتعالى', 'إن شاء الله', 'والله أعلم',
  'الله أعلم', 'قال الله تعالى', 'قال تعالى', 'قال رسول الله', 'قال النبي',
]
  .map((f) => normalizeAll(f).standard)
  .sort((a, b) => b.length - a.length);

/** The run's letters once every set phrase is taken out. */
function withoutFormulae(standard: string): string {
  let rest = standard;
  for (const formula of FORMULAE) rest = rest.split(formula).join('');
  return rest;
}
const LEVELS: readonly MatchLevel[] = ['verbatim', 'standard', 'skeleton'];
const OUTCOME_OF: Record<MatchLevel, QuoteOutcome> = { verbatim: 'exact', standard: 'standard', skeleton: 'skeleton' };

/** Fewest letters (at `standard`) a run needs to be compared at all. */
const MIN_LETTERS = 6;
/** Vowel marks per letter above which a run in an Arabic answer is taken as quoted text. */
const VOWELLED = 0.25;
/** Share of a failed quote's letter windows that must be a verse's to call it an attempt at that verse. */
const ATTEMPT_OVERLAP = 0.5;
/** The same, against a retrieved hadith's Arabic, to set a run aside as hadith text. */
const HADITH_OVERLAP = 0.6;
/** A run this short that matches nothing is a phrase, not a quote. */
const TERM_WORDS = 4;

interface Chain {
  keys: string[];
  /** Per level: the verses' letters joined, and where each verse starts and ends in it. */
  text: Record<MatchLevel, string>;
  spans: Record<MatchLevel, Array<[number, number]>>;
}

function splitKey(key: string): [number, number] {
  const [s, a] = key.split(':').map(Number);
  return [s, a];
}

/**
 * Consecutive verses joined, so a quote that runs from one verse into the next is still
 * found. A verse alone is a chain of one.
 */
function buildChains(pool: Map<string, { verse: PoolVerse; norm: NormalizedText }>): Chain[] {
  const keys = [...pool.keys()].sort((x, y) => {
    const [xs, xa] = splitKey(x);
    const [ys, ya] = splitKey(y);
    return xs - ys || xa - ya;
  });
  const groups: string[][] = [];
  for (const key of keys) {
    const last = groups[groups.length - 1];
    const prev = last?.[last.length - 1];
    if (prev) {
      const [ps, pa] = splitKey(prev);
      const [s, a] = splitKey(key);
      if (ps === s && a === pa + 1) {
        last.push(key);
        continue;
      }
    }
    groups.push([key]);
  }
  return groups.map((group) => {
    const chain: Chain = {
      keys: group,
      text: { verbatim: '', standard: '', skeleton: '' },
      spans: { verbatim: [], standard: [], skeleton: [] },
    };
    for (const key of group) {
      const norm = pool.get(key)!.norm;
      for (const level of LEVELS) {
        const start = chain.text[level].length;
        chain.text[level] += norm[level];
        chain.spans[level].push([start, chain.text[level].length]);
      }
    }
    return chain;
  });
}

/** Every verse whose text holds (part of) the quote, at one level. */
function versesContaining(quote: string, chains: Chain[], level: MatchLevel): Set<string> {
  const found = new Set<string>();
  if (!quote) return found;
  for (const chain of chains) {
    const text = chain.text[level];
    for (let at = text.indexOf(quote); at !== -1; at = text.indexOf(quote, at + 1)) {
      const end = at + quote.length;
      chain.spans[level].forEach(([s, e], i) => {
        if (s < end && e > at) found.add(chain.keys[i]);
      });
    }
  }
  return found;
}

function withoutBasmala(norm: NormalizedText): NormalizedText | null {
  const out = { ...norm };
  let stripped = false;
  for (const level of LEVELS) {
    if (norm[level].startsWith(BASMALA[level]) && norm[level].length >= BASMALA[level].length + MIN_LETTERS) {
      out[level] = norm[level].slice(BASMALA[level].length);
      stripped = true;
    }
  }
  return stripped ? out : null;
}

export interface QuranInput {
  answer: string;
  /** Verses search_quran returned in this turn. */
  thisTurn: Array<{ key: string; ar: string }>;
  /** Verses search_quran returned in earlier turns of the conversation. */
  earlierTurns: Array<{ key: string; ar: string }>;
  /** Source text looked up for references the answer names; null when the lookup found nothing. */
  lookups: Record<string, { ar: string } | null>;
  /** Hadith in hand (any turn), to tell hadith Arabic from Quran Arabic. */
  hadith: RetrievedHadith[];
  /** References the question expects the answer to quote, e.g. ['52:48']. */
  expectRefs?: string[];
}

/** The verses in hand, nearest origin winning when a verse came from more than one place. */
export function buildPool(input: Pick<QuranInput, 'thisTurn' | 'earlierTurns' | 'lookups'>): Map<string, PoolVerse> {
  const pool = new Map<string, PoolVerse>();
  const add = (key: string, ar: string, origin: VerseOrigin) => {
    if (!ar || pool.has(key)) return;
    pool.set(key, { key, ar, origin });
  };
  for (const v of input.thisTurn) add(v.key, v.ar, 'this_turn');
  for (const v of input.earlierTurns) add(v.key, v.ar, 'earlier_turn');
  for (const [key, v] of Object.entries(input.lookups)) if (v) add(key, v.ar, 'lookup');
  return pool;
}

/** A range longer than this is read as its first verses only; no answer quotes forty. */
const MAX_RANGE = 40;

function versesOf(ref: QuranRef): string[] {
  return refVerses(ref).slice(0, MAX_RANGE);
}

/**
 * The verses an answer names that are not among `have`: what the runner must look up
 * before the answer can be scored.
 */
export function refsToLookUp(answer: string, have: Iterable<string>): string[] {
  const known = new Set(have);
  const labels = answerLabels(parseAnswer(answer));
  const need = new Set<string>();
  for (const ref of labels.all) {
    for (const key of versesOf(ref)) if (!known.has(key)) need.add(key);
  }
  return [...need];
}

export function scoreQuran(input: QuranInput): QuranScore {
  const parsed = parseAnswer(input.answer);
  const labels = answerLabels(parsed);
  const poolVerses = buildPool(input);
  const pool = new Map([...poolVerses].map(([key, verse]) => [key, { verse, norm: normalizeAll(verse.ar) }]));
  const chains = buildChains(pool);
  const hadithNorm = input.hadith.filter((h) => h.ar).map((h) => normalizeAll(h.ar));
  const arabicAnswer = arabicShare(parsed.body) > 0.6;

  const labelled = new Set<string>();
  for (const ref of labels.all) for (const key of versesOf(ref)) labelled.add(key);
  const unverifiable = [...labelled].filter((key) => !pool.has(key));

  const grounding = (keys: string[]): QuoteScore['grounding'] => {
    const origins = keys.map((k) => pool.get(k)?.verse.origin);
    if (origins.includes('this_turn')) return 'this_turn';
    if (origins.includes('earlier_turn')) return 'earlier_turn';
    return keys.length > 0 ? 'none' : null;
  };

  const quotes: QuoteScore[] = [];
  let proseRunsSkipped = 0;

  for (const segment of arabicSegments(parsed)) {
    // In an answer written in Arabic script the prose is Arabic too. Only a run that is
    // quoted (between marks) or vowelled like scripture is read as a quote.
    if (arabicAnswer && !segment.delimited && !(segment.vowelDensity >= VOWELLED && segment.words >= 3)) {
      proseRunsSkipped++;
      continue;
    }
    const whole = normalizeAll(segment.text);
    if (whole.standard.length < MIN_LETTERS) continue;
    const onlyFormulae = withoutFormulae(whole.standard).length < MIN_LETTERS;

    const scoped = labelsFor(segment, parsed, labels);
    const labelRefs = scoped.labels.map(formatRef).filter((r, i, all) => all.indexOf(r) === i);
    const labelVerses = new Set(scoped.labels.flatMap(versesOf));
    const base = {
      text: segment.text,
      where: segment.where,
      words: segment.words,
      labels: labelRefs,
      labelScope: scoped.scope,
    };

    // A quote may open with the basmala; read it with and without.
    const forms = [whole, withoutBasmala(whole)].filter((f): f is NormalizedText => f !== null);
    const containing = (level: MatchLevel): Set<string> => {
      const found = new Set<string>();
      for (const form of forms) for (const key of versesContaining(form[level], chains, level)) found.add(key);
      return found;
    };
    const byLevel = Object.fromEntries(LEVELS.map((l) => [l, containing(l)])) as Record<MatchLevel, Set<string>>;

    // 1. The text is in a verse it is labelled with.
    const labelledLevel = LEVELS.find((l) => [...byLevel[l]].some((k) => labelVerses.has(k)));
    if (labelledLevel) {
      const matched = [...byLevel[labelledLevel]].filter((k) => labelVerses.has(k));
      quotes.push({ ...base, outcome: OUTCOME_OF[labelledLevel], matched, grounding: grounding(matched) });
      continue;
    }

    const labelsMissingText = [...labelVerses].some((k) => !pool.has(k));

    // 2. The text is a verse in hand, but not a labelled one.
    const anyLevel = LEVELS.find((l) => byLevel[l].size > 0);
    if (anyLevel) {
      const matched = [...byLevel[anyLevel]];
      const named = scoped.scope === 'line' || scoped.scope === 'paragraph';
      const outcome: QuoteOutcome = !named ? 'unlabelled' : labelsMissingText ? 'unverifiable' : 'wrong_reference';
      quotes.push({ ...base, outcome, matched, grounding: grounding(matched) });
      continue;
    }

    // 3. The text is in no verse in hand.
    if (hadithNorm.some((h) => matchLevel(whole, h) !== null || overlap(whole, h) >= HADITH_OVERLAP)) {
      quotes.push({ ...base, outcome: 'hadith_text', matched: [], grounding: null });
      continue;
    }
    let nearest: { key: string; overlap: number } | undefined;
    for (const [key, { norm }] of pool) {
      const share = Math.max(...forms.map((f) => overlap(f, norm)));
      if (!nearest || share > nearest.overlap) nearest = { key, overlap: share };
    }
    const diffAgainst = (key: string) => ({ against: key, ...wordDiff(segment.text, pool.get(key)!.verse.ar) });

    if (nearest && nearest.overlap >= ATTEMPT_OVERLAP) {
      quotes.push({
        ...base,
        outcome: 'mismatch',
        matched: [],
        nearest,
        diff: diffAgainst(nearest.key),
        grounding: grounding([nearest.key]),
      });
      continue;
    }
    if (labelVerses.size === 0) {
      quotes.push({ ...base, outcome: 'unattributed', matched: [], nearest, grounding: null });
      continue;
    }
    if (labelsMissingText) {
      quotes.push({ ...base, outcome: 'unverifiable', matched: [], nearest, grounding: null });
      continue;
    }
    if (segment.words < TERM_WORDS || onlyFormulae) {
      quotes.push({ ...base, outcome: 'term', matched: [], nearest, grounding: null });
      continue;
    }
    const first = [...labelVerses][0];
    quotes.push({
      ...base,
      outcome: scoped.scope === 'line' ? 'mismatch' : 'suspect',
      matched: [],
      nearest,
      diff: diffAgainst(first),
      grounding: grounding([...labelVerses]),
    });
  }

  const counts = Object.fromEntries(QUOTE_OUTCOMES.map((o) => [o, 0])) as Record<QuoteOutcome, number>;
  for (const q of quotes) counts[q.outcome]++;
  const quran = quotes.filter((q) => QURAN_QUOTE.has(q.outcome));

  const passed = quotes.filter((q) => q.outcome === 'exact' || q.outcome === 'standard' || q.outcome === 'skeleton');
  const expected: ExpectedRefScore[] = (input.expectRefs ?? []).map((text) => {
    const ref = parseRef(text);
    if (!ref) throw new Error(`expectRefs: "${text}" is not a Quran reference`);
    const keys = versesOf(ref);
    return {
      ref: text,
      labelled: keys.every((k) => labelled.has(k)),
      quoted: keys.every((k) => passed.some((q) => q.matched.includes(k))),
    };
  });

  return {
    quotes,
    counts,
    quranQuotes: quran.length,
    notFromThisTurn: quran.filter((q) => q.grounding !== 'this_turn').length,
    fromMemory: quran.filter((q) => q.grounding === 'none').length,
    labelled: [...labelled],
    unverifiable,
    proseRunsSkipped,
    expected,
  };
}
