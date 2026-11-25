/**
 * Split a long answer into WhatsApp-sized messages.
 *
 * Python counterpart: `legacy/whatsapp/src/ansari_whatsapp/utils/whatsapp_message_splitter.py`.
 *
 * Lengths are counted in code points, as Python's `len()` does, not in UTF-16 units. A JavaScript string is a sequence
 * of 16-bit units, so an emoji (one code point) has `.length === 2`. Counting units would cut answers short, or in the
 * middle of an emoji. `length()` below is the one place that decides how a length is measured.
 */

/** WhatsApp's character limit per message, as set by the Python service. */
export const WHATSAPP_MAX_MESSAGE_LENGTH = 4000;

/** Length in code points. `[...text]` splits a string into code points; `text.length` counts UTF-16 units. */
function length(text: string): number {
  return [...text].length;
}

/**
 * Split a message that exceeds the limit, trying three strategies in turn:
 * 1. at formatted headers (`*_HEADER_*`);
 * 2. at bold text (`*BOLD*`);
 * 3. at paragraphs, falling back to fixed-size pieces cut at a space.
 *
 * A message within the limit comes back unchanged, as a list of one.
 *
 * Text with nothing but whitespace gives an empty list, and a whitespace-only piece is dropped from a longer message:
 * WhatsApp refuses to send them. Python returned zero pieces for an answer of only newlines, and pieces of only spaces
 * for an answer of only spaces, so the user got silence or an error (owner decision, 2026-11-10). The caller must treat
 * an empty list as "nothing to send" and tell the user, not stay quiet.
 */
export function splitMessage(msgBody: string): string[] {
  return splitMessageUnchecked(msgBody).filter((chunk) => chunk.trim() !== '');
}

function splitMessageUnchecked(msgBody: string): string[] {
  if (length(msgBody) <= WHATSAPP_MAX_MESSAGE_LENGTH) return [msgBody];

  const headerChunks = splitByHeaders(msgBody, WHATSAPP_MAX_MESSAGE_LENGTH);
  if (headerChunks.length > 1) return headerChunks;

  const boldChunks = splitByBoldText(msgBody, WHATSAPP_MAX_MESSAGE_LENGTH);
  if (boldChunks.length > 1) return boldChunks;

  return splitByParagraphs(msgBody, WHATSAPP_MAX_MESSAGE_LENGTH);
}

/** Where each match of `pattern` starts. Positions are UTF-16 offsets, which is fine for slicing the same string. */
function startsOf(pattern: RegExp, text: string): number[] {
  return Array.from(text.matchAll(pattern), (match) => match.index);
}

const HEADER = /\*_[^*_]+_\*/g;

/** Split at formatted headers (`*_HEADER_*`), each header starting a new chunk. */
export function splitByHeaders(text: string, maxLength: number): string[] {
  const starts = startsOf(HEADER, text);
  // One header or none: there is nothing to split on
  if (starts.length <= 1) return [text];

  const chunks: string[] = [];
  for (let i = 0; i < starts.length; i++) {
    const start = starts[i];

    // Text before the first header goes in its own message(s)
    if (i === 0 && start > 0) {
      const prefix = text.slice(0, start);
      if (length(prefix) <= maxLength) chunks.push(prefix);
      else chunks.push(...splitByParagraphs(prefix, maxLength));
    }

    const end = i < starts.length - 1 ? starts[i + 1] : text.length;
    const chunk = text.slice(start, end);
    if (length(chunk) <= maxLength) chunks.push(chunk);
    // A section still too long: try bold text, then paragraphs
    else chunks.push(...splitByBoldText(chunk, maxLength));
  }
  return chunks;
}

const BOLD = /\*[^*]+\*/g;

/** Split at bold text (`*TEXT*`), each bold phrase starting a new chunk. */
export function splitByBoldText(text: string, maxLength: number): string[] {
  if (length(text) <= maxLength) return [text];

  const starts = startsOf(BOLD, text);
  if (starts.length <= 1) return splitByParagraphs(text, maxLength);

  const chunks: string[] = [];
  for (let i = 0; i < starts.length; i++) {
    const start = starts[i];

    if (i === 0 && start > 0) {
      const prefix = text.slice(0, start);
      if (length(prefix) <= maxLength) chunks.push(prefix);
      else chunks.push(...splitByParagraphs(prefix, maxLength));
    }

    const end = i < starts.length - 1 ? starts[i + 1] : text.length;
    const chunk = text.slice(start, end);
    if (length(chunk) <= maxLength) chunks.push(chunk);
    else chunks.push(...splitByParagraphs(chunk, maxLength));
  }
  return chunks;
}

/**
 * Split at blank lines, packing as many paragraphs as fit into each chunk. A single paragraph over the limit is cut
 * into fixed-size pieces. Runs of blank lines count as one separator and come back as exactly one blank line.
 */
export function splitByParagraphs(text: string, maxLength: number): string[] {
  if (length(text) <= maxLength) return [text];

  const paragraphs = text.split(/\n\n+/);
  // No blank lines at all: nothing to split on but size
  if (paragraphs.length <= 1) return splitByFixedChunks(text, maxLength);

  const chunks: string[] = [];
  let current = '';
  // Kept as a running total: Python's `len()` is instant, but counting code points here walks the whole string, and
  // recounting a growing chunk for every paragraph made a very long answer take seconds
  let currentLength = 0;
  for (const paragraph of paragraphs) {
    const paragraphLength = length(paragraph);

    // Adding this paragraph (plus the two newlines that join it) would pass the limit
    if (current && currentLength + paragraphLength + 2 > maxLength) {
      chunks.push(current);
      current = '';
      currentLength = 0;
    }

    if (paragraphLength > maxLength) {
      if (current) {
        chunks.push(current);
        current = '';
        currentLength = 0;
      }
      chunks.push(...splitByFixedChunks(paragraph, maxLength));
    } else if (current) {
      current = `${current}\n\n${paragraph}`;
      currentLength += paragraphLength + 2;
    } else {
      current = paragraph;
      currentLength = paragraphLength;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

/** The position of the last space or newline in `chars[start, end)`, or -1 if there is none. */
function lastWhitespace(chars: string[], start: number, end: number): number {
  for (let i = end - 1; i >= start; i--) {
    if (chars[i] === ' ' || chars[i] === '\n') return i;
  }
  return -1;
}

/**
 * Cut into pieces of at most `maxLength`. Each piece ends after the last space or newline in the second half of its
 * window, so a word, a URL or a `*bold*` pair is not split when it can be avoided.
 *
 * Works on an array of code points, so a cut can never fall inside an emoji.
 */
export function splitByFixedChunks(text: string, maxLength: number): string[] {
  const chars = [...text];
  if (chars.length <= maxLength) return [text];

  const chunks: string[] = [];
  let start = 0;
  while (chars.length - start > maxLength) {
    let end = start + maxLength;
    const cut = lastWhitespace(chars, start, end) + 1;
    if (cut > start + Math.floor(maxLength / 2)) end = cut;
    chunks.push(chars.slice(start, end).join(''));
    start = end;
  }
  chunks.push(chars.slice(start).join(''));
  return chunks;
}
