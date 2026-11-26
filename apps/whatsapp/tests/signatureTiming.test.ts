/**
 * The signature and token comparisons must go through `crypto.timingSafeEqual`.
 *
 * Its own file because it wraps `node:crypto` for the whole file (`vi.mock`). The behaviour of `===` and `timingSafeEqual` is the
 * same on every input, so no result can tell them apart: only whether the safe function is called can. A comparison that stops at
 * the first differing character lets an attacker guess a signature one character at a time by timing the answers.
 */
import { createHmac } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Secret } from '../src/config';
import { constantTimeEquals, isValidSignature } from '../src/webhook/signature';

const spy = vi.hoisted(() => ({ calls: 0 }));

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return {
    ...actual,
    timingSafeEqual: (a: Parameters<typeof actual.timingSafeEqual>[0], b: Parameters<typeof actual.timingSafeEqual>[1]) => {
      spy.calls += 1;
      return actual.timingSafeEqual(a, b);
    },
  };
});

beforeEach(() => {
  spy.calls = 0;
});

describe('constant-time comparison', () => {
  it('compares equal text with timingSafeEqual', () => {
    expect(constantTimeEquals('abc', 'abc')).toBe(true);
    expect(spy.calls).toBe(1);
  });

  it('compares different text of the same length with timingSafeEqual too, not an early exit', () => {
    expect(constantTimeEquals('abc', 'abd')).toBe(false);
    expect(spy.calls).toBe(1);
  });

  it('checks a webhook signature with it, whether the signature is right or wrong', () => {
    const secret = new Secret('app-secret');
    const body = Buffer.from('{"a":1}');
    const good = createHmac('sha256', 'app-secret').update(body).digest('hex');

    expect(isValidSignature(body, `sha256=${good}`, secret)).toBe(true);
    expect(isValidSignature(body, `sha256=${'0'.repeat(64)}`, secret)).toBe(false);
    expect(spy.calls).toBe(2);
  });
});
