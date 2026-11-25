/**
 * `pythonSplitWords` must cut at exactly the characters Python's `str.split()` cuts at. The list of those characters is not
 * written by hand: `generate_python_oracle.py` asks Python's `isspace()` about every code point from 0 to 0x10FFFF.
 */
import { describe, expect, it } from 'vitest';
import { pythonSplitWords } from '../src/utils/pythonText';
import { PYTHON_WHITESPACE } from './fixtures/pythonOracle';

describe('pythonSplitWords', () => {
  it('treats exactly the code points Python treats as whitespace as separators', () => {
    const python = new Set(PYTHON_WHITESPACE);
    const wrong: string[] = [];
    for (let codePoint = 0; codePoint <= 0x10ffff; codePoint++) {
      if (codePoint >= 0xd800 && codePoint <= 0xdfff) continue; // lone surrogates are not characters
      const text = `a${String.fromCodePoint(codePoint)}b`;
      const split = pythonSplitWords(text).length === 2;
      if (split !== python.has(codePoint)) wrong.push(`U+${codePoint.toString(16).padStart(4, '0')}`);
    }
    expect(wrong).toEqual([]);
  });

  it('is not JavaScript\'s \\s: the byte-order mark stays, the control separators and U+0085 split', () => {
    expect(pythonSplitWords('a\ufeffb')).toEqual(['a\ufeffb']);
    expect(pythonSplitWords('a\u001cb\u0085c')).toEqual(['a', 'b', 'c']);
  });

  it('ignores leading, trailing and repeated whitespace, and gives nothing for blank text', () => {
    expect(pythonSplitWords('  a   b\t\nc  ')).toEqual(['a', 'b', 'c']);
    expect(pythonSplitWords('')).toEqual([]);
    expect(pythonSplitWords(' \u3000\u2028 ')).toEqual([]);
  });
});
