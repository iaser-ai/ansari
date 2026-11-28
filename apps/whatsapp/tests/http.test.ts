/**
 * The small helpers the HTTP clients share: how a network fault is described in a log, and URL trimming.
 */
import { describe, expect, it } from 'vitest';
import { describeNetworkError, trimTrailingSlashes } from '../src/services/http';

describe('describeNetworkError', () => {
  it('names the error class and the system code, never the message', () => {
    const error = Object.assign(new TypeError('fetch failed for http://secret.test'), {
      cause: Object.assign(new Error('connect ECONNREFUSED http://secret.test'), { code: 'ECONNREFUSED' }),
    });
    expect(describeNetworkError(error)).toBe('TypeError/ECONNREFUSED');
  });

  it('gives just the class when there is no code', () => {
    expect(describeNetworkError(new TypeError('boom http://secret.test'))).toBe('TypeError');
  });

  it('copes with a value that is not an Error', () => {
    expect(describeNetworkError('text')).toBe('string');
    expect(describeNetworkError(undefined)).toBe('undefined');
  });
});

describe('trimTrailingSlashes', () => {
  it.each([
    ['http://h/', 'http://h'],
    ['http://h///', 'http://h'],
    ['http://h', 'http://h'],
    ['http://h/a/', 'http://h/a'],
  ])('%s -> %s', (input, expected) => {
    expect(trimTrailingSlashes(input)).toBe(expected);
  });
});
