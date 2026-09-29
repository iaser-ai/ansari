/**
 * Syntax matrix for the answer Markdown parser.
 *
 * The parser is deliberately free of React Native imports so it can be
 * exercised directly under Node.
 *
 * The cases that matter most are at the bottom: the collisions between
 * footnote markers and link syntax, and malformed input degrading to
 * plain text.
 */
import { describe, expect, it } from 'vitest';
import {
  parseAnswer,
  parseInline,
  safeHref,
  type Block,
  type Span,
} from './markdown';

/** Flatten a tree back to the characters a reader would see. */
function textOf(nodes: Span[] | Block[]): string {
  return (nodes as Array<Span | Block>)
    .map((node): string => {
      switch (node.type) {
        case 'text':
          return node.text;
        case 'code':
          return node.text;
        case 'footnote':
          return node.raw;
        case 'emphasis':
        case 'link':
          return textOf(node.spans);
        case 'paragraph':
        case 'heading':
          return textOf(node.spans);
        case 'quote':
          return textOf(node.blocks);
        case 'codeBlock':
          return node.text;
        case 'list':
          return node.items.map((item) => textOf(item.blocks)).join('\n');
        case 'table':
          return [node.head, ...node.rows]
            .map((row) => row.map((cell) => textOf(cell.spans)).join(' '))
            .join('\n');
        case 'rule':
          return '';
        default:
          return '';
      }
    })
    .join('');
}

function onlyBlock(source: string): Block {
  const blocks = parseAnswer(source);
  expect(blocks.length, `expected one block, got ${blocks.length}`).toBe(1);
  return blocks[0]!;
}

// ---------------------------------------------------------------------------

describe('plain prose is untouched', () => {
  it('splits on blank lines exactly as the old renderer did', () => {
    const source = 'First paragraph.\n\nSecond paragraph.';
    expect(parseAnswer(source)).toEqual([
      {
        type: 'paragraph',
        spans: [{ type: 'text', text: 'First paragraph.' }],
      },
      {
        type: 'paragraph',
        spans: [{ type: 'text', text: 'Second paragraph.' }],
      },
    ]);
  });

  it('collapses runs of blank lines into one break', () => {
    expect(parseAnswer('One.\n\n\n\nTwo.').length).toBe(2);
  });

  it('keeps a single newline as a line break inside the paragraph', () => {
    expect(parseAnswer('One line\nnext line')).toEqual([
      {
        type: 'paragraph',
        spans: [{ type: 'text', text: 'One line\nnext line' }],
      },
    ]);
  });

  it('leaves curly quotes, em dashes and the honorific alone', () => {
    const source = 'The Prophet ﷺ said — “seek help” — and it was so.';
    expect(textOf(parseAnswer(source))).toBe(source);
  });

  it('does not treat an apostrophe or an underscore inside a word as emphasis', () => {
    const source = "Allah's decree and a snake_case_name.";
    expect(parseInline(source)).toEqual([{ type: 'text', text: source }]);
  });
});

describe('headings', () => {
  it('reads all six levels', () => {
    for (let level = 1; level <= 6; level++) {
      const block = onlyBlock(`${'#'.repeat(level)} Title`);
      expect(block).toEqual({
        type: 'heading',
        level,
        spans: [{ type: 'text', text: 'Title' }],
      });
    }
  });

  it('strips a closing run of hashes', () => {
    expect(onlyBlock('## Title ##')).toEqual({
      type: 'heading',
      level: 2,
      spans: [{ type: 'text', text: 'Title' }],
    });
  });

  it('needs a space after the hashes', () => {
    expect(onlyBlock('#NotAHeading').type).toBe('paragraph');
  });

  it('ignores a seventh hash', () => {
    expect(onlyBlock('####### Too deep').type).toBe('paragraph');
  });

  it('interrupts a paragraph', () => {
    const blocks = parseAnswer('Prose.\n## Heading');
    expect(blocks.map((b) => b.type)).toEqual(['paragraph', 'heading']);
  });
});

describe('emphasis', () => {
  const cases: Array<[string, string, string]> = [
    ['**bold**', 'bold', 'bold'],
    ['__bold__', 'bold', 'bold'],
    ['*italic*', 'italic', 'italic'],
    ['_italic_', 'italic', 'italic'],
    ['***both***', 'boldItalic', 'both'],
    ['___both___', 'boldItalic', 'both'],
  ];
  for (const [source, style, text] of cases) {
    it(`reads ${source} as ${style}`, () => {
      expect(parseInline(source)).toEqual([
        { type: 'emphasis', style, spans: [{ type: 'text', text }] },
      ]);
    });
  }

  it('nests italic inside bold', () => {
    expect(parseInline('**bold *and italic***')).toEqual([
      {
        type: 'emphasis',
        style: 'bold',
        spans: [
          { type: 'text', text: 'bold ' },
          {
            type: 'emphasis',
            style: 'italic',
            spans: [{ type: 'text', text: 'and italic' }],
          },
        ],
      },
    ]);
  });

  it('nests bold inside italic', () => {
    expect(parseInline('*italic **and bold***')).toEqual([
      {
        type: 'emphasis',
        style: 'italic',
        spans: [
          { type: 'text', text: 'italic ' },
          {
            type: 'emphasis',
            style: 'bold',
            spans: [{ type: 'text', text: 'and bold' }],
          },
        ],
      },
    ]);
  });

  it('refuses a delimiter followed by a space', () => {
    expect(parseInline('2 * 3 * 4')).toEqual([
      { type: 'text', text: '2 * 3 * 4' },
    ]);
  });

  it('refuses a closing delimiter preceded by a space', () => {
    expect(parseInline('*open and never *closed')).toEqual([
      { type: 'text', text: '*open and never *closed' },
    ]);
  });
});

describe('lists', () => {
  it('reads a bulleted list', () => {
    const block = onlyBlock('- one\n- two\n- three');
    expect(block.type).toBe('list');
    expect(block.type === 'list' && block.ordered).toBe(false);
    expect(block.type === 'list' ? block.items.length : 0).toBe(3);
    expect(textOf(parseAnswer('- one\n- two\n- three'))).toBe('one\ntwo\nthree');
  });

  it('accepts *, + and - as bullets', () => {
    for (const bullet of ['-', '*', '+']) {
      const block = onlyBlock(`${bullet} item`);
      expect(block.type).toBe('list');
    }
  });

  it('reads a numbered list and keeps its starting number', () => {
    const block = onlyBlock('3. three\n4. four');
    expect(block.type === 'list' && block.ordered).toBe(true);
    expect(block.type === 'list' && block.start).toBe(3);
  });

  it('nests one level', () => {
    const block = onlyBlock('- outer\n  - inner\n- outer again');
    expect(block.type).toBe('list');
    if (block.type !== 'list') return;
    expect(block.items.length).toBe(2);
    const [first] = block.items;
    expect(first!.blocks.map((b) => b.type)).toEqual(['paragraph', 'list']);
  });

  it('wraps a continuation line into the same item', () => {
    const block = onlyBlock('- a line that\n  continues here');
    expect(block.type).toBe('list');
    expect(textOf([block])).toBe('a line that\ncontinues here');
  });

  it('does not make a list out of a hyphenated sentence', () => {
    expect(onlyBlock('-not a list').type).toBe('paragraph');
  });

  it('does not make a list out of a year at the start of a line', () => {
    const blocks = parseAnswer('He wrote it in\n1984. It was a hard year.');
    expect(blocks.map((b) => b.type)).toEqual(['paragraph']);
  });

  it('separates a bulleted list from a numbered one', () => {
    expect(parseAnswer('- bullet\n1. number').map((b) => b.type)).toEqual(['list', 'list']);
  });
});

describe('quotes', () => {
  it('reads a block quote', () => {
    const block = onlyBlock('> quoted words');
    expect(block).toEqual({
      type: 'quote',
      blocks: [
        { type: 'paragraph', spans: [{ type: 'text', text: 'quoted words' }] },
      ],
    });
  });

  it('joins consecutive quote lines into one quotation', () => {
    const block = onlyBlock('> first\n> second');
    expect(block.type).toBe('quote');
    expect(textOf([block])).toBe('first\nsecond');
  });

  it('takes a lazy continuation line', () => {
    const block = onlyBlock('> first\nstill quoted');
    expect(textOf([block])).toBe('first\nstill quoted');
  });

  it('ends at a blank line', () => {
    expect(parseAnswer('> quoted\n\nnot quoted').map((b) => b.type)).toEqual(['quote', 'paragraph']);
  });
});

describe('code', () => {
  it('reads a fenced block and keeps its text verbatim', () => {
    expect(onlyBlock('```\nconst a = **1**;\n```')).toEqual({
      type: 'codeBlock',
      text: 'const a = **1**;',
    });
  });

  it('accepts an info string and tilde fences', () => {
    expect(onlyBlock('~~~ts\nlet a;\n~~~')).toEqual({
      type: 'codeBlock',
      text: 'let a;',
    });
  });

  it('reads an inline code span', () => {
    expect(parseInline('use `npm run dev` now')).toEqual([
      { type: 'text', text: 'use ' },
      { type: 'code', text: 'npm run dev' },
      { type: 'text', text: ' now' },
    ]);
  });

  it('does not read Markdown inside code', () => {
    expect(parseInline('`**not bold**`')).toEqual([
      { type: 'code', text: '**not bold**' },
    ]);
  });
});

describe('thematic breaks', () => {
  for (const source of ['---', '***', '___', '- - -', '* * *']) {
    it(`reads ${source} as a rule`, () => {
      expect(onlyBlock(source)).toEqual({ type: 'rule' });
    });
  }

  it('does not mistake bold-italic for a rule', () => {
    expect(onlyBlock('***emphasised***').type).toBe('paragraph');
  });
});

describe('links', () => {
  it('reads a link and keeps its label', () => {
    expect(parseInline('see [Quran.com](https://quran.com) today')).toEqual([
      { type: 'text', text: 'see ' },
      {
        type: 'link',
        href: 'https://quran.com',
        spans: [{ type: 'text', text: 'Quran.com' }],
      },
      { type: 'text', text: ' today' },
    ]);
  });

  it('drops an optional title', () => {
    expect(parseInline('[a](https://x.com "Title")')).toEqual([
      {
        type: 'link',
        href: 'https://x.com',
        spans: [{ type: 'text', text: 'a' }],
      },
    ]);
  });

  it('accepts a pointy-bracket destination', () => {
    expect(parseInline('[a](<https://x.com/path>)')).toEqual([
      {
        type: 'link',
        href: 'https://x.com/path',
        spans: [{ type: 'text', text: 'a' }],
      },
    ]);
  });

  it('refuses a destination containing whitespace', () => {
    // A space in a URL is either a typo or an attempt to smuggle a
    // scheme past the check; a link is not worth guessing at.
    expect(safeHref('https://x.com/a b')).toBe(null);
  });

  it('parses emphasis inside a label', () => {
    expect(parseInline('[**bold link**](https://x.com)')).toEqual([
      {
        type: 'link',
        href: 'https://x.com',
        spans: [
          {
            type: 'emphasis',
            style: 'bold',
            spans: [{ type: 'text', text: 'bold link' }],
          },
        ],
      },
    ]);
  });

  describe('destinations that are refused', () => {
    for (const bad of [
      'javascript:alert(1)',
      'JavaScript:alert(1)',
      'data:text/html,<script>',
      'file:///etc/passwd',
      'mailto:a@b.com',
      '/relative/path',
      'https://',
      'java\tscript:alert(1)',
    ]) {
      it(`refuses ${bad}`, () => {
        expect(safeHref(bad)).toBe(null);
      });
    }

    it('keeps the label as prose and never strands the parenthetical', () => {
      const spans = parseInline('a [bad](javascript:alert(1)) link');
      expect(spans).toEqual([
        { type: 'text', text: 'a ' },
        { type: 'link', href: null, spans: [{ type: 'text', text: 'bad' }] },
        { type: 'text', text: ' link' },
      ]);
      expect(textOf(spans)).toBe('a bad link');
    });
  });

  it('accepts http and https', () => {
    expect(safeHref('http://example.com')).toBe('http://example.com');
    expect(safeHref(' https://example.com/a?b=1#c ')).toBe('https://example.com/a?b=1#c');
  });
});

describe('footnote markers', () => {
  it('reads a bare marker', () => {
    expect(parseInline('as narrated [2] by')).toEqual([
      { type: 'text', text: 'as narrated ' },
      { type: 'footnote', marker: 2, raw: '[2]' },
      { type: 'text', text: ' by' },
    ]);
  });

  it('reads a marker inside emphasis', () => {
    expect(parseInline('**bold with [3] inside**')).toEqual([
      {
        type: 'emphasis',
        style: 'bold',
        spans: [
          { type: 'text', text: 'bold with ' },
          { type: 'footnote', marker: 3, raw: '[3]' },
          { type: 'text', text: ' inside' },
        ],
      },
    ]);
  });

  it('reads a marker inside a heading', () => {
    expect(onlyBlock('## Patience [1]')).toEqual({
      type: 'heading',
      level: 2,
      spans: [
        { type: 'text', text: 'Patience ' },
        { type: 'footnote', marker: 1, raw: '[1]' },
      ],
    });
  });

  it('reads a marker inside a list item', () => {
    const block = onlyBlock('- a point [4] made');
    expect(block.type).toBe('list');
    if (block.type !== 'list') return;
    expect(block.items[0]!.blocks).toEqual([
      {
        type: 'paragraph',
        spans: [
          { type: 'text', text: 'a point ' },
          { type: 'footnote', marker: 4, raw: '[4]' },
          { type: 'text', text: ' made' },
        ],
      },
    ]);
  });

  it('keeps two adjacent markers apart', () => {
    expect(parseInline('[1][2]')).toEqual([
      { type: 'footnote', marker: 1, raw: '[1]' },
      { type: 'footnote', marker: 2, raw: '[2]' },
    ]);
  });

  it('is not confused by a marker beside a link', () => {
    expect(parseInline('[1] and [here](https://x.com)')).toEqual([
      { type: 'footnote', marker: 1, raw: '[1]' },
      { type: 'text', text: ' and ' },
      {
        type: 'link',
        href: 'https://x.com',
        spans: [{ type: 'text', text: 'here' }],
      },
    ]);
  });
});

describe('the collision this parser exists for', () => {
  it('reads [1](https://example.com) as a link, not marker 1', () => {
    expect(parseInline('[1](https://example.com)')).toEqual([
      {
        type: 'link',
        href: 'https://example.com',
        spans: [{ type: 'text', text: '1' }],
      },
    ]);
  });

  it('leaves no stranded parenthetical in the sentence', () => {
    const spans = parseInline('see [1](https://example.com) for more');
    expect(textOf(spans)).toBe('see 1 for more');
    expect(spans.some((s) => s.type === 'text' && s.text.includes('('))).toBe(false);
  });

  it('still reads a real marker in the same sentence', () => {
    const spans = parseInline('cited [2] and linked [3](https://x.com)');
    expect(spans[1]).toEqual({ type: 'footnote', marker: 2, raw: '[2]' });
    expect(spans[3]!.type).toBe('link');
  });
});

describe('malformed input degrades to plain text', () => {
  it('leaves a stray asterisk alone', () => {
    expect(parseInline('a stray * asterisk')).toEqual([
      { type: 'text', text: 'a stray * asterisk' },
    ]);
  });

  it('leaves a lone bracket alone', () => {
    expect(parseInline('a lone [ bracket')).toEqual([
      { type: 'text', text: 'a lone [ bracket' },
    ]);
  });

  it('leaves an unmatched link opening alone', () => {
    expect(parseInline('[label](https://x.com')).toEqual([
      { type: 'text', text: '[label](https://x.com' },
    ]);
  });

  it('leaves an unclosed inline code run alone', () => {
    expect(parseInline('an `unclosed span')).toEqual([
      { type: 'text', text: 'an `unclosed span' },
    ]);
  });

  it('does not let an unclosed fence swallow the rest of the answer', () => {
    const blocks = parseAnswer('Before.\n\n```\ncode-ish\n\nAfter the fence.');
    expect(blocks.every((b) => b.type !== 'codeBlock')).toBe(true);
    expect(textOf(blocks).includes('After the fence.')).toBe(true);
  });

  it('parses every prefix of a formatted answer — the streaming case', () => {
    const source =
      '## Heading [1]\n\nSome **bold** and *italic* with a [link](https://x.com).\n\n- one\n- two\n\n> quoted\n\n```\ncode\n```\n';
    for (let i = 0; i <= source.length; i++) {
      const prefix = source.slice(0, i);
      const blocks = parseAnswer(prefix);
      // No throw, and every word the reader has received so far is
      // still on the page — a half-typed construct never hides text.
      const rendered = textOf(blocks);
      for (const word of [
        'Heading',
        'bold',
        'italic',
        'link',
        'one',
        'two',
        'quoted',
      ]) {
        if (prefix.includes(word)) {
          expect(rendered.includes(word), `"${word}" lost at prefix ${i}`).toBe(true);
        }
      }
    }
  });

  it('handles an empty answer', () => {
    expect(parseAnswer('')).toEqual([]);
    expect(parseAnswer('\n\n')).toEqual([]);
  });
});

describe('escapes', () => {
  it('lets an author write a literal asterisk', () => {
    expect(parseInline('a literal \\*star\\*')).toEqual([
      { type: 'text', text: 'a literal *star*' },
    ]);
  });

  it('lets an author write a literal bracketed number', () => {
    expect(parseInline('\\[1\\] is not a source')).toEqual([
      { type: 'text', text: '[1] is not a source' },
    ]);
  });
});

describe('a whole formatted answer', () => {
  const source = [
    '## On patience',
    '',
    'Patience is **active**, not *passive* [1].',
    '',
    '- It is patience in obedience',
    '- It is patience with decree [2]',
    '  - and with people',
    '',
    '> Wondrous is the affair of the believer.',
    '',
    'Read more at [Quran.com](https://quran.com).',
    '',
    '---',
  ].join('\n');

  it('reads as the expected sequence of blocks', () => {
    expect(parseAnswer(source).map((b) => b.type)).toEqual(['heading', 'paragraph', 'list', 'quote', 'paragraph', 'rule']);
  });

  it('shows no raw syntax to the reader', () => {
    const rendered = textOf(parseAnswer(source));
    for (const syntax of ['##', '**', '](', '> ', '---']) {
      expect(rendered.includes(syntax), `leaked ${syntax}`).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------

describe('tables', () => {
  const table = (source: string) => {
    const block = onlyBlock(source);
    expect(block.type).toBe('table');
    return block as Extract<Block, { type: 'table' }>;
  };

  const grid = (source: string) =>
    [table(source).head, ...table(source).rows].map((row) =>
      row.map((cell) => textOf(cell.spans)),
    );

  it('reads a header, a delimiter and a body', () => {
    expect(grid('| Kind | Domain |\n| --- | --- |\n| Sabr | Obedience |')).toEqual([
        ['Kind', 'Domain'],
        ['Sabr', 'Obedience'],
      ]);
  });

  it('accepts rows without outer pipes', () => {
    expect(grid('Kind | Domain\n--- | ---\nSabr | Obedience')).toEqual([
      ['Kind', 'Domain'],
      ['Sabr', 'Obedience'],
    ]);
  });

  it('reads the alignment the delimiter row asks for', () => {
    expect(table('| a | b | c | d |\n| :-- | :-: | --: | --- |\n| 1 | 2 | 3 | 4 |')
        .align).toEqual(['left', 'center', 'right', null]);
  });

  it('pads a short row and truncates a long one', () => {
    expect(grid('| a | b |\n| --- | --- |\n| 1 |\n| 1 | 2 | 3 |')).toEqual([
      ['a', 'b'],
      ['1', ''],
      ['1', '2'],
    ]);
  });

  it('sets inline syntax inside a cell', () => {
    const cell = table('| a |\n| --- |\n| **bold** |').rows[0]![0]!;
    expect(cell.spans).toEqual([
      {
        type: 'emphasis',
        style: 'bold',
        spans: [{ type: 'text', text: 'bold' }],
      },
    ]);
  });

  it('keeps a footnote marker inside a cell', () => {
    const cell = table('| a |\n| --- |\n| Patience [4] |').rows[0]![0]!;
    expect(cell.spans[1]).toEqual({
      type: 'footnote',
      marker: 4,
      raw: '[4]',
    });
  });

  it('keeps a link inside a cell, and does not read it as a marker', () => {
    const cell = table('| a |\n| --- |\n| [1](https://quran.com) |')
      .rows[0]![0]!;
    expect(cell.spans).toEqual([
      {
        type: 'link',
        href: 'https://quran.com',
        spans: [{ type: 'text', text: '1' }],
      },
    ]);
  });

  it('lets an escaped pipe live inside a cell', () => {
    expect(grid('| a | b |\n| --- | --- |\n| x \\| y | z |')).toEqual([
      ['a', 'b'],
      ['x | y', 'z'],
    ]);
  });

  it('interrupts a running paragraph', () => {
    expect(parseAnswer('Consider:\n| a | b |\n| --- | --- |\n| 1 | 2 |').map(
        (b) => b.type,
      )).toEqual(['paragraph', 'table']);
  });

  it('ends at the paragraph that follows it', () => {
    const blocks = parseAnswer(
      '| a | b |\n| --- | --- |\n| 1 | 2 |\nAnd so the matter rests.',
    );
    expect(blocks.map((b) => b.type)).toEqual(['table', 'paragraph']);
    expect(textOf([blocks[1]!])).toBe('And so the matter rests.');
  });

  it('shows no raw syntax to the reader', () => {
    const rendered = textOf(
      parseAnswer('| Kind | Domain |\n| --- | --- |\n| Sabr | Obedience |'),
    );
    for (const syntax of ['|', '---']) {
      expect(rendered.includes(syntax), `leaked ${syntax}`).toBe(false);
    }
  });
});

describe('tables that are not tables', () => {
  const isParagraph = (source: string) =>
    parseAnswer(source).every((b) => b.type === 'paragraph');

  it('leaves a header with no delimiter row as prose', () => {
    expect(isParagraph('| Kind | Domain |\n| Sabr | Obedience |')).toBe(true);
  });

  it('leaves a delimiter row of the wrong width as prose', () => {
    expect(isParagraph('| a | b |\n| --- |\n| 1 | 2 |')).toBe(true);
  });

  it('leaves a sentence containing a pipe as prose', () => {
    expect(isParagraph('Choose a | b, then continue reading.')).toBe(true);
  });

  it('does not read a thematic break as a delimiter row', () => {
    expect(parseAnswer('Some prose | with a pipe\n---\nMore prose.').map(
        (b) => b.type,
      )).toEqual(['paragraph', 'rule', 'paragraph']);
  });

  // A half-arrived table is malformed input, and a lone `|` is simply
  // the character the answer has typed so far. What must never happen
  // is text going missing: no prefix may swallow a word that has
  // already reached the reader.
  it('never loses a word while a table is streaming in', () => {
    const source =
      'Consider:\n\n| Kind | Domain |\n| --- | --- |\n| Sabr | Obedience |\n| Shukr | Ease |\n\nAnd so.';
    for (let i = 1; i <= source.length; i++) {
      const prefix = source.slice(0, i);
      const rendered = textOf(parseAnswer(prefix));
      for (const word of prefix.match(/[A-Za-z]+/g) ?? []) {
        expect(rendered.includes(word), `lost "${word}" at prefix ${i}`).toBe(true);
      }
    }
  });

  it('leaks no pipe once the table is whole', () => {
    const rendered = textOf(
      parseAnswer('| Kind | Domain |\n| --- | --- |\n| Sabr | Obedience |'),
    );
    expect(rendered.includes('|')).toBe(false);
  });
});
