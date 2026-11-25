/**
 * Markdown to WhatsApp formatting. Python has no test for the formatter, so the expected values here are what the Python
 * formatter returned (`tests/fixtures/pythonOracle.ts`), except for the inputs listed in `FIXED`, where the port
 * deliberately differs (owner decision, 2026-11-10: three Python bugs are fixed). Those are asserted separately, with
 * Python's answer beside the new one.
 */
import { describe, expect, it } from 'vitest';
import {
  convertBoldSyntax,
  convertHeaders,
  convertItalicSyntax,
  formatForWhatsApp,
  formatNestedLists,
} from '../src/formatting/whatsappMessageFormatter';
import {
  BOLD_CASES,
  EMPTY_TEXT,
  FORMATTER_CASES,
  HEADER_CASES,
  ITALIC_CASES,
  NESTED_LIST_CASES,
} from './fixtures/pythonOracle';

/**
 * Inputs where the port differs from Python on purpose: input -> what the port returns now. Python's answer for each is
 * still in the oracle, and the tests below check that it really is different.
 */
const FIXED: Record<string, string> = {
  // A lone * next to a space is not an italic marker (Python: "a _ b _ c")
  'a * b * c': 'a * b * c',
  '2 * 3 = 6 and 4 * 5 = 20': '2 * 3 = 6 and 4 * 5 = 20',
  // A * bullet list keeps its bullets (Python: "_ a\n_ b"), and nested * bullets are reformatted like - bullets
  '* a\n* b': '* a\n* b',
  '* a\n  * b\n  * c': '* a\n  -- b\n  -- c',
  '- a\n  * b\n  * c': '- a\n  -- b\n  -- c',
  '* a\n* b\n* c': '* a\n* b\n* c',
  '1 * 2 * 3 and *real*': '1 * 2 * 3 and _real_',
  // *** is bold and italic (Python: "**both**")
  '***both***': '*_both_*',
  '***bold italic***': '*_bold italic_*',
  '***a*** and **b** and *c*': '*_a_* and *b* and _c_',
};

/** The same idea for the italic step on its own. */
const FIXED_ITALIC: Record<string, string> = {
  '* a *': '* a *',
  '*a\n*': '*a\n*',
};

describe('formatForWhatsApp (whole pipeline)', () => {
  it.each(FORMATTER_CASES.filter(([input]) => !(input in FIXED)))('%j (same as Python)', (input, expected) => {
    expect(formatForWhatsApp(input)).toBe(expected);
  });

  it.each(Object.entries(FIXED))('%j (fixed, differs from Python)', (input, expected) => {
    const python = FORMATTER_CASES.find(([candidate]) => candidate === input)?.[1];
    expect(python).toBeDefined();
    expect(python).not.toBe(expected);
    expect(formatForWhatsApp(input)).toBe(expected);
  });

  it('formats a typical answer end to end', () => {
    const answer = '## Ruling\n\nThe **majority** hold it is *recommended*.\n\n1. First\n   - detail a\n   - detail b\n2. Second';
    expect(formatForWhatsApp(answer)).toBe(
      '*_Ruling_*\n\nThe *majority* hold it is _recommended_.\n\n1. First\n   -- detail a\n   -- detail b\n2. Second',
    );
  });

  // Python raises ZeroDivisionError on empty text (inside the direction check). Callers return before formatting an
  // empty answer, so this is unreachable; the port answers with the empty text.
  it('returns empty text for empty text where Python raised ZeroDivisionError', () => {
    expect(EMPTY_TEXT.format).toBe('ZeroDivisionError');
    expect(formatForWhatsApp('')).toBe('');
  });
});

describe('the steps on their own', () => {
  it.each(ITALIC_CASES.filter(([input]) => !(input in FIXED_ITALIC)))('italic %j (same as Python)', (input, expected) => {
    expect(convertItalicSyntax(input)).toBe(expected);
  });
  it.each(Object.entries(FIXED_ITALIC))('italic %j (fixed, differs from Python)', (input, expected) => {
    const python = ITALIC_CASES.find(([candidate]) => candidate === input)?.[1];
    expect(python).not.toBe(expected);
    expect(convertItalicSyntax(input)).toBe(expected);
  });
  it.each(BOLD_CASES)('bold %j', (input, expected) => {
    expect(convertBoldSyntax(input)).toBe(expected);
  });
  it.each(HEADER_CASES)('headers %j', (input, expected) => {
    expect(convertHeaders(input)).toBe(expected);
  });
  it.each(NESTED_LIST_CASES)('nested lists %j', (input, expected) => {
    expect(formatNestedLists(input)).toBe(expected);
  });
});

describe('the italic and bold fixes do not break real markdown', () => {
  it('still italicises text that a star touches', () => {
    expect(formatForWhatsApp('a *b c* d')).toBe('a _b c_ d');
  });

  it('leaves lone stars alone while italicising a real pair on the same line', () => {
    expect(formatForWhatsApp('1 * 2 * 3 and *real*')).toBe('1 * 2 * 3 and _real_');
  });

  it('handles bold-italic, bold and italic together', () => {
    expect(formatForWhatsApp('***a*** and **b** and *c*')).toBe('*_a_* and *b* and _c_');
  });

  it('keeps italic inside bold', () => {
    expect(formatForWhatsApp('**bold with *italic* inside**')).toBe('*bold with _italic_ inside*');
  });

  it('does not italicise across a line break, so two bullet lines never pair up', () => {
    expect(formatForWhatsApp('* a\n* b\n* c')).toBe('* a\n* b\n* c');
  });

  // A line of three stars is a markdown rule, not bold-italic. Both Python and the port turn it into two stars (the bold
  // step); the point of this test is that the new bold-italic step does not pair the two lines up.
  it('does not treat a line of stars as bold-italic', () => {
    expect(formatForWhatsApp('***\ntext\n***')).toBe('**\ntext\n**');
    expect(FORMATTER_CASES.find(([input]) => input === '***\ntext\n***')?.[1]).toBe('**\ntext\n**');
  });
});

// Python's behaviour, kept: it looks odd but nothing here is a bug the owner asked to fix.
describe('behaviour kept from Python on purpose', () => {
  it('puts a carriage return inside the header when the line ends in \\r\\n', () => {
    expect(formatForWhatsApp('## Header\r\n\r\nbody')).toBe('*_Header\r_*\n\n\r\nbody');
  });
});

describe('where JavaScript and Python differ, and the port follows Python', () => {
  it('numbers nested items written with Arabic-Indic digits (JavaScript \\d would miss them)', () => {
    expect(/\d/.test('\u0661')).toBe(false);
    expect(formatNestedLists('  \u0661. item')).toBe('  \u0661 - item');
  });

  it('rewrites every list marker on a line, not just the first', () => {
    expect(formatNestedLists('  - a - b')).toBe('  -- a -- b');
  });

  it('treats a no-break space as indentation, like Python', () => {
    expect(formatNestedLists('\u00a0\u00a0- a')).toBe('\u00a0\u00a0-- a');
  });
});
