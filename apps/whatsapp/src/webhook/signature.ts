/**
 * Proof that a webhook really came from Meta, and the check Meta's one-time handshake uses.
 *
 * Python counterpart: `verify_meta_signature` in `whatsapp_webhook_utils.py`, and the token comparison in the `GET` route of
 * `main.py`.
 *
 * Meta signs every webhook body with the app secret (HMAC-SHA256) and sends the result in `X-Hub-Signature-256: sha256=<hex>`.
 * The signature covers the exact bytes Meta sent, so the check must run on the raw body, before any JSON parsing could change
 * a single byte.
 * https://developers.facebook.com/docs/graph-api/webhooks/getting-started#validate-payloads
 *
 * Differences from Python:
 * - `crypto.timingSafeEqual` replaces `hmac.compare_digest`. Both take the same time however many leading characters match, so
 *   an attacker cannot learn a signature one character at a time. `timingSafeEqual` throws if its two inputs differ in length,
 *   so the lengths are compared first (a length is not a secret: a SHA-256 hex digest is always 64 characters).
 * - Python compared the hex text after lower-casing nothing, so an upper-case signature never matched. The same here, on purpose:
 *   Meta sends lower-case hex.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Secret } from '../config';

const PREFIX = 'sha256=';

/**
 * Is `signatureHeader` the right signature of `rawBody` under `appSecret`?
 *
 * @param rawBody The request body exactly as received.
 * @param signatureHeader The value of `X-Hub-Signature-256`, or `undefined` if the header is missing.
 * @param appSecret Meta's app secret (`META_ANSARI_APP_SECRET`).
 */
export function isValidSignature(rawBody: Buffer, signatureHeader: string | undefined, appSecret: Secret): boolean {
  if (!signatureHeader?.startsWith(PREFIX)) return false;
  const received = signatureHeader.slice(PREFIX.length);
  const computed = createHmac('sha256', appSecret.reveal()).update(rawBody).digest('hex');
  return constantTimeEquals(computed, received);
}

/**
 * Compare two strings in time that does not depend on where they first differ. Python: `hmac.compare_digest` on the UTF-8
 * bytes, which also copes with a non-ASCII token (the comparison happens on bytes, so it never raises).
 */
export function constantTimeEquals(expected: string, actual: string): boolean {
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(actual, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}
