import type { Citation, CitationSourceType } from '@/lib/api';

/**
 * The foot of an answer, grouped by kind of source (issue #194).
 *
 * An answer can cite fifteen sources, and one pill per line made its foot
 * longer than the answer. Grouped under a heading per kind, each pill can
 * drop what the heading already says — `Qur'an`, and a hadith's chapter,
 * which the folio still shows — and short pills can sit side by side.
 */

export interface FootnoteGroup {
  kind: string;
  label: string;
  /** In marker order. */
  citations: Citation[];
}

const GROUPS: Array<{ kind: CitationSourceType; label: string }> = [
  { kind: 'quran', label: "Qur'an" },
  { kind: 'hadith', label: 'Hadith' },
  { kind: 'scholarly', label: 'Scholarly works' },
];

/** Qur'an, then hadith, then scholarly works; any other kind last. Empty groups are left out. */
export function groupFootnotes(citations: Citation[]): FootnoteGroup[] {
  const sorted = [...citations].sort((a, b) => a.marker - b.marker);
  const known = new Set<string>(GROUPS.map((g) => g.kind));
  const groups: FootnoteGroup[] = GROUPS.map(({ kind, label }) => ({
    kind,
    label,
    citations: sorted.filter((c) => c.sourceType === kind),
  }));
  groups.push({
    kind: 'other',
    label: 'Other sources',
    citations: sorted.filter((c) => !known.has(c.sourceType)),
  });
  return groups.filter((g) => g.citations.length > 0);
}

/**
 * What a pill says under its group's heading: the reference, and for a
 * hadith its grade — the first verdict, with a count of the rest.
 */
export function footnoteLabel(citation: Citation): { reference: string; detail?: string } {
  if (citation.sourceType === 'quran') {
    return { reference: citation.reference.replace(/^Qur['’]an\s+/, '') };
  }
  if (citation.sourceType === 'hadith' && citation.grade) {
    const more = citation.grades ? ` (+${citation.grades.length - 1} more)` : '';
    return { reference: citation.reference, detail: `${citation.grade}${more}` };
  }
  return { reference: citation.reference };
}

/** How many rows of pills a group shows before it folds the rest away. */
export const FOOTNOTE_ROWS_SHOWN = 3;

/**
 * Where to fold a group of wrapped pills: the top of the first row past
 * `rows`, and how many pills sit at or below it — or null when every pill
 * fits. `tops` are the pills' measured offsets in the wrapping row; pills
 * on one line share a top (the row aligns them to its start).
 */
export function foldAt(
  tops: number[],
  rows: number = FOOTNOTE_ROWS_SHOWN,
): { top: number; hidden: number } | null {
  // Offsets from layout are fractional on some platforms; a row is the
  // same row to within a point.
  const rowTops = [...new Set(tops.map(Math.round))].sort((a, b) => a - b);
  if (rowTops.length <= rows) return null;
  const top = rowTops[rows]!;
  return { top, hidden: tops.filter((t) => Math.round(t) >= top).length };
}
