/**
 * Split text into words the way Python's `str.split()` does.
 *
 * Why not `text.split(/\s+/)`: JavaScript's `\s` and Python's whitespace are different sets of characters. JavaScript counts the
 * byte-order mark U+FEFF as whitespace, Python does not; Python counts U+001C to U+001F (the file, group, record and unit
 * separators) and U+0085 (next line) as whitespace, JavaScript does not. A thread title built from the first words of a message
 * must be cut at the same places as before, so the set is spelled out and `tests/pythonText.test.ts` checks it against the
 * full list of code points Python's `str.isspace()` accepts (`tests/fixtures/pythonOracle.ts`, `PYTHON_WHITESPACE`).
 */

/** Tab, line feed, vertical tab, form feed, carriage return (U+0009 to U+000D), then U+001C to U+0020 (including space). */
const PYTHON_WHITESPACE = /[\t-\r\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/u;

/** The words of `text`, with no empty strings (Python: `text.split()`). Leading and trailing whitespace is ignored. */
export function pythonSplitWords(text: string): string[] {
  return text.split(PYTHON_WHITESPACE).filter((word) => word !== '');
}
