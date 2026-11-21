/**
 * Splitting an answer longer than WhatsApp's 4000-character limit.
 *
 * Python tests ported: `test_message_splitter.py`, with the same inputs and assertions. Added: a table of inputs that
 * both languages split, checked against what Python produced (chunk count, each chunk's length in code points, and a
 * hash of the text), because the Python tests only check properties, not exact cuts.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { splitMessage, WHATSAPP_MAX_MESSAGE_LENGTH } from '../src/formatting/messageSplitter';
import { SPLITTER_CASES } from './fixtures/pythonOracle';

const LIMIT = WHATSAPP_MAX_MESSAGE_LENGTH;
const codePoints = (text: string) => [...text].length;

function paragraphs(count: number, size = 500): string {
  return Array.from({ length: count }, (_, i) => `${String(i).padStart(3, '0')} ${'w'.repeat(size - 4)}`).join('\n\n');
}

describe('ported from test_message_splitter.py', () => {
  it('does not split a short message', () => {
    expect(splitMessage('hello')).toEqual(['hello']);
  });

  it('does not split a message of exactly the limit', () => {
    expect(splitMessage('a'.repeat(LIMIT))).toEqual(['a'.repeat(LIMIT)]);
  });

  it('splits a long message into chunks within the limit, in order', () => {
    const chunks = splitMessage(paragraphs(30));
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => codePoints(chunk) <= LIMIT)).toBe(true);
    const order = chunks.flatMap((chunk) => chunk.match(/^\d{3}/gm) ?? []);
    expect(order).toEqual(Array.from({ length: 30 }, (_, i) => String(i).padStart(3, '0')));
  });

  it('loses no text when splitting by paragraphs', () => {
    const text = paragraphs(30);
    expect(splitMessage(text).join('\n\n')).toBe(text);
  });

  it('cuts one giant unbroken message into limit-sized pieces, in order', () => {
    const text = Array.from({ length: LIMIT * 2 + 123 }, (_, i) => String.fromCharCode(97 + (i % 26))).join('');
    const chunks = splitMessage(text);
    expect(chunks.every((chunk) => codePoints(chunk) <= LIMIT)).toBe(true);
    expect(chunks.join('')).toBe(text);
  });

  it('starts a new chunk at each header', () => {
    const section = `*_Title_*\n${'x'.repeat(2500)}`;
    const chunks = splitMessage([section, section, section].join('\n\n'));
    expect(chunks).toHaveLength(3);
    expect(chunks.every((chunk) => chunk.startsWith('*_Title_*'))).toBe(true);
  });

  it('does not cut a long bold phrase in half', () => {
    const bold = `*${'b'.repeat(100)}*`;
    const chunks = splitMessage([`${bold} ${'a'.repeat(3500)}`, `${bold} ${'c'.repeat(3500)}`].join('\n\n'));
    expect(chunks.every((chunk) => (chunk.match(/\*/g) ?? []).length % 2 === 0)).toBe(true);
  });

  it('does not cut a URL in half', () => {
    const url = `https://example.org/${'u'.repeat(200)}`;
    const chunks = splitMessage(`${'a'.repeat(LIMIT - 50)} ${url} ${'z'.repeat(500)}`);
    expect(chunks.some((chunk) => chunk.includes(url))).toBe(true);
  });
});

/** The same inputs `generate_python_oracle.py` gave Python. Keep the two lists in step. */
const url = `https://example.org/${'u'.repeat(200)}`;
const bold = `*${'b'.repeat(100)}*`;
const section = `*_Title_*\n${'x'.repeat(2500)}`;
const INPUTS: Record<string, string> = {
  short: 'hello',
  exactly_the_limit: 'a'.repeat(LIMIT),
  one_over_the_limit_without_spaces: 'a'.repeat(LIMIT + 1),
  thirty_paragraphs: paragraphs(30),
  giant_unbroken: Array.from({ length: LIMIT * 2 + 123 }, (_, i) => String.fromCharCode(97 + (i % 26))).join(''),
  three_header_sections: [section, section, section].join('\n\n'),
  long_prefix_then_headers: `${Array(4).fill('q'.repeat(1500)).join('\n\n')}\n\n*_H1_*\n${'x'.repeat(100)}\n\n*_H2_*\n${'y'.repeat(100)}`,
  header_section_too_long: `*_A_*\n${'z'.repeat(4500)}\n\n*_B_*\n${'z'.repeat(100)}`,
  bold_sections: Array.from({ length: 4 }, (_, i) => `*Item ${i}* ${'word '.repeat(700)}`).join('\n\n'),
  long_bold_phrase: [`${bold} ${'a'.repeat(3500)}`, `${bold} ${'c'.repeat(3500)}`].join('\n\n'),
  url_at_the_boundary: `${'a'.repeat(LIMIT - 50)} ${url} ${'z'.repeat(500)}`,
  words_without_paragraphs: 'lorem ipsum dolor '.repeat(600),
  lines_without_blank_lines: 'line of text\n'.repeat(400),
  emoji_only_over_the_limit: '\u{1F600}'.repeat(LIMIT + 1),
  emoji_at_the_boundary: `${'a'.repeat(LIMIT - 1)}${'\u{1F600}'.repeat(3)}`,
  emoji_and_spaces: '\u{1F600} '.repeat(3000),
  emoji_paragraphs: Array(3).fill('\u{1F600}'.repeat(1500)).join('\n\n'),
  arabic_words: '\u0643\u0644\u0645\u0629 '.repeat(2000),
  one_paragraph_too_long_in_the_middle: `short\n\n${'x'.repeat(4500)}\n\nshort two`,
  several_blank_lines: `${'a'.repeat(2000)}\n\n\n\n${'b'.repeat(2500)}`,
  only_newlines: '\n'.repeat(5000),
  only_spaces: ' '.repeat(4001),
};

/** Inputs where the port differs from Python on purpose: a text that is only whitespace has nothing to send. */
const FIXED = new Set(['only_spaces']);

describe('splits exactly where Python splits', () => {
  it('covers every input the Python side was given', () => {
    expect(Object.keys(INPUTS).sort()).toEqual(Object.keys(SPLITTER_CASES).sort());
  });

  it.each(Object.entries(SPLITTER_CASES).filter(([name]) => !FIXED.has(name)))('%s', (name, expected) => {
    const chunks = splitMessage(INPUTS[name]!);
    expect(chunks.map(codePoints)).toEqual(expected.lengths);
    expect(chunks).toHaveLength(expected.count);
    expect(createHash('sha256').update(chunks.join('\u0000'), 'utf8').digest('hex')).toBe(expected.sha256);
  });
});

describe('text with nothing to send (fixed, differs from Python)', () => {
  it('gives no messages for an empty answer', () => {
    expect(splitMessage('')).toEqual([]);
  });

  // Python: an answer of only newlines gave no messages (matched here), and only spaces gave pieces of spaces,
  // which WhatsApp rejects as an empty message
  it.each([' ', '   ', '\n', '\n\n\n', ' \n \t \r\n', ' '.repeat(LIMIT + 1), '\n'.repeat(5000)])(
    'gives no messages for whitespace only (%j)',
    (text) => {
      expect(splitMessage(text)).toEqual([]);
    },
  );

  it('keeps the oracle honest: Python did send pieces of spaces', () => {
    expect(SPLITTER_CASES.only_spaces!.count).toBe(2);
  });

  // The three paragraphs are too big to share a message (3000 + 3000 > 4000), so the spaces become a piece of their own
  it('drops a whitespace-only piece from a longer answer but keeps the text around it', () => {
    const text = `${'a'.repeat(3000)}\n\n${' '.repeat(3000)}\n\n${'b'.repeat(1500)}`;
    const chunks = splitMessage(text);
    expect(chunks).toEqual(['a'.repeat(3000), 'b'.repeat(1500)]);
  });

  it('does not trim or change a normal message', () => {
    expect(splitMessage('  hello  \n')).toEqual(['  hello  \n']);
  });
});

describe('emoji', () => {
  // A JavaScript string is 16-bit units; an emoji outside the basic plane is two of them (a surrogate pair).
  // Cutting between the two leaves a broken character that WhatsApp would show as a replacement mark.
  const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

  it('never cuts inside an emoji', () => {
    for (const name of ['emoji_only_over_the_limit', 'emoji_at_the_boundary', 'emoji_and_spaces']) {
      for (const chunk of splitMessage(INPUTS[name]!)) expect(LONE_SURROGATE.test(chunk)).toBe(false);
    }
  });

  // Counting by `.length` would call each paragraph 3000 long and send three messages, not two
  it('packs emoji paragraphs by code points, so two 1500-emoji paragraphs share a message', () => {
    const chunks = splitMessage(INPUTS.emoji_paragraphs!);
    expect(chunks.map(codePoints)).toEqual([3002, 1500]);
  });

  it('counts an emoji as one character, so 4000 emoji fit in one message', () => {
    const text = '\u{1F600}'.repeat(LIMIT);
    expect(text.length).toBe(LIMIT * 2);
    expect(splitMessage(text)).toEqual([text]);
  });
});
