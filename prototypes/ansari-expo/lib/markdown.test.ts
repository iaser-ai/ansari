import { describe, expect, it } from 'vitest';
import {
  firstStrongIsRtl,
  inlineText,
  parseInline,
  parseMarkdown,
  splitArabicRuns,
  type Block,
} from './markdown';

/**
 * A staging-shaped Ansari answer: bold, a header, a list, an Arabic verse
 * inside a bold blockquote, inline citations, and the attribution footer
 * link. The streaming test parses every prefix of this.
 */
const SAMPLE = [
  '## On prayer',
  '',
  'Allah says in the **Qur’an**:',
  '',
  '> **وَأَقِمِ ٱلصَّلَوٰةَ لِذِكْرِىٓ** — "Establish prayer for My remembrance." [1]',
  '',
  'Key points:',
  '',
  '- Prayer is *obligatory* five times daily [1]',
  '- It anchors the day in **remembrance**',
  '',
  '1. Fajr',
  '2. Dhuhr',
  '',
  '---',
  '',
  'Ansari is an AI assistant — verify with a scholar. [Learn more](https://ansari.chat/about)',
].join('\n');

describe('parseInline', () => {
  it('parses bold, italic, and links', () => {
    const nodes = parseInline('a **bold** and *soft* [link](https://x.y/z) end');
    expect(nodes).toEqual([
      { type: 'text', text: 'a ' },
      { type: 'strong', children: [{ type: 'text', text: 'bold' }] },
      { type: 'text', text: ' and ' },
      { type: 'em', children: [{ type: 'text', text: 'soft' }] },
      { type: 'text', text: ' ' },
      { type: 'link', href: 'https://x.y/z', children: [{ type: 'text', text: 'link' }] },
      { type: 'text', text: ' end' },
    ]);
  });

  it('parses nested emphasis inside bold and links', () => {
    expect(parseInline('**bold *both***')).toEqual([
      {
        type: 'strong',
        children: [
          { type: 'text', text: 'bold ' },
          { type: 'em', children: [{ type: 'text', text: 'both' }] },
        ],
      },
    ]);
    expect(parseInline('[**b**](https://a.b)')).toEqual([
      {
        type: 'link',
        href: 'https://a.b',
        children: [{ type: 'strong', children: [{ type: 'text', text: 'b' }] }],
      },
    ]);
  });

  it('leaves bare [N] citation markers as text for the chip pass', () => {
    expect(parseInline('as narrated [1] and [12]')).toEqual([
      { type: 'text', text: 'as narrated [1] and [12]' },
    ]);
  });

  it('keeps Arabic inside bold intact', () => {
    const nodes = parseInline('**بِسْمِ الله**');
    expect(nodes).toHaveLength(1);
    expect(nodes[0].type).toBe('strong');
    expect(inlineText(nodes)).toBe('بِسْمِ الله');
  });

  describe('streaming tolerance', () => {
    it('emphasises an unclosed ** to the end instead of showing literals', () => {
      expect(parseInline('important: **do not')).toEqual([
        { type: 'text', text: 'important: ' },
        { type: 'strong', children: [{ type: 'text', text: 'do not' }] },
      ]);
    });

    it('renders half-arrived links as plain text', () => {
      expect(parseInline('see [the source')).toEqual([
        { type: 'text', text: 'see [the source' },
      ]);
      expect(parseInline('see [the source](https://ans')).toEqual([
        { type: 'text', text: 'see [the source](https://ans' },
      ]);
    });

    it('drops a lone trailing asterisk rather than rendering it', () => {
      expect(parseInline('waiting *')).toEqual([
        { type: 'text', text: 'waiting ' },
      ]);
    });
  });
});

describe('parseMarkdown', () => {
  const byType = (blocks: Block[], type: Block['type']) =>
    blocks.filter((b) => b.type === type);

  it('parses the staging-shaped sample into the expected blocks', () => {
    const blocks = parseMarkdown(SAMPLE);
    const types = blocks.map((b) => b.type);
    expect(types).toEqual([
      'heading',
      'paragraph',
      'blockquote',
      'paragraph',
      'list',
      'list',
      'rule',
      'paragraph',
    ]);

    const heading = blocks[0];
    if (heading.type !== 'heading') throw new Error('expected heading');
    expect(heading.level).toBe(2);
    expect(inlineText(heading.children)).toBe('On prayer');

    const [bullets, ordered] = byType(blocks, 'list') as Extract<
      Block,
      { type: 'list' }
    >[];
    expect(bullets.ordered).toBe(false);
    expect(bullets.items).toHaveLength(2);
    expect(ordered.ordered).toBe(true);
    expect(inlineText(ordered.items[1])).toBe('Dhuhr');

    const footer = blocks[blocks.length - 1];
    if (footer.type !== 'paragraph') throw new Error('expected paragraph');
    const link = footer.children.find((n) => n.type === 'link');
    expect(link && link.type === 'link' && link.href).toBe(
      'https://ansari.chat/about',
    );
  });

  it('preserves the Arabic verse and its citation inside the blockquote', () => {
    const quote = parseMarkdown(SAMPLE).find((b) => b.type === 'blockquote');
    if (!quote || quote.type !== 'blockquote') throw new Error('no blockquote');
    const text = inlineText(quote.children);
    expect(text).toContain('لِذِكْرِىٓ');
    expect(text).toContain('[1]');
    expect(quote.children[0].type).toBe('strong');
  });

  it('keeps single newlines inside one paragraph', () => {
    const blocks = parseMarkdown('line one\nline two\n\nnext para');
    expect(blocks).toHaveLength(2);
    const first = blocks[0];
    if (first.type !== 'paragraph') throw new Error('expected paragraph');
    expect(inlineText(first.children)).toBe('line one\nline two');
  });

  it('parses every streaming prefix of the sample without throwing', () => {
    // Simulates SSE arrival: the UI may parse ANY prefix mid-stream.
    for (let i = 0; i <= SAMPLE.length; i++) {
      expect(() => parseMarkdown(SAMPLE.slice(0, i))).not.toThrow();
    }
    // And the full parse is stable: prefix parses settle into the final
    // shape once the closing syntax arrives (spot-check the last 40 chars
    // do not change the earlier block structure).
    const full = parseMarkdown(SAMPLE).map((b) => b.type);
    const near = parseMarkdown(SAMPLE.slice(0, SAMPLE.length - 40)).map(
      (b) => b.type,
    );
    expect(full.slice(0, near.length - 1)).toEqual(near.slice(0, -1));
  });
});

describe('direction helpers', () => {
  it('firstStrongIsRtl follows the first strong character', () => {
    expect(firstStrongIsRtl('بسم then english')).toBe(true);
    expect(firstStrongIsRtl('English then بسم')).toBe(false);
    expect(firstStrongIsRtl('— "بسم"')).toBe(true);
    expect(firstStrongIsRtl('123 !?')).toBe(false);
  });

  it('splitArabicRuns splits scripts and keeps neutrals with the run before', () => {
    expect(splitArabicRuns('He said قال: then left')).toEqual([
      { text: 'He said ', arabic: false },
      { text: 'قال: ', arabic: true },
      { text: 'then left', arabic: false },
    ]);
    expect(splitArabicRuns('وَأَقِمِ')).toEqual([
      { text: 'وَأَقِمِ', arabic: true },
    ]);
    expect(splitArabicRuns('only latin.')).toEqual([
      { text: 'only latin.', arabic: false },
    ]);
    expect(splitArabicRuns('')).toEqual([]);
  });
});
