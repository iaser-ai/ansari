/**
 * Text direction. Python has no test for it; the expected values are what the Python function returned
 * (`tests/fixtures/pythonOracle.ts`).
 */
import { describe, expect, it } from 'vitest';
import { getLanguageDirectionFromText } from '../src/utils/language';
import { DIRECTION_CASES, EMPTY_TEXT } from './fixtures/pythonOracle';

describe('getLanguageDirectionFromText', () => {
  it.each(DIRECTION_CASES)('%j -> %s', (text, expected) => {
    expect(getLanguageDirectionFromText(text)).toBe(expected);
  });

  it('counts code points, not UTF-16 units, so emoji do not skew the share', () => {
    // 4 Arabic letters and 8 emoji: 4/12 = 33% (right-to-left). By `.length` the emoji count double: 4/20 = 20% (ltr).
    const text = '\u0645\u0631\u062d\u0628' + '\u{1F600}'.repeat(8);
    expect(text.length).toBe(20);
    expect(getLanguageDirectionFromText(text)).toBe('rtl');
  });

  it('is left-to-right at exactly 30%, as in Python (the rule is "more than 30%")', () => {
    expect(getLanguageDirectionFromText('\u0645'.repeat(3) + 'a'.repeat(7))).toBe('ltr');
  });

  // Python raises ZeroDivisionError here. Callers never pass empty text, so this is a documented difference.
  it('answers ltr for empty text where Python raised ZeroDivisionError', () => {
    expect(EMPTY_TEXT.direction).toBe('ZeroDivisionError');
    expect(getLanguageDirectionFromText('')).toBe('ltr');
  });
});
