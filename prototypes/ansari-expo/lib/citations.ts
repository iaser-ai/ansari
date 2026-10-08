/**
 * Citation-shaped text with nothing behind it.
 *
 * When an answer has no source documents (no tool ran, the `/documents`
 * request failed, or an apps/api without spec 168), the model has still
 * written its own
 * `[1]` markers and, often, a trailing "Citations:" list. With no sources to
 * open, those read as raw scaffolding: brackets that go nowhere and a list
 * the answer's own footnotes (when there are any) would duplicate. So an
 * answer with no citations attached is shown without them.
 *
 * Display only — the stored content is untouched. The caller decides when it
 * applies: an answer with no real documents (spec 168) and no sample. An
 * answer that HAS documents goes through `lib/document-citations.ts` instead,
 * which keeps each marker it can tie to a real source; the khushu' sample
 * keeps its hand-matched markers.
 */

/**
 * A line that is nothing but a "Citations" heading — plain, bold, or an ATX
 * heading, with or without a colon, any case — and everything after it.
 * Anchored to its own line, so prose that merely mentions "citations:" stays.
 */
export const CITATIONS_SECTION =
  /^[ \t]*(?:#{1,6}[ \t]*)?(?:\*\*|__)?[ \t]*citations[ \t]*:?[ \t]*(?:\*\*|__)?[ \t]*:?[ \t]*$[\s\S]*/im;

/** A bare `[N]` marker, with the space before it, so no gap is left. */
const MARKER = / ?\[\d+\]/g;

export function stripUnbackedCitations(content: string): string {
  const match = CITATIONS_SECTION.exec(content);
  const body =
    match === null ? content : content.slice(0, match.index).trimEnd();
  return stripInlineCitationMetadata(body).replace(MARKER, '');
}

/**
 * A Kalimat hadith id as the model writes it: `LK id 1_77_43_5861`. Real ids
 * carry a `-1` segment for books without sub-chapters (`4_37_-1_4298`), so
 * `-` is part of the token. The literal "LK id" is what makes it specific:
 * prose about hadith numbering never says it.
 */
export const LK_ID = /\bLK id[ \t]*:?[ \t]*([A-Za-z0-9_-]+)/i;

const ID = LK_ID.source.replace('(', '(?:');
const SEP = '[ \\t]*[,;][ \\t]*';

/** `(LK id …)` or `[LK id …, LK id …]` — the whole bracket goes. */
const LK_ID_BRACKETED = new RegExp(
  `[ \\t]*[(\\[][ \\t]*${ID}(?:${SEP}${ID})*[ \\t]*[)\\]]`,
  'gi',
);

/**
 * An id left anywhere else, with the separator that tied it to its
 * neighbours: `(Bukhari, LK id …)` and `(LK id …, Bukhari)` both keep
 * `(Bukhari)`; `Bukhari — LK id …` keeps `Bukhari`.
 */
const LK_ID_LOOSE = new RegExp(
  `[ \\t]*[,;—–][ \\t]*${ID}|(?<=[(\\[])[ \\t]*${ID}${SEP}|[ \\t]*${ID}`,
  'gi',
);

/**
 * Citation metadata the model wrote into the answer itself.
 *
 * The model is meant to cite with `[N]` and put each source's id in the
 * trailing "Citations:" list, which is cut before display. Sometimes it also
 * writes the id into the prose — `"…" (LK id 1_77_43_5861) [1]` — where it is
 * an internal key, meaningless to a reader (issue #251). Every answer goes
 * through this, sources or not: the sources' own pills already say what the
 * id would.
 *
 * Only the LK id: a volume/page reference (`Tafsir, Volume 3, Page 45`) is a
 * human-readable citation, not an internal key, and stays.
 */
export function stripInlineCitationMetadata(body: string): string {
  return body.replace(LK_ID_BRACKETED, '').replace(LK_ID_LOOSE, '');
}

/**
 * The stream's unfinished tail, held back until it is known.
 *
 * Mid-stream, the text can end halfway through a marker (`…nisab [1`), a
 * heading (`**Citat`) or an LK id (`(LK id 1_77`). Neither matches yet, so each would flash on screen for
 * a frame before the next chunk completes it and it is stripped. The tail is
 * withheld instead: a trailing `[`/`[N` with no close, a last line that so
 * far reads as the start of a "Citations" heading, or a trailing `L`/`LK id …`
 * (held off the raw text, so its bracket is held with it). Anything that turns out to
 * be ordinary prose is shown a chunk later. Streaming only — a persisted
 * answer is complete, with no tail to wait on.
 */
const PENDING_MARKER = / ?\[\d*$/;
/** An id still being written: `(LK id 1_77`, `(LK`, or one that may yet close. */
const PENDING_LK_ID =
  /[ \t]*[(\[,;—–]?[ \t]*\bL(?:K(?:[ \t]+(?:i(?:d(?:[ \t]*:?[ \t]*[A-Za-z0-9_-]*)?)?)?)?)?$/i;
const PENDING_HEADING =
  /(^|\n)[ \t]*(?:#{1,6}[ \t]*)?[*_]{0,2}[ \t]*(?:c(?:i(?:t(?:a(?:t(?:i(?:o(?:n(?:s)?)?)?)?)?)?)?)?)?[ \t]*:?[ \t]*[*_]{0,2}[ \t]*:?$/i;

export function stripStreamingCitations(raw: string): string {
  return stripUnbackedCitations(raw.replace(PENDING_LK_ID, ''))
    .replace(PENDING_MARKER, '')
    .replace(PENDING_HEADING, '$1')
    .trimEnd();
}
