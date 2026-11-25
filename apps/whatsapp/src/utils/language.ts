/**
 * Text direction detection.
 *
 * Python counterpart: `legacy/whatsapp/src/ansari_whatsapp/utils/language_utils.py`. Its other function,
 * `get_language_from_text`, is an unused placeholder that always returns "en", so it is not ported.
 */

/**
 * Right-to-left script ranges: Arabic, Arabic Supplement, Arabic Extended-A, and Arabic Presentation Forms-A and -B.
 * The `g` flag makes `String.match` return every match; the `u` flag makes the pattern read code points.
 */
const RTL_CHARS = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/gu;

/** More than this share of right-to-left characters makes the whole text right-to-left. */
const RTL_SHARE_THRESHOLD = 0.3;

/**
 * `'unknown'` is in the type because the Python signature promises it, but nothing returns it today.
 * A string literal union like this is how TypeScript spells Python's `Literal["ltr", "rtl", "unknown"]`.
 */
export type TextDirection = 'ltr' | 'rtl' | 'unknown';

/**
 * Detect whether `text` reads left-to-right or right-to-left.
 *
 * Length is counted in code points, as Python's `len()` does: `[...text]` splits a string into code points, whereas
 * `text.length` counts UTF-16 units and would count an emoji as 2. With emoji in the text the two give different
 * answers (4 Arabic letters among 8 emoji is 33% in Python and 20% by `.length`).
 *
 * Empty text: Python raises `ZeroDivisionError`, JavaScript would quietly divide to `NaN`. The callers never pass
 * empty text (they check first), so the difference cannot be reached; it is made explicit here as `'ltr'`.
 */
export function getLanguageDirectionFromText(text: string): TextDirection {
  const total = [...text].length;
  if (total === 0) return 'ltr';
  const rtlCount = text.match(RTL_CHARS)?.length ?? 0;
  return rtlCount / total > RTL_SHARE_THRESHOLD ? 'rtl' : 'ltr';
}
