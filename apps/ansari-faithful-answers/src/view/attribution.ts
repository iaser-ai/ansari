// Attribution seam. The answer's closing attribution paragraph is supplied text inside the answer
// Markdown ("This information came from ansari.chat." with its link): the app has no separate
// server field for it, and this slice invents none. The card renders it in place, in order, as an
// ordinary paragraph.
//
// The approved footer treatment (rule above, 14px secondary ink, the Ansari mark) is applied by CSS to
// that same paragraph, in place. The only question left to code is whether the card's last block is
// that attribution, so the treatment is not given to an unrelated closing paragraph.
//
// The answer is interpreted exactly once, by the shared card. This module therefore never touches the
// Markdown, a reader or the card's interpreted blocks: it reads the text of the paragraph the card has
// already rendered and sets one attribute. It parses nothing, copies no parser, moves no text and
// walks no tree. A card that failed or is empty renders no such paragraph, so it has no attribution.

/** The attribution Ansari's API appends to every answer. The source identifies its public answer service by either domain. */
const ATTRIBUTION = /^This information came from (?:ansari\.chat|askansari\.ai)\b/i;

/** The card's documented closing seam (docs/faithful-card-styling.md): its final top-level block, when that is a paragraph. */
const CLOSING_PARAGRAPH = '.saga-card-content > p[data-saga-closing="paragraph"]';

/** The attribute the theme keys the footer treatment on. */
export const ATTRIBUTION_ATTRIBUTE = 'data-attribution';

/** True when the text of a closing paragraph is Ansari's attribution. */
export function isAttributionText(text: string): boolean {
  return ATTRIBUTION.test(text.trimStart());
}

/**
 * The card's closing paragraph: the block the card itself marked `data-saga-closing="paragraph"`,
 * which is its final top-level block and only when that block is a paragraph. A quotation, a list
 * item or a table cell is never marked. The marker is structural; whether the marked paragraph is
 * Ansari's attribution is decided here, from its words.
 */
function closingParagraph(card: Element): Element | null {
  return card.querySelector(CLOSING_PARAGRAPH);
}

/** Sets or removes the attribution attribute on `card` from the paragraph the shared card rendered at its end. */
export function markAttribution(card: Element): boolean {
  const paragraph = closingParagraph(card);
  const attribution = paragraph !== null && isAttributionText(paragraph.textContent ?? '');
  if (attribution) card.setAttribute(ATTRIBUTION_ATTRIBUTE, '');
  else card.removeAttribute(ATTRIBUTION_ATTRIBUTE);
  return attribution;
}

/**
 * Keeps `card` marked as the shared card renders into it (an answer is replaced inside the same
 * element). Returns the function that stops watching. Only the attribute on `card` itself is written,
 * which is not observed, so this cannot trigger itself.
 */
export function watchAttribution(card: Element): () => void {
  markAttribution(card);
  const observer = new MutationObserver(() => { markAttribution(card); });
  observer.observe(card, {childList: true, subtree: true, characterData: true});
  return () => observer.disconnect();
}
