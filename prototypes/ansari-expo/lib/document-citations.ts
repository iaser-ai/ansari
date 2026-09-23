import type { Citation } from '@/lib/api/types';
import type { WireDocument } from '@/lib/api/wire-schemas';
import { CITATIONS_SECTION, stripUnbackedCitations } from '@/lib/citations';

/**
 * Real sources behind an answer (issue #161).
 *
 * `apps/api` returns the documents each answer's search tools retrieved as a
 * `documents` key (issue #66): Qur'an verses, hadith, and passages from the
 * tafsir and jurisprudence encyclopedias, in dispatch order. This turns them
 * into the `Citation`s the answer UI already renders.
 *
 * The model, separately, writes its own inline `[N]` markers and a trailing
 * "Citations:" list naming what each number means (the facilitator prompt
 * asks for both). Its numbering is its own — `[2]` is NOT `documents[1]` — so
 * a marker is kept only when its list entry names exactly one document, by
 * the strongest key the entry carries (hadith LK id, Qur'an surah:ayah,
 * encyclopedia volume + page, else the exact title). Any marker that can't be
 * resolved that way is dropped rather than guessed: a superscript that opens
 * the wrong source is worse than none.
 *
 * Every field shown comes from the document itself; nothing is invented.
 */

type SourceKind = 'quran' | 'hadith' | 'tafsir' | 'mawsuah' | 'other';

const TAFSIR_WORK = 'Encyclopedia of Evidence-based Tafsir';
const MAWSUAH_WORK = 'Encyclopedia of Islamic Jurisprudence';

interface ParsedDocument {
  kind: SourceKind;
  doc: WireDocument;
  /** `[surah, ayah]` for a Qur'an verse whose title parses. */
  verse?: [number, number];
  lkId?: string;
  volume?: string;
  page?: string;
  json: Record<string, unknown> | null;
}

function parseJson(data: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(data);
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function str(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim() !== '') return value.trim();
  if (typeof value === 'number') return String(value);
  return undefined;
}

function classify(doc: WireDocument): SourceKind {
  const hint = `${doc.context ?? ''} ${doc.title}`;
  if (/holy quran/i.test(doc.context ?? '') || /^Quran \d/.test(doc.title)) {
    return 'quran';
  }
  if (/hadith/i.test(doc.context ?? '') || /\(LK id [^)]+\)$/.test(doc.title)) {
    return 'hadith';
  }
  if (/tafsir/i.test(hint)) return 'tafsir';
  if (/jurisprudence/i.test(hint)) return 'mawsuah';
  return 'other';
}

const QURAN_TITLE = /^Quran (\d{1,3}):(\d{1,3})$/;
const LK_ID_IN_TITLE = / ?\(LK id ([^)\s]+)\)$/;
const VOLUME = /\bVolume (\d+)/i;
const PAGE = /\bPage (\d+)/i;

function parseDocument(doc: WireDocument): ParsedDocument {
  const kind = classify(doc);
  const json = kind === 'quran' || kind === 'hadith' ? parseJson(doc.source.data) : null;
  const parsed: ParsedDocument = { kind, doc, json };
  if (kind === 'quran') {
    const m = QURAN_TITLE.exec(doc.title);
    if (m) parsed.verse = [Number(m[1]), Number(m[2])];
  }
  if (kind === 'hadith') {
    parsed.lkId = str(json?.lk_id) ?? LK_ID_IN_TITLE.exec(doc.title)?.[1];
  }
  if (kind === 'tafsir' || kind === 'mawsuah') {
    parsed.volume = VOLUME.exec(doc.title)?.[1];
    parsed.page = PAGE.exec(doc.title)?.[1];
  }
  return parsed;
}

/** More than half the letters are Arabic script. */
function isMostlyArabic(text: string): boolean {
  const letters = text.match(/\p{L}/gu)?.length ?? 0;
  const arabic = text.match(/\p{Script=Arabic}/gu)?.length ?? 0;
  return letters > 0 && arabic / letters > 0.5;
}

/** A tafsir/mawsuah passage, with its optional leading `Chapter: …` line. */
function splitChapter(data: string): { chapter?: string; text: string } {
  const m = /^Chapter: ([^\n]*)\n\n([\s\S]*)$/.exec(data);
  return m ? { chapter: m[1]!.trim() || undefined, text: m[2]! } : { text: data };
}

type CitationFields = Omit<Citation, 'id' | 'marker'>;

function rawFallback(doc: WireDocument): CitationFields {
  return {
    sourceType: 'scholarly',
    reference: doc.title,
    sourceTitle: doc.context ?? '',
    translationText: doc.source.data,
  };
}

function toCitationFields(p: ParsedDocument): CitationFields {
  const { doc, json } = p;
  switch (p.kind) {
    case 'quran': {
      if (!json) return { ...rawFallback(doc), sourceType: 'quran' };
      return {
        sourceType: 'quran',
        reference: p.verse ? `Qur'an ${p.verse[0]}:${p.verse[1]}` : doc.title,
        sourceTitle: "The Holy Qur'an",
        arabicText: str(json.ar),
        translationText: str(json.en) ?? '',
        url: p.verse ? `https://quran.com/${p.verse[0]}/${p.verse[1]}` : undefined,
      };
    }
    case 'hadith': {
      if (!json) return { ...rawFallback(doc), sourceType: 'hadith' };
      const collection = str(json.collection);
      const chapter = str(json.chapter);
      const grade = str(json.grade);
      // Title: "<book> - Chapter N: <chapter>, Hadith M (Grade: …) (LK id …)".
      const number = /, Hadith ([^\s(]+)/.exec(doc.title)?.[1];
      const reference =
        collection && number
          ? `${collection} ${number}`
          : doc.title.replace(LK_ID_IN_TITLE, '');
      const detail = [chapter, grade && `Grade: ${grade}`].filter(Boolean);
      return {
        sourceType: 'hadith',
        reference,
        sourceTitle: detail.length > 0 ? detail.join(' · ') : (collection ?? ''),
        arabicText: str(json.ar),
        translationText: str(json.en) ?? '',
      };
    }
    case 'tafsir':
    case 'mawsuah': {
      const work = p.kind === 'tafsir' ? TAFSIR_WORK : MAWSUAH_WORK;
      const { chapter, text } = splitChapter(doc.source.data);
      const arabic = isMostlyArabic(text);
      return {
        sourceType: 'scholarly',
        reference: doc.title,
        sourceTitle: chapter ? `${work} — ${chapter}` : work,
        arabicText: arabic ? text : undefined,
        translationText: arabic ? '' : text,
      };
    }
    default:
      return rawFallback(doc);
  }
}

// --- Resolving the model's markers ------------------------------------------

/** A line that starts a list entry: `[1] …`, `1. …`, `1) …`, bold or bulleted. */
const ENTRY_START =
  /^[ \t]*(?:[-*][ \t]+)?(?:\*\*|__)?(?:\[(\d{1,4})\]|(\d{1,4})[.)])(?:\*\*|__)?[ \t]*(.*)$/;

/** The model's "Citations:" section as `N → entry text` (continuation lines joined). */
function parseCitationEntries(section: string): Map<number, string> {
  const entries = new Map<number, string>();
  let current: number | null = null;
  // The first line is the heading itself.
  for (const line of section.split('\n').slice(1)) {
    const m = ENTRY_START.exec(line);
    if (m) {
      current = Number(m[1] ?? m[2]);
      if (!entries.has(current)) entries.set(current, m[3]!.trim());
      else current = null; // a repeated number: keep the first entry only
    } else if (current !== null && line.trim() !== '') {
      entries.set(current, `${entries.get(current)}\n${line.trim()}`);
    }
  }
  return entries;
}

function normalizeTitle(text: string): string {
  return text
    .toLowerCase()
    .replace(/qur['’`ʼ]?an/g, 'quran')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** `2:255`, and every verse of a `2:255-257` range. */
function versesIn(entry: string): Set<string> {
  const verses = new Set<string>();
  for (const m of entry.matchAll(/\b(\d{1,3}):(\d{1,3})(?:[ \t]*[-–][ \t]*(\d{1,3}))?/g)) {
    const surah = Number(m[1]);
    const first = Number(m[2]);
    const last = m[3] ? Number(m[3]) : first;
    for (let a = first; a <= last && a - first < 300; a++) verses.add(`${surah}:${a}`);
  }
  return verses;
}

/**
 * The index of the one document an entry names, or null. Keys are tried
 * strongest first; the first key the entry carries decides — a match on it
 * that is ambiguous (or empty) is NOT rescued by a weaker key.
 */
function matchEntry(entry: string, docs: ParsedDocument[]): number | null {
  const only = (pred: (p: ParsedDocument) => boolean): number | null => {
    const hits = docs.flatMap((p, i) => (pred(p) ? [i] : []));
    return hits.length === 1 ? hits[0]! : null;
  };

  const lkId = /\bLK id[ \t]*:?[ \t]*([A-Za-z0-9_]+)/i.exec(entry)?.[1];
  if (lkId) return only((p) => p.kind === 'hadith' && p.lkId === lkId);

  if (/qur['’`ʼ]?an|\bsurah?\b/i.test(entry)) {
    const verses = versesIn(entry);
    if (verses.size > 0) {
      return only(
        (p) => p.kind === 'quran' && !!p.verse && verses.has(`${p.verse[0]}:${p.verse[1]}`),
      );
    }
  }

  const volume = VOLUME.exec(entry)?.[1];
  const page = PAGE.exec(entry)?.[1];
  const work: SourceKind | null = /tafsir/i.test(entry)
    ? 'tafsir'
    : /jurisprudence|mawsu/i.test(entry)
      ? 'mawsuah'
      : null;
  if (work && volume && page) {
    return only((p) => p.kind === work && p.volume === volume && p.page === page);
  }

  const heading = normalizeTitle(entry.split('\n')[0]!);
  if (heading === '') return null;
  return only((p) => normalizeTitle(p.doc.title) === heading);
}

/** An inline `[N]` (and the space before it) — not a `[N](url)` link label. */
const INLINE_MARKER = /( ?)\[(\d{1,4})\](?!\()/g;

function numbered(
  entries: Array<{ fields: CitationFields; index: number }>,
  messageId: string,
): Citation[] {
  return entries.map(({ fields, index }, i) => ({
    ...fields,
    id: `${messageId}-doc-${index}`,
    marker: i + 1,
  }));
}

/**
 * An answer's displayed text and citations, given its real documents.
 *
 * - Markers whose "Citations:" entry names exactly one document stay inline,
 *   renumbered 1..k by first appearance; the pills share those numbers.
 * - Unresolved markers are removed individually.
 * - Documents no marker cites follow as pills k+1..n, in document order.
 * - The model's "Citations:" section is always removed — the pills replace it.
 * - If nothing resolves (no section, or none of it matches), every marker is
 *   removed and every document is listed in document order.
 */
export function resolveCitations(
  content: string,
  documents: WireDocument[],
  messageId: string,
): { content: string; citations: Citation[] } {
  const parsed = documents.map(parseDocument);
  const fields = parsed.map(toCitationFields);

  const section = CITATIONS_SECTION.exec(content);
  const resolved = new Map<number, number>(); // model marker → document index
  if (section) {
    for (const [marker, entry] of parseCitationEntries(section[0])) {
      const index = matchEntry(entry, parsed);
      if (index !== null) resolved.set(marker, index);
    }
  }

  if (resolved.size === 0) {
    return {
      content: stripUnbackedCitations(content),
      citations: numbered(
        fields.map((f, index) => ({ fields: f, index })),
        messageId,
      ),
    };
  }

  const body = content.slice(0, section!.index).trimEnd();
  const order: number[] = []; // document indexes, by first inline appearance
  const text = body.replace(INLINE_MARKER, (_match, space: string, n: string) => {
    const index = resolved.get(Number(n));
    if (index === undefined) return '';
    let position = order.indexOf(index);
    if (position === -1) position = order.push(index) - 1;
    return `${space}[${position + 1}]`;
  });

  const uncited = fields.flatMap((_, index) => (order.includes(index) ? [] : [index]));
  return {
    content: text,
    citations: numbered(
      [...order, ...uncited].map((index) => ({ fields: fields[index]!, index })),
      messageId,
    ),
  };
}
