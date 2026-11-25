/**
 * The small pure pieces of the webhook path: the signature check, the token comparison and Meta's reply body.
 *
 * Python counterparts: `verify_meta_signature` and `create_response_for_meta` (which had no direct tests; the signature was only
 * tried through the route). The expected digests come from Python's own `hmac`, run once (see the comment on `KNOWN`).
 */
import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Secret } from '../src/config';
import { createResponseForMeta } from '../src/webhook/metaResponse';
import { constantTimeEquals, isValidSignature } from '../src/webhook/signature';

const SECRET = new Secret('app-secret');

/** Independent of the code under test: Node's own `createHmac`. */
function hmacHex(body: string | Buffer, key = 'app-secret'): string {
  return createHmac('sha256', key).update(body).digest('hex');
}

/**
 * What Python's `hmac.new(b"app-secret", body, hashlib.sha256).hexdigest()` returned for each body, run on the legacy service's
 * interpreter. The TypeScript check is held against the real implementation, not only against Node's.
 */
const PYTHON_DIGESTS: Array<[name: string, body: Buffer, hex: string]> = [
  ['JSON', Buffer.from('{"a":1}'), 'a2ac6607a24977f9757e6d78319ae1660ad42ffeee0ee3f0dff30a92bcf85448'],
  ['an empty body', Buffer.alloc(0), 'f685db4c946698bf105ff5b62e30bc1f78216f3914b12bb750f8992aa6748824'],
  [
    'Arabic and an emoji',
    Buffer.from('\u0645\u0631\u062d\u0628\u0627 \u{1F600}', 'utf8'),
    '2b5ebaae1080aa1f923b4f58e6a066ef9d95c0f652598dcb8883f715ccce7298',
  ],
  ['5000 bytes', Buffer.from('x'.repeat(5000)), '85980d1bf475e247d436b8a48f404e96fd761a5f4a1b315e8bac54f81b4068c9'],
];

describe('isValidSignature', () => {
  const body = Buffer.from('{"a":1}');

  it.each(PYTHON_DIGESTS)('accepts the digest Python computed for %s', (_name, bytes, hex) => {
    expect(hmacHex(bytes)).toBe(hex);
    expect(isValidSignature(bytes, `sha256=${hex}`, SECRET)).toBe(true);
  });

  it('accepts the right signature', () => {
    expect(isValidSignature(body, `sha256=${hmacHex(body)}`, SECRET)).toBe(true);
  });

  it('accepts an empty body signed correctly', () => {
    expect(isValidSignature(Buffer.alloc(0), `sha256=${hmacHex('')}`, SECRET)).toBe(true);
  });

  it('refuses a missing header', () => {
    expect(isValidSignature(body, undefined, SECRET)).toBe(false);
  });

  // The check cuts off the first seven characters and compares the rest, so a valid digest behind seven characters of anything
  // else would pass if the prefix itself were not checked
  it.each(['sha256:', 'sha1===', 'xxxxxxx', 'SHA256=', ' sha256', '\u0000\u0000\u0000\u0000\u0000\u0000\u0000'])(
    'refuses a valid digest behind the wrong seven-character prefix %j',
    (prefix) => {
      expect(isValidSignature(body, `${prefix}${hmacHex(body)}`, SECRET)).toBe(false);
    },
  );

  it.each(['', 'sha256', 'sha256:abc', 'SHA256=abc', 'sha1=abc', ' sha256=abc'])('refuses the prefix in %j', (header) => {
    expect(isValidSignature(body, header, SECRET)).toBe(false);
  });

  it('refuses a digest of the wrong length without throwing (timingSafeEqual throws on unequal lengths)', () => {
    const good = hmacHex(body);
    for (const header of [`sha256=${good.slice(0, -1)}`, `sha256=${good}0`, 'sha256=', `sha256=${'a'.repeat(1000)}`]) {
      expect(isValidSignature(body, header, SECRET)).toBe(false);
    }
  });

  it('refuses the right digest in upper case', () => {
    expect(isValidSignature(body, `sha256=${hmacHex(body).toUpperCase()}`, SECRET)).toBe(false);
  });

  it('refuses a digest that differs in only the last character, and in only the first', () => {
    const good = hmacHex(body);
    const flip = (c: string) => (c === '0' ? '1' : '0');
    expect(isValidSignature(body, `sha256=${good.slice(0, -1)}${flip(good.at(-1)!)}`, SECRET)).toBe(false);
    expect(isValidSignature(body, `sha256=${flip(good[0]!)}${good.slice(1)}`, SECRET)).toBe(false);
  });

  it('refuses a signature under another secret', () => {
    expect(isValidSignature(body, `sha256=${hmacHex(body, 'other')}`, SECRET)).toBe(false);
  });

  it('refuses a signature of a different body', () => {
    expect(isValidSignature(body, `sha256=${hmacHex('{"a":2}')}`, SECRET)).toBe(false);
  });

  it('refuses a digest with non-ASCII characters without throwing', () => {
    expect(isValidSignature(body, `sha256=${'\u00e9'.repeat(32)}`, SECRET)).toBe(false);
  });

  it('is not fooled by two characters that are different bytes but the same length as characters', () => {
    // 64 characters, but more than 64 bytes: the length check must compare bytes, or timingSafeEqual would throw
    expect(isValidSignature(body, `sha256=${'\u00e9'.repeat(64)}`, SECRET)).toBe(false);
  });
});

describe('constantTimeEquals', () => {
  it('is true for equal text and false for different text', () => {
    expect(constantTimeEquals('abc', 'abc')).toBe(true);
    expect(constantTimeEquals('abc', 'abd')).toBe(false);
    expect(constantTimeEquals('abc', 'ab')).toBe(false);
    expect(constantTimeEquals('', '')).toBe(true);
    expect(constantTimeEquals('', 'a')).toBe(false);
  });

  it('copes with non-ASCII text on either side, comparing UTF-8 bytes', () => {
    expect(constantTimeEquals('t\u00e9st', 't\u00e9st')).toBe(true);
    expect(constantTimeEquals('t\u00e9st', 'test')).toBe(false);
    expect(constantTimeEquals('test', 't\u00e9st')).toBe(false);
    expect(constantTimeEquals('\u{1F600}', '\u{1F600}')).toBe(true);
  });

  it('does not equate two strings that are the same length in characters but not in bytes', () => {
    expect(constantTimeEquals('ab', '\u00e9')).toBe(false);
  });
});

describe('createResponseForMeta', () => {
  const NOW = 1_794_312_000;

  it('is a 200 success with the three base keys by default', () => {
    expect(createResponseForMeta({}, true, NOW)).toEqual({ status: 200, body: { success: true, message: 'OK', timestamp: NOW } });
  });

  it('puts the error code and details under error_code and detail', () => {
    const { body } = createResponseForMeta({ success: false, errorCode: 'X', details: { error: 'why' } }, true, NOW);
    expect(body).toEqual({ success: false, message: 'OK', timestamp: NOW, error_code: 'X', detail: { error: 'why' } });
  });

  it('leaves out an empty error code and empty details, as Python did', () => {
    const { body } = createResponseForMeta({ errorCode: '', details: {} }, true, NOW);
    expect(Object.keys(body).sort()).toEqual(['message', 'success', 'timestamp']);
  });

  describe('the status', () => {
    it('is always 200 when ALWAYS_RETURN_OK_TO_META is on, whatever the failure', () => {
      for (const statusCode of [202, 400, 415, 422, 503]) {
        expect(createResponseForMeta({ success: false, statusCode }, true, NOW).status).toBe(200);
      }
    });

    it('is the real status for a failure when the flag is off', () => {
      for (const statusCode of [202, 400, 415, 422, 503]) {
        expect(createResponseForMeta({ success: false, statusCode }, false, NOW).status).toBe(statusCode);
      }
    });

    it('is 200 for a success when the flag is off, whatever status was passed', () => {
      expect(createResponseForMeta({ success: true, statusCode: 503 }, false, NOW).status).toBe(200);
    });

    it('defaults a failure to 200 when no status is given', () => {
      expect(createResponseForMeta({ success: false }, false, NOW).status).toBe(200);
    });
  });

  it('stamps the current time when none is passed', () => {
    const before = Math.floor(Date.now() / 1000);
    const { body } = createResponseForMeta({}, true);
    expect(body.timestamp).toBeGreaterThanOrEqual(before);
    expect(body.timestamp).toBeLessThanOrEqual(before + 2);
  });
});
