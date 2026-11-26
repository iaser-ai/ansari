/**
 * Python's `repr()` for the few shapes that reach a log line: strings, numbers, booleans, null, lists and dicts.
 *
 * Why it exists: the Python service logged values with `!r` and f-strings of lists and dicts, so a line looked like
 * `code=131030 type='OAuthException'` or `Payload keys: ['messaging_product', 'text']`. People search the Railway logs for
 * exactly those shapes, and the Python tests assert them, so the TypeScript service prints the same text.
 *
 * `tests/fixtures/pythonOracle.ts` holds what Python's `repr()` returned for a table of values, and
 * `tests/pythonRepr.test.ts` compares against it.
 */

/**
 * Characters Python's `repr()` writes as an escape instead of showing. Python's rule is "not printable": control
 * characters, unassigned code points, and every separator except the plain space (no-break space, line and paragraph
 * separators, zero-width and other format characters). JavaScript's Unicode classes cover the same ground:
 * `Cc` control, `Cf` format, `Cs` surrogate, `Co` private use, `Cn` unassigned, `Zl`/`Zp` line and paragraph separator,
 * and `Zs` space separators.
 */
const UNPRINTABLE = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Zs}]/u;

/** One character the way Python escapes it: `\t`, `\n`, `\r`, `\xNN`, `\uNNNN` or `\UNNNNNNNN`. */
function escapeCodePoint(char: string): string {
  const code = char.codePointAt(0)!;
  if (code === 0x09) return '\\t';
  if (code === 0x0a) return '\\n';
  if (code === 0x0d) return '\\r';
  const hex = code.toString(16);
  if (code <= 0xff) return `\\x${hex.padStart(2, '0')}`;
  if (code <= 0xffff) return `\\u${hex.padStart(4, '0')}`;
  return `\\U${hex.padStart(8, '0')}`;
}

/**
 * A string the way Python prints it. It uses single quotes, unless the text holds a `'` and no `"`, and escapes the
 * quote it chose, backslashes, and anything not printable.
 */
function repr(text: string): string {
  const quote = text.includes("'") && !text.includes('"') ? '"' : "'";
  let out = '';
  // `for...of` walks code points, so an emoji is one step, not two halves
  for (const char of text) {
    if (char === '\\') out += '\\\\';
    else if (char === quote) out += `\\${quote}`;
    else if (char === ' ') out += ' ';
    else if (UNPRINTABLE.test(char)) out += escapeCodePoint(char);
    else out += char;
  }
  return `${quote}${out}${quote}`;
}

export function pythonRepr(value: unknown): string {
  if (value === null || value === undefined) return 'None';
  if (typeof value === 'string') return repr(value);
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  if (typeof value === 'number') return String(value);
  if (Array.isArray(value)) return `[${value.map(pythonRepr).join(', ')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value).map(([key, item]) => `${repr(key)}: ${pythonRepr(item)}`);
    return `{${entries.join(', ')}}`;
  }
  return repr(String(value));
}

/** `['a', 'b']`, like Python prints a list of strings. */
export function pythonList(items: readonly string[]): string {
  return pythonRepr([...items]);
}
