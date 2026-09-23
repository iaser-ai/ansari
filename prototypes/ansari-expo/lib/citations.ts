/**
 * Citation-shaped text with nothing behind it.
 *
 * `apps/api` returns no citation data, but the model still writes its own
 * `[1]` markers and, often, a trailing "Citations:" list. With no sources to
 * open, those read as raw scaffolding: brackets that go nowhere and a list
 * the answer's own footnotes (when there are any) would duplicate. So an
 * answer with no citations attached is shown without them.
 *
 * Display only — the stored content is untouched. The caller decides when it
 * applies: an answer that DOES carry citations (the khushu' sample) keeps its
 * markers, since they open real sources.
 */

/**
 * A line that is nothing but a "Citations" heading — plain, bold, or an ATX
 * heading, with or without a colon, any case — and everything after it.
 * Anchored to its own line, so prose that merely mentions "citations:" stays.
 */
const CITATIONS_SECTION =
  /^[ \t]*(?:#{1,6}[ \t]*)?(?:\*\*|__)?[ \t]*citations[ \t]*:?[ \t]*(?:\*\*|__)?[ \t]*:?[ \t]*$[\s\S]*/im;

/** A bare `[N]` marker, with the space before it, so no gap is left. */
const MARKER = / ?\[\d+\]/g;

export function stripUnbackedCitations(content: string): string {
  const match = CITATIONS_SECTION.exec(content);
  const body =
    match === null ? content : content.slice(0, match.index).trimEnd();
  return body.replace(MARKER, '');
}

/**
 * The stream's unfinished tail, held back until it is known.
 *
 * Mid-stream, the text can end halfway through a marker (`…nisab [1`) or a
 * heading (`**Citat`). Neither matches yet, so each would flash on screen for
 * a frame before the next chunk completes it and it is stripped. The tail is
 * withheld instead: a trailing `[`/`[N` with no close, or a last line that so
 * far reads as the start of a "Citations" heading. Anything that turns out to
 * be ordinary prose is shown a chunk later. Streaming only — a persisted
 * answer is complete, with no tail to wait on.
 */
const PENDING_MARKER = / ?\[\d*$/;
const PENDING_HEADING =
  /(^|\n)[ \t]*(?:#{1,6}[ \t]*)?[*_]{0,2}[ \t]*(?:c(?:i(?:t(?:a(?:t(?:i(?:o(?:n(?:s)?)?)?)?)?)?)?)?)?[ \t]*:?[ \t]*[*_]{0,2}[ \t]*:?$/i;

export function stripStreamingCitations(raw: string): string {
  return stripUnbackedCitations(raw)
    .replace(PENDING_MARKER, '')
    .replace(PENDING_HEADING, '$1')
    .trimEnd();
}
