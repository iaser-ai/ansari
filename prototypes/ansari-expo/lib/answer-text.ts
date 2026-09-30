import type { Citation } from '@/lib/api';
import { footnoteLabel } from '@/lib/footnote-groups';

/**
 * An answer as text that travels: what Copy, Share and the hold menu hand
 * on (issue #196).
 *
 * The answer's `[N]` markers stay in its content, so on their own they
 * point at nothing once the answer leaves the app. A short key follows
 * the prose instead — one line per source, in marker order, carrying the
 * full reference (a Qur'an pill drops "Qur'an" under its heading; a line
 * of pasted text has no heading) and a hadith's grade.
 */
export function answerWithSources(content: string, citations: Citation[]): string {
  if (citations.length === 0) return content;
  const lines = [...citations]
    .sort((a, b) => a.marker - b.marker)
    .map((citation) => {
      const { detail } = footnoteLabel(citation);
      return `[${citation.marker}] ${citation.reference}${detail ? ` · ${detail}` : ''}`;
    });
  return `${content.trimEnd()}\n\nSources:\n${lines.join('\n')}`;
}
