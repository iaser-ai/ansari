/**
 * Reading the structure of a facilitator answer: the prose, the Citations section and
 * its numbered entries, the `[n]` markers, and the runs of Arabic a quote can live in.
 *
 * The shapes are the ones apps/frontend already parses out of real answers
 * (`lib/citations.ts`, `lib/document-citations.ts`); the heading and entry patterns are
 * copied from there, with the heading widened to the other languages a model may title
 * the section in.
 */
import { findRefs, type RefOccurrence } from './quran-refs';

const HEADING_WORDS = [
  'citations', 'references', 'sources', 'références', 'referencias', 'citas', 'kutipan', 'sitasi',
  'referensi', 'rujukan', 'kaynaklar', 'kaynakça', 'alıntılar', 'المراجع', 'المصادر', 'الاستشهادات',
  'الاقتباسات', 'التوثيق', 'حوالہ جات', 'حوالے',
].join('|');

/** A line that is only the citations heading, however it is decorated. */
const CITATIONS_HEADING = new RegExp(
  `^[ \\t]*(?:#{1,6}[ \\t]*)?(?:\\*\\*|__)?[ \\t]*(?:${HEADING_WORDS})[ \\t]*:?[ \\t]*(?:\\*\\*|__)?[ \\t]*:?[ \\t]*$`,
  'imu',
);

/** A line that opens a numbered entry: `[1] …`, `1. …`, `- **[1]** …`. */
const ENTRY_LINE = /^[ \t]*(?:[-*][ \t]+)?(?:\*\*|__)?(?:\[(\d{1,4})\]|(\d{1,4})[.)])(?:\*\*|__)?[ \t]*(.*)$/;

/** An inline source marker, not a Markdown link label. */
const INLINE_MARKER = /\[(\d{1,4})\](?!\()/g;

export interface CitationEntry {
  number: number;
  /** Offsets of the entry in the whole answer. */
  start: number;
  end: number;
  text: string;
}

export interface ParsedAnswer {
  answer: string;
  /** The prose: everything before the citations heading (the whole answer if none). */
  body: string;
  /** Offset where the citations section starts; `answer.length` when there is none. */
  citationsStart: number;
  entries: CitationEntry[];
}

export function parseAnswer(answer: string): ParsedAnswer {
  const heading = CITATIONS_HEADING.exec(answer);
  if (!heading) return { answer, body: answer, citationsStart: answer.length, entries: [] };

  const citationsStart = heading.index;
  const sectionStart = heading.index + heading[0].length;
  const entries: CitationEntry[] = [];
  let offset = sectionStart;
  let open: CitationEntry | null = null;
  for (const line of answer.slice(sectionStart).split('\n')) {
    const m = ENTRY_LINE.exec(line);
    if (m) {
      if (open) entries.push(open);
      open = { number: Number(m[1] ?? m[2]), start: offset, end: offset + line.length, text: line };
    } else if (open) {
      open.end = offset + line.length;
      open.text += `\n${line}`;
    }
    offset += line.length + 1;
  }
  if (open) entries.push(open);
  return { answer, body: answer.slice(0, citationsStart), citationsStart, entries };
}

// ── Arabic runs ──────────────────────────────────────────────────────────────

/**
 * Arabic letters (tatweel included), not digits or punctuation. The presentation-forms
 * block is split around U+FD3E and U+FD3F: those are the ornate brackets ﴿ ﴾, and a
 * bracket must end a run, or `﴿verse﴾ الآية` reads as one quote with a wrong last word.
 */
const LETTERS =
  '\\u0620-\\u064A\\u066E\\u066F\\u0671-\\u06D3\\u06D5\\u06E5\\u06E6\\u06EE\\u06EF\\u06FA-\\u06FC\\u06FF\\u0750-\\u077F\\u08A0-\\u08B4\\uFB50-\\uFD3D\\uFD40-\\uFDFB\\uFE70-\\uFEFC';
/** Vowel marks and Quranic annotation signs. */
const MARKS = '\\u0610-\\u061A\\u064B-\\u065F\\u0670\\u06D6-\\u06DC\\u06DF-\\u06E4\\u06E7\\u06E8\\u06EA-\\u06ED\\u08D3-\\u08FF';
/** What may sit between the letters of one run: spaces on a line, joiners, ۞ and ۩. */
const INNER = ' \\t\\u00A0\\u200C\\u200D\\u06DE\\u06E9';

/**
 * A run of Arabic: letters and marks with only spaces between them, on one line. Digits
 * (a verse number), punctuation, brackets, Latin text and line breaks all end a run, so a
 * verse is one run and prose splits into clauses. Quran text carries no punctuation.
 */
const ARABIC_RUN = new RegExp(`[${LETTERS}${MARKS}](?:[${LETTERS}${MARKS}${INNER}]*[${LETTERS}${MARKS}])?`, 'g');
const LETTER = new RegExp(`[${LETTERS.replace('\\u0620-\\u064A', '\\u0620-\\u063F\\u0641-\\u064A')}]`, 'g');
const HARAKA = /[ً-ْ]/g;

/** Paired marks a quotation is written between. */
const DELIMITED = [
  /﴿[^﴾\n]{1,3000}﴾/g,
  /«[^»\n]{1,3000}»/g,
  /“[^”\n]{1,3000}”/g,
  /"[^"\n]{1,3000}"/g,
  /\{[^}\n]{1,3000}\}/g,
];

export interface ArabicSegment {
  /** Offsets in the whole answer. */
  start: number;
  end: number;
  text: string;
  words: number;
  letters: number;
  /** Vowel marks per letter. Quoted scripture is usually vowelled; prose is not. */
  vowelDensity: number;
  /** Written between quotation marks or ﴿ ﴾. */
  delimited: boolean;
  /** Where the segment sits. */
  where: 'body' | 'citation';
  /** The citation entry it sits in, when `where` is 'citation'. */
  entry?: number;
}

/** Every run of Arabic in the answer with at least two words. */
export function arabicSegments(parsed: ParsedAnswer): ArabicSegment[] {
  const { answer } = parsed;
  const spans: Array<[number, number]> = [];
  for (const pattern of DELIMITED) {
    for (const m of answer.matchAll(pattern)) spans.push([m.index, m.index + m[0].length]);
  }
  const out: ArabicSegment[] = [];
  for (const m of answer.matchAll(ARABIC_RUN)) {
    const text = m[0];
    const start = m.index;
    const end = start + text.length;
    const words = text.trim().split(/\s+/u).length;
    const letters = text.match(LETTER)?.length ?? 0;
    if (words < 2 || letters < 6) continue;
    const entry = parsed.entries.find((e) => start >= e.start && end <= e.end);
    out.push({
      start,
      end,
      text,
      words,
      letters,
      vowelDensity: (text.match(HARAKA)?.length ?? 0) / letters,
      delimited: spans.some(([s, e]) => start >= s && end <= e),
      where: start >= parsed.citationsStart ? 'citation' : 'body',
      entry: entry?.number,
    });
  }
  return out;
}

// ── Labels ───────────────────────────────────────────────────────────────────

/** How near a label is to the text it is read against, nearest first. */
export type LabelScope = 'line' | 'paragraph' | 'near';

export interface Label extends RefOccurrence {
  /** The reference was written here, or reached through a `[n]` marker written here. */
  via: 'direct' | 'marker';
}

export interface AnswerLabels {
  /** Labels in the prose, by position: written references and `[n]` markers resolved. */
  body: Label[];
  /**
   * The references each citation entry is headed with, by entry number: the ones on its
   * first line (`[1] Quran 2:286`). An entry headed with none is not a Quran entry: a
   * hadith, a tafsir or a fiqh source, whose Arabic is that source's text. A reference
   * further down such an entry (a tafsir saying "when 2:284 was revealed") is not a label.
   */
  byEntry: Map<number, RefOccurrence[]>;
  /** Every distinct reference the answer names, anywhere. */
  all: RefOccurrence[];
}

export function answerLabels(parsed: ParsedAnswer): AnswerLabels {
  const byEntry = new Map<number, RefOccurrence[]>();
  const all: RefOccurrence[] = [];
  for (const entry of parsed.entries) {
    const refs = findRefs(entry.text).map((r) => ({ ...r, start: r.start + entry.start, end: r.end + entry.start }));
    const headerEnd = entry.start + (entry.text.indexOf('\n') === -1 ? entry.text.length : entry.text.indexOf('\n'));
    // The first entry with a number wins, as it does for a reader.
    if (!byEntry.has(entry.number)) byEntry.set(entry.number, refs.filter((r) => r.end <= headerEnd));
    all.push(...refs);
  }

  const body: Label[] = findRefs(parsed.body).map((r) => ({ ...r, via: 'direct' as const }));
  all.push(...body);
  for (const m of parsed.body.matchAll(INLINE_MARKER)) {
    for (const ref of byEntry.get(Number(m[1])) ?? []) {
      body.push({ ...ref, start: m.index, end: m.index + m[0].length, via: 'marker' });
    }
  }
  body.sort((a, b) => a.start - b.start);
  return { body, byEntry, all };
}

function lineBounds(text: string, start: number, end: number): [number, number] {
  const from = text.lastIndexOf('\n', start - 1) + 1;
  const to = text.indexOf('\n', end);
  return [from, to === -1 ? text.length : to];
}

function paragraphBounds(text: string, start: number, end: number): [number, number] {
  const before = text.slice(0, start);
  const blank = /\n[ \t]*\n/g;
  let from = 0;
  for (const m of before.matchAll(blank)) from = m.index + m[0].length;
  const after = /\n[ \t]*\n/.exec(text.slice(end));
  return [from, after ? end + after.index : text.length];
}

/** The end of a sentence: a full stop, question or exclamation mark, any closing marks, then a space. */
const SENTENCE_END = /[.!?؟。]["'»”)\]*_`]*\s/u;

/** How far after / before a segment a label still counts as `near`. */
const NEAR_AFTER = 400;
const NEAR_BEFORE = 200;

/**
 * The labels a segment is read against, nearest scope first: the labels on its own line
 * (those after it, only within its sentence); failing that, in its paragraph; failing
 * that, the closest one shortly after or before.
 * A segment inside a citation entry is read against the references that entry is headed
 * with, and against nothing when it is headed with none.
 */
export function labelsFor(
  segment: ArabicSegment,
  parsed: ParsedAnswer,
  labels: AnswerLabels,
): { scope: LabelScope | null; labels: RefOccurrence[] } {
  if (segment.where === 'citation') {
    const refs = segment.entry === undefined ? [] : (labels.byEntry.get(segment.entry) ?? []);
    return { scope: refs.length > 0 ? 'line' : null, labels: refs };
  }
  const within = ([from, to]: [number, number]) => labels.body.filter((l) => l.start >= from && l.end <= to);

  // A label after the quote labels it only within the same sentence: in
  // `In «quote», the words show no case ending. In 5:69, …` the reference opens the next
  // sentence and is about something else. A label before the quote keeps the whole line
  // (`Quran 68:48. «quote»`).
  const sameSentence = (l: RefOccurrence) => l.start < segment.end || !SENTENCE_END.test(parsed.body.slice(segment.end, l.start));
  const onLine = within(lineBounds(parsed.body, segment.start, segment.end)).filter(sameSentence);
  if (onLine.length > 0) return { scope: 'line', labels: onLine };
  const inParagraph = within(paragraphBounds(parsed.body, segment.start, segment.end));
  if (inParagraph.length > 0) return { scope: 'paragraph', labels: inParagraph };

  const gap = (l: RefOccurrence) => (l.start >= segment.end ? l.start - segment.end : segment.start - l.end);
  const near = labels.body
    .filter((l) => (l.start >= segment.end ? gap(l) <= NEAR_AFTER : l.end <= segment.start && gap(l) <= NEAR_BEFORE))
    .sort((a, b) => gap(a) - gap(b));
  if (near.length === 0) return { scope: null, labels: [] };
  // The closest label, and any others written at the same spot (a marker with two refs).
  return { scope: 'near', labels: near.filter((l) => l.start === near[0].start) };
}

/** The share of a text's letters that are Arabic script (0 when it has no letters). */
export function arabicShare(text: string): number {
  const letters = text.match(/\p{L}/gu)?.length ?? 0;
  if (letters === 0) return 0;
  return (text.match(/(?=\p{L})\p{Script=Arabic}/gu)?.length ?? 0) / letters;
}
