/**
 * The Markdown an answer is allowed to speak.
 *
 * This is a parser, not a renderer: it turns an answer's source text
 * into a small block/inline tree and knows nothing about type, colour
 * or React. `components/AnswerProse.tsx` sets that tree in the answer's
 * own voice.
 *
 * Why not a Markdown library? Two reasons, and the second is the hard
 * one:
 *
 *  1. Answers are reading matter, not chat. A general renderer arrives
 *     with its own type scale and would import a second, contradictory
 *     typography into the middle of a page that already has one.
 *
 *  2. Footnote markers are part of the syntax here. An answer writes a
 *     source as `[1]`, which is *also* the opening half of a Markdown
 *     link. The two can only be told apart by resolving links first and
 *     footnotes second, in the same pass — which is exactly what a
 *     library cannot be asked to do. Splitting on `\[\d+\]` before
 *     parsing (what this app used to do) swallows the label of
 *     `[1](https://example.com)` into a citation chip and strands a
 *     bare `(https://example.com)` in the sentence.
 *
 * The supported subset is what answers actually use: ATX headings,
 * ordered and unordered lists (nested), block quotes, fenced and inline
 * code, thematic breaks, pipe tables, emphasis, links, footnote
 * markers, and backslash escapes. Images, raw HTML and reference links
 * are deliberately absent — each is a surface that would have to be
 * styled and maintained for text answers never contain.
 *
 * Everything degrades. Any construct that does not close — a stray
 * asterisk, an unclosed fence, a lone bracket — is emitted as the
 * literal characters the reader typed rather than swallowing the rest
 * of the answer. That is not politeness: an answer is parsed on every
 * frame while it streams in, so for most of its life it *is* malformed.
 */

// ---------------------------------------------------------------------------
// Tree
// ---------------------------------------------------------------------------

/** How a run of text is stressed. Bold and italic compose. */
export type Emphasis = 'bold' | 'italic' | 'boldItalic';

export type Span =
  | { type: 'text'; text: string }
  | { type: 'emphasis'; style: Emphasis; spans: Span[] }
  | { type: 'code'; text: string }
  /** `href` is null when the target was refused (see `safeHref`). */
  | { type: 'link'; href: string | null; spans: Span[] }
  /** A `[1]`-style source marker. `raw` is what to show if it has no citation. */
  | { type: 'footnote'; marker: number; raw: string };

export interface ListItem {
  blocks: Block[];
}

/** A column's alignment, or null when the table did not ask for one. */
export type ColumnAlign = 'left' | 'center' | 'right' | null;

export interface TableCell {
  spans: Span[];
}

export type Block =
  | { type: 'paragraph'; spans: Span[] }
  | { type: 'heading'; level: 1 | 2 | 3 | 4 | 5 | 6; spans: Span[] }
  | { type: 'list'; ordered: boolean; start: number; items: ListItem[] }
  | { type: 'quote'; blocks: Block[] }
  | { type: 'codeBlock'; text: string }
  /** Every row is padded or truncated to the header's width. */
  | {
      type: 'table';
      head: TableCell[];
      rows: TableCell[][];
      align: ColumnAlign[];
    }
  | { type: 'rule' };

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

/**
 * The only destinations an answer may link to.
 *
 * An answer's text is not authored by the reader and, once the real
 * engine is connected, not authored by us either — so a link target is
 * untrusted input. Anything that is not a plain absolute web address is
 * refused: `javascript:`, `data:`, `file:` and friends never reach
 * `Linking.openURL`. Refused links keep their label as ordinary prose,
 * which is also what stops a refused `[1](…)` from reappearing as a
 * stranded parenthetical.
 */
export function safeHref(href: string): string | null {
  const trimmed = href.trim();
  // No control characters or whitespace: both are used to smuggle a
  // scheme past a naive prefix test (`java\nscript:`). Matching control
  // characters is the whole point of this test, so the usual warning about
  // them appearing in a pattern by accident does not apply.
  // eslint-disable-next-line no-control-regex
  if (!trimmed || /[\s\u0000-\u001F\u007F]/.test(trimmed)) return null;
  return /^https?:\/\/[^/?#]/i.test(trimmed) ? trimmed : null;
}

// ---------------------------------------------------------------------------
// Inline
// ---------------------------------------------------------------------------

const ESCAPABLE = new Set('\\`*_{}[]()#+-.!>~|"\'');
const WORD = /[\p{L}\p{N}]/u;
const EMPHASIS_STYLE: Record<number, Emphasis> = {
  1: 'italic',
  2: 'bold',
  3: 'boldItalic',
};

/** The length of the run of `ch` starting at `i`. */
function runLength(src: string, i: number, ch: string): number {
  let n = 0;
  while (src[i + n] === ch) n++;
  return n;
}

/**
 * A backtick code span at `i`: a run of n backticks, closed by the next
 * run of exactly n. Unclosed runs are not code.
 */
function matchCodeSpan(
  src: string,
  i: number,
): { text: string; end: number } | null {
  const n = runLength(src, i, '`');
  let j = i + n;
  while (j < src.length) {
    if (src[j] !== '`') {
      j++;
      continue;
    }
    const len = runLength(src, j, '`');
    if (len === n) {
      let text = src.slice(i + n, j);
      // CommonMark: one space is stripped from each end when both are
      // present, so `` ` `` can be written as `` ` ` ``.
      if (
        text.length > 2 &&
        text.startsWith(' ') &&
        text.endsWith(' ') &&
        text.trim().length > 0
      ) {
        text = text.slice(1, -1);
      }
      return { text, end: j + len };
    }
    j += len;
  }
  return null;
}

/** Scan from `[` at `i` to its matching `]`, honouring nesting, escapes and code. */
function matchBracket(src: string, i: number): number | null {
  let depth = 0;
  let j = i;
  while (j < src.length) {
    const ch = src[j];
    if (ch === '\\') {
      j += 2;
      continue;
    }
    if (ch === '`') {
      const code = matchCodeSpan(src, j);
      j = code ? code.end : j + 1;
      continue;
    }
    if (ch === '[') depth++;
    else if (ch === ']') {
      depth--;
      if (depth === 0) return j;
    }
    j++;
  }
  return null;
}

/** Scan from `(` at `i` to its matching `)`, honouring nesting and escapes. */
function matchParen(src: string, i: number): number | null {
  let depth = 0;
  let j = i;
  while (j < src.length) {
    const ch = src[j];
    if (ch === '\\') {
      j += 2;
      continue;
    }
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return j;
    }
    j++;
  }
  return null;
}

/**
 * `[label](destination "title")` at `i`. Resolved *before* footnote
 * markers, so the `1` in `[1](https://example.com)` stays a label.
 */
function matchLink(
  src: string,
  i: number,
): { label: string; href: string | null; end: number } | null {
  const close = matchBracket(src, i);
  if (close === null || src[close + 1] !== '(') return null;
  const parenEnd = matchParen(src, close + 1);
  if (parenEnd === null) return null;

  let destination = src.slice(close + 2, parenEnd).trim();
  // An optional title after the destination: ("…"), ('…') or (…).
  const title = destination.match(/\s+("[^"]*"|'[^']*'|\([^)]*\))$/);
  if (title) destination = destination.slice(0, -title[0].length).trim();
  // Pointy-bracket destinations.
  if (destination.startsWith('<') && destination.endsWith('>')) {
    destination = destination.slice(1, -1);
  }

  return {
    label: src.slice(i + 1, close),
    href: safeHref(destination),
    end: parenEnd + 1,
  };
}

/** A bare `[12]` source marker at `i`. */
function matchFootnote(
  src: string,
  i: number,
): { marker: number; raw: string; end: number } | null {
  const m = /^\[(\d{1,4})\]/.exec(src.slice(i));
  if (!m) return null;
  return { marker: Number(m[1]), raw: m[0], end: i + m[0].length };
}

/**
 * A `*`/`_` emphasis run at `i`, or null if it never closes.
 *
 * Not CommonMark's delimiter stack — a practical subset: the run may be
 * one, two or three characters, must not be followed by whitespace, and
 * closes at the next run of at least the same length that is not
 * preceded by whitespace. When the closing run is longer than the
 * opening one, the *outer* pair takes the trailing characters, which is
 * what lets `**bold *and italic***` nest correctly.
 *
 * `_` additionally refuses to open or close inside a word, so
 * `snake_case_identifiers` survive intact.
 */
function matchEmphasis(
  src: string,
  i: number,
): { style: Emphasis; inner: string; end: number } | null {
  const ch = src[i]!;
  const open = Math.min(runLength(src, i, ch), 3);
  const after = src[i + open];
  if (after === undefined || /\s/.test(after)) return null;
  if (ch === '_' && i > 0 && WORD.test(src[i - 1]!)) return null;

  let j = i + open;
  while (j < src.length) {
    const c = src[j];
    if (c === '\\') {
      j += 2;
      continue;
    }
    if (c === '`') {
      const code = matchCodeSpan(src, j);
      j = code ? code.end : j + 1;
      continue;
    }
    if (c !== ch) {
      j++;
      continue;
    }
    const len = runLength(src, j, ch);
    const before = src[j - 1];
    const closes =
      len >= open &&
      before !== undefined &&
      !/\s/.test(before) &&
      !(ch === '_' && src[j + len] !== undefined && WORD.test(src[j + len]!));
    if (closes) {
      // Give the surplus of a longer closing run to the inner content,
      // which is where its own opening delimiters are waiting.
      const split = j + (len - open);
      return {
        style: EMPHASIS_STYLE[open]!,
        inner: src.slice(i + open, split),
        end: split + open,
      };
    }
    j += len;
  }
  return null;
}

/** Parse one run of inline text into spans. */
export function parseInline(src: string): Span[] {
  const out: Span[] = [];
  let buffer = '';
  const flush = () => {
    if (buffer) {
      out.push({ type: 'text', text: buffer });
      buffer = '';
    }
  };

  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;

    if (ch === '\\' && ESCAPABLE.has(src[i + 1] ?? '')) {
      buffer += src[i + 1];
      i += 2;
      continue;
    }

    if (ch === '`') {
      const code = matchCodeSpan(src, i);
      if (code) {
        flush();
        out.push({ type: 'code', text: code.text });
        i = code.end;
        continue;
      }
    } else if (ch === '[') {
      // Links first, footnotes second. The whole reason this parser
      // exists rather than a library plus a regex.
      const link = matchLink(src, i);
      if (link) {
        flush();
        out.push({
          type: 'link',
          href: link.href,
          spans: parseInline(link.label),
        });
        i = link.end;
        continue;
      }
      const note = matchFootnote(src, i);
      if (note) {
        flush();
        out.push({ type: 'footnote', marker: note.marker, raw: note.raw });
        i = note.end;
        continue;
      }
    } else if (ch === '*' || ch === '_') {
      const em = matchEmphasis(src, i);
      if (em) {
        flush();
        out.push({
          type: 'emphasis',
          style: em.style,
          spans: parseInline(em.inner),
        });
        i = em.end;
        continue;
      }
    }

    buffer += ch;
    i++;
  }

  flush();
  return out;
}

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

const BLANK = /^[ \t]*$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})[^`]*$/;
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/;
const RULE = /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const QUOTE = /^ {0,3}> ?/;
const LIST = /^([ \t]*)([-+*]|\d{1,9}[.)])([ \t]*)(.*)$/;

function leadingSpaces(line: string): number {
  const m = /^[ \t]*/.exec(line)![0];
  // A tab in a list is worth a small indent; nothing here needs exact
  // tab stops, only a consistent ordering.
  return m.replace(/\t/g, '  ').length;
}

interface Marker {
  indent: number;
  ordered: boolean;
  number: number;
  content: string;
  /** Column the item's own content starts at, used to dedent its body. */
  contentIndent: number;
}

function matchListMarker(line: string): Marker | null {
  const m = LIST.exec(line);
  if (!m) return null;
  const [, rawIndent = '', token = '', gap = '', content = ''] = m;
  // `-word` and `1.word` are prose, not list items.
  if (content !== '' && gap === '') return null;
  const indent = leadingSpaces(rawIndent);
  const ordered = /\d/.test(token[0]!);
  return {
    indent,
    ordered,
    number: ordered ? Number(token.slice(0, -1)) : 0,
    content,
    contentIndent: indent + token.length + Math.max(gap.length, 1),
  };
}

/**
 * Does this line begin a block that interrupts a running paragraph?
 *
 * `next` is needed only for a table, which is the one construct that
 * cannot be recognised from its first line alone.
 */
function interrupts(line: string, next?: string): boolean {
  if (HEADING.test(line) || RULE.test(line) || QUOTE.test(line)) return true;
  if (FENCE.test(line)) return true;
  if (next !== undefined && matchTableHead(line, next)) return true;
  const marker = matchListMarker(line);
  if (!marker || marker.content === '' || marker.indent > 3) return false;
  // A numbered line only interrupts when it starts at 1 — otherwise
  // "…published in 1984. It was a hard year" becomes a list.
  return !marker.ordered || marker.number === 1;
}

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

const DELIMITER_CELL = /^:?-+:?$/;

/**
 * A row's cells, split on unescaped pipes.
 *
 * The outer pipes are optional, and `\|` is the only way to put a pipe
 * inside a cell — including inside a code span, where the pipe would
 * otherwise still end the cell. The escape is left in place so
 * `parseInline` unescapes it along with every other one.
 */
function splitCells(line: string): string[] {
  const src = line.trim();
  let from = 0;
  let to = src.length;
  if (src[from] === '|') from++;
  if (to - 1 > from && src[to - 1] === '|' && src[to - 2] !== '\\') to--;

  const cells: string[] = [];
  let buffer = '';
  for (let i = from; i < to; i++) {
    const ch = src[i]!;
    if (ch === '\\' && ESCAPABLE.has(src[i + 1] ?? '')) {
      buffer += ch + src[i + 1];
      i++;
      continue;
    }
    if (ch === '|') {
      cells.push(buffer.trim());
      buffer = '';
      continue;
    }
    buffer += ch;
  }
  cells.push(buffer.trim());
  return cells;
}

function hasPipe(line: string): boolean {
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '\\') i++;
    else if (line[i] === '|') return true;
  }
  return false;
}

/**
 * The header and its delimiter row, which together are what make a
 * table a table. Until the delimiter row arrives the header is an
 * ordinary paragraph — which is also how a table reads for the frame or
 * two it spends half-streamed.
 */
function matchTableHead(
  header: string,
  delimiter: string,
): { cells: string[]; align: ColumnAlign[] } | null {
  if (!hasPipe(header) || !hasPipe(delimiter)) return null;
  const cells = splitCells(header);
  const spec = splitCells(delimiter);
  if (spec.length !== cells.length) return null;
  if (!spec.every((cell) => DELIMITER_CELL.test(cell))) return null;

  const align = spec.map<ColumnAlign>((cell) => {
    const left = cell.startsWith(':');
    const right = cell.endsWith(':');
    if (left && right) return 'center';
    if (right) return 'right';
    if (left) return 'left';
    return null;
  });
  return { cells, align };
}

function parseTable(
  lines: string[],
  from: number,
): { block: Block; next: number } | null {
  const head = matchTableHead(lines[from] ?? '', lines[from + 1] ?? '');
  if (!head) return null;

  const width = head.cells.length;
  const toCells = (line: string): TableCell[] => {
    const cells = splitCells(line).slice(0, width);
    while (cells.length < width) cells.push('');
    return cells.map((text) => ({ spans: parseInline(text) }));
  };

  const rows: TableCell[][] = [];
  let i = from + 2;
  // A body row has to look like one. Requiring a pipe (rather than
  // treating any line as a single-cell row, as GFM does) keeps a table
  // from eating the paragraph that follows it while an answer streams.
  while (i < lines.length && !BLANK.test(lines[i]!) && hasPipe(lines[i]!)) {
    rows.push(toCells(lines[i]!));
    i++;
  }

  return {
    block: {
      type: 'table',
      head: head.cells.map((text) => ({ spans: parseInline(text) })),
      rows,
      align: head.align,
    },
    next: i,
  };
}

function findFence(lines: string[], start: number, fence: string): number {
  const char = fence[0]!;
  const closing = new RegExp(
    `^ {0,3}${char === '`' ? '`' : '~'}{${fence.length},}[ \t]*$`,
  );
  for (let i = start; i < lines.length; i++) {
    if (closing.test(lines[i]!)) return i;
  }
  return -1;
}

function parseList(
  lines: string[],
  from: number,
): { block: Block; next: number } | null {
  const first = matchListMarker(lines[from]!);
  if (!first || first.indent > 3) return null;

  const groups: string[][] = [];
  let current: string[] | null = null;
  let contentIndent = first.contentIndent;
  let i = from;

  while (i < lines.length) {
    const line = lines[i]!;

    if (BLANK.test(line)) {
      let p = i + 1;
      while (p < lines.length && BLANK.test(lines[p]!)) p++;
      if (p >= lines.length) break;
      const ahead = matchListMarker(lines[p]!);
      const continues =
        (ahead !== null &&
          ahead.indent >= first.indent &&
          ahead.ordered === first.ordered) ||
        leadingSpaces(lines[p]!) >= contentIndent;
      if (!continues) break;
      current?.push('');
      i = p;
      continue;
    }

    const marker = matchListMarker(line);

    // A sibling item: same level, same kind.
    if (marker && marker.indent <= first.indent + 1) {
      if (marker.ordered !== first.ordered) break;
      current = [marker.content];
      groups.push(current);
      contentIndent = marker.contentIndent;
      i++;
      continue;
    }

    if (!current) break;

    // Anything further indented — a nested list, a second paragraph, a
    // wrapped line — belongs to the open item, dedented to its column.
    const indent = leadingSpaces(line);
    current.push(line.slice(Math.min(indent, contentIndent)));
    i++;
  }

  if (groups.length === 0) return null;

  // Trailing blanks inside the last item are the gap after the list.
  const last = groups[groups.length - 1]!;
  while (last.length > 0 && BLANK.test(last[last.length - 1]!)) last.pop();

  return {
    block: {
      type: 'list',
      ordered: first.ordered,
      start: first.ordered ? Math.max(first.number, 0) : 1,
      items: groups.map((group) => ({ blocks: parseBlocks(group) })),
    },
    next: i,
  };
}

function parseBlocks(lines: string[]): Block[] {
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;

    if (BLANK.test(line)) {
      i++;
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence) {
      const close = findFence(lines, i + 1, fence[1]!);
      if (close !== -1) {
        blocks.push({
          type: 'codeBlock',
          text: lines.slice(i + 1, close).join('\n'),
        });
        i = close + 1;
        continue;
      }
      // An unclosed fence must not turn the remainder of a streaming
      // answer into one long code block, so the marker is just text and
      // the lines after it are parsed as prose.
    }

    if (RULE.test(line)) {
      blocks.push({ type: 'rule' });
      i++;
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      // A closing run of hashes is decoration, not content.
      const text = (heading[2] ?? '').replace(/(^|[ \t])#+[ \t]*$/, '').trim();
      blocks.push({
        type: 'heading',
        level: heading[1]!.length as 1 | 2 | 3 | 4 | 5 | 6,
        spans: parseInline(text),
      });
      i++;
      continue;
    }

    if (QUOTE.test(line)) {
      const inner: string[] = [];
      while (i < lines.length && !BLANK.test(lines[i]!)) {
        const l = lines[i]!;
        // Lazy continuation: an unmarked line inside a quote is part of
        // the quoted paragraph.
        if (!QUOTE.test(l) && interrupts(l, lines[i + 1])) break;
        inner.push(l.replace(QUOTE, ''));
        i++;
      }
      blocks.push({ type: 'quote', blocks: parseBlocks(inner) });
      continue;
    }

    const table = parseTable(lines, i);
    if (table) {
      blocks.push(table.block);
      i = table.next;
      continue;
    }

    const list = parseList(lines, i);
    if (list) {
      blocks.push(list.block);
      i = list.next;
      continue;
    }

    // Paragraph: runs to the next blank line or interrupting block.
    // Single newlines are kept as line breaks, which is exactly how
    // answers rendered before this parser existed.
    const paragraph: string[] = [line];
    i++;
    while (
      i < lines.length &&
      !BLANK.test(lines[i]!) &&
      !interrupts(lines[i]!, lines[i + 1])
    ) {
      paragraph.push(lines[i]!);
      i++;
    }
    blocks.push({
      type: 'paragraph',
      spans: parseInline(paragraph.join('\n')),
    });
  }

  return blocks;
}

/** Parse an answer's Markdown source into blocks. */
export function parseAnswer(source: string): Block[] {
  return parseBlocks(source.split(/\r\n|\r|\n/));
}
