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
