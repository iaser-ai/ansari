/**
 * Masking for values about to be logged: hide phone numbers, BSUIDs and message ids in
 * text and structures.
 *
 * Python counterpart: `legacy/whatsapp/src/ansari_whatsapp/utils/log_masking.py`.
 */

// A BSUID is a two-letter country code, a dot, then up to 128 letters or digits ("US.1349...");
// a parent BSUID has ".ENT." after the country code. A message id is "wamid." plus base64 that
// carries the user's phone number. A phone number may contain spaces, hyphens, dots and
// parentheses. Meta's formats: business-scoped-user-ids and phone-numbers docs.
// https://developers.facebook.com/docs/whatsapp/business-scoped-user-ids
//
// The `g` flag makes `replace` change every match, like Python's `re.sub`. A regex with `g`
// remembers its position between `.test()` calls, which is why these are only used with `replace`.
const MESSAGE_ID = /wamid\.[A-Za-z0-9+/=_-]+/g;
const BSUID = /\b[A-Z]{2}\.(?:ENT\.)?[A-Za-z0-9]{1,128}\b/g;
// Eight digits or more, so a 6 or 7 digit Meta error code stays readable
const PHONE = /[+(]?\d(?:[\s().-]{0,2}\d){7,}/g;

/** Replace anything shaped like a message id, BSUID or phone number with a placeholder. */
export function maskIdentifiers(text: string): string {
  return text.replace(MESSAGE_ID, '<message-id>').replace(BSUID, '<bsuid>').replace(PHONE, '<phone>');
}

/**
 * Return `value` with its structure intact but every string masked as `<str len=N>`,
 * except under `safeKeys`.
 *
 * `unknown` is TypeScript's "could be anything, check before use" type; the `typeof` and
 * `Array.isArray` checks below narrow it, as `isinstance` does in Python.
 */
export function redactValues(value: unknown, safeKeys: ReadonlySet<string>, key?: string): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactValues(item, safeKeys, key));
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactValues(v, safeKeys, k)]));
  }
  if (typeof value === 'string' && !(key !== undefined && safeKeys.has(key))) {
    return `<str len=${value.length}>`;
  }
  return value;
}
