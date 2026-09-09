/**
 * Minimal markdown parser for Ansari answers.
 *
 * Ansari emits a small, stable subset of markdown — bold/italic emphasis,
 * headers, lists, blockquotes (often holding Qur'anic Arabic), and the
 * attribution footer link — so this is a purpose-built parser for exactly
 * that subset rather than a general markdown engine. Keeping it dependency
 * free and React Native free means it runs (and is tested) under plain
 * Node, and the renderer keeps full control of RTL and citation handling.
 *
 * Streaming tolerance is a design requirement, not an accident: answers
 * arrive incrementally over SSE, so any prefix of a valid document must
 * parse without throwing and render something reasonable.
 * - An unclosed `**`/`*` at the end of the text emphasises to the end of
 *   the block (it settles, without reflow, when the closer arrives).
 * - An incomplete link (`[label` or `[label](htt`) renders as plain text
 *   until the closing `)` arrives.
 */

export type InlineNode =
  | { type: 'text'; text: string }
  | { type: 'strong'; children: InlineNode[] }
  | { type: 'em'; children: InlineNode[] }
  | { type: 'link'; href: string; children: InlineNode[] };

export type Block =
  | { type: 'paragraph'; children: InlineNode[] }
  | { type: 'heading'; level: number; children: InlineNode[] }
  | { type: 'list'; ordered: boolean; items: InlineNode[][] }
  | { type: 'blockquote'; children: InlineNode[] }
  | { type: 'rule' };

/** `[label](href)` with no closing-bracket or whitespace surprises. */
const LINK_RE = /^\[([^\]\n]*)\]\(([^()\s]+)\)/;

/** First `*` at or after `from` that is not part of a `**` pair. */
function findSingleStar(text: string, from: number): number {
  for (let i = from; i < text.length; i++) {
    if (text[i] !== '*') continue;
    if (text[i + 1] === '*') {
      i += 1; // skip the pair
      continue;
    }
    return i;
  }
  return -1;
}

export function parseInline(text: string): InlineNode[] {
  const nodes: InlineNode[] = [];
  let buf = '';
  const flush = () => {
    if (buf) nodes.push({ type: 'text', text: buf });
    buf = '';
  };

  let i = 0;
  while (i < text.length) {
    const ch = text[i];

    if (ch === '[') {
      const m = LINK_RE.exec(text.slice(i));
      if (m) {
        flush();
        nodes.push({ type: 'link', href: m[2], children: parseInline(m[1]) });
        i += m[0].length;
        continue;
      }
      // Not (yet) a complete link — includes bare [N] citation markers,
      // which the renderer substitutes with chips from the text run.
      buf += ch;
      i += 1;
      continue;
    }

    if (ch === '*') {
      const double = text[i + 1] === '*';
      const start = i + (double ? 2 : 1);
      const end = double
        ? text.indexOf('**', start)
        : findSingleStar(text, start);
      flush();
      const inner = end === -1 ? text.slice(start) : text.slice(start, end);
      if (inner) {
        nodes.push({
          type: double ? 'strong' : 'em',
          children: parseInline(inner),
        });
      }
      i = end === -1 ? text.length : end + (double ? 2 : 1);
      continue;
    }

    buf += ch;
    i += 1;
  }
  flush();
  return nodes;
}

const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const RULE_RE = /^(-{3,}|\*{3,}|_{3,})$/;
const QUOTE_RE = /^>\s?(.*)$/;
const LIST_ITEM_RE = /^(?:([-*•])|(\d{1,3})[.)])\s+(.*)$/;

export function parseMarkdown(src: string): Block[] {
  const blocks: Block[] = [];
  let para: string[] = [];
  let quote: string[] = [];
  let list: { ordered: boolean; items: InlineNode[][] } | null = null;

  const flushPara = () => {
    if (para.length) {
      // Single newlines inside a paragraph stay as line breaks, matching
      // the previous plain-text rendering.
      blocks.push({ type: 'paragraph', children: parseInline(para.join('\n')) });
      para = [];
    }
  };
  const flushQuote = () => {
    if (quote.length) {
      blocks.push({ type: 'blockquote', children: parseInline(quote.join('\n')) });
      quote = [];
    }
  };
  const flushList = () => {
    if (list) {
      blocks.push({ type: 'list', ...list });
      list = null;
    }
  };
  const flushAll = () => {
    flushPara();
    flushQuote();
    flushList();
  };

  for (const rawLine of src.split('\n')) {
    const line = rawLine.trim();
    if (!line) {
      flushAll();
      continue;
    }

    const heading = HEADING_RE.exec(line);
    if (heading) {
      flushAll();
      blocks.push({
        type: 'heading',
        level: heading[1].length,
        children: parseInline(heading[2]),
      });
      continue;
    }

    if (RULE_RE.test(line)) {
      flushAll();
      blocks.push({ type: 'rule' });
      continue;
    }

    const quoted = QUOTE_RE.exec(line);
    if (quoted) {
      flushPara();
      flushList();
      quote.push(quoted[1]);
      continue;
    }

    const item = LIST_ITEM_RE.exec(line);
    if (item) {
      flushPara();
      flushQuote();
      const ordered = item[2] !== undefined;
      if (!list || list.ordered !== ordered) {
        flushList();
        list = { ordered, items: [] };
      }
      list.items.push(parseInline(item[3]));
      continue;
    }

    flushQuote();
    flushList();
    para.push(line);
  }
  flushAll();
  return blocks;
}

/** Plain text of an inline tree (markdown syntax stripped). */
export function inlineText(nodes: InlineNode[]): string {
  return nodes
    .map((n) => (n.type === 'text' ? n.text : inlineText(n.children)))
    .join('');
}

const ARABIC_CHAR =
  /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/;

const LTR_CHAR = /[A-Za-z]/;

/**
 * First-strong-character direction heuristic (as in UAX #9): a block whose
 * first strongly-directional character is Arabic lays out right-to-left.
 */
export function firstStrongIsRtl(text: string): boolean {
  for (const ch of text) {
    if (ARABIC_CHAR.test(ch)) return true;
    if (LTR_CHAR.test(ch)) return false;
  }
  return false;
}

export type ScriptRun = { text: string; arabic: boolean };

/**
 * Splits a text run into maximal same-script runs so the renderer can give
 * Arabic spans their own face (Amiri) and size. Neutral characters
 * (spaces, punctuation, digits, tashkil handled by the Arabic range) stick
 * to the run before them, so boundaries only fall between strong
 * characters of different scripts — bidi ordering itself is left to the
 * platform text engine, which sees the whole paragraph.
 */
export function splitArabicRuns(text: string): ScriptRun[] {
  const runs: ScriptRun[] = [];
  let buf = '';
  let pending = '';
  let arabic: boolean | null = null;

  for (const ch of text) {
    const isArabic = ARABIC_CHAR.test(ch);
    if (!isArabic && !LTR_CHAR.test(ch)) {
      pending += ch;
      continue;
    }
    if (arabic === null || isArabic === arabic) {
      buf += pending + ch;
      pending = '';
      arabic = isArabic;
    } else {
      runs.push({ text: buf + pending, arabic });
      buf = ch;
      pending = '';
      arabic = isArabic;
    }
  }
  if (buf + pending) runs.push({ text: buf + pending, arabic: arabic ?? false });
  return runs;
}
