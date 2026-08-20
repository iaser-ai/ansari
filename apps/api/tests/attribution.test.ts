import { describe, it, expect, vi, beforeEach } from 'vitest';

// getClientId reports attribution to Sentry (spec 56). Mock the SDK so we can
// assert the tag/warning calls without reaching the network.
vi.mock('@sentry/nextjs', () => ({
  setTag: vi.fn(),
  captureMessage: vi.fn(),
}));

import * as Sentry from '@sentry/nextjs';
import { NextRequest } from 'next/server';
import {
  getClientId,
  CLIENT_HEADER,
  CLIENT_SRC_PARAM,
  INVALID_CLIENT,
} from '@/lib/attribution';

const setTag = vi.mocked(Sentry.setTag);
const captureMessage = vi.mocked(Sentry.captureMessage);

// Build a request with (or without) the X-Ansari-Client header.
function req(clientHeader?: string): NextRequest {
  const headers: Record<string, string> = {};
  if (clientHeader !== undefined) headers[CLIENT_HEADER] = clientHeader;
  return new NextRequest('http://localhost/api/v2/threads', { headers });
}

beforeEach(() => {
  setTag.mockClear();
  captureMessage.mockClear();
});

describe('getClientId (spec 56)', () => {
  it('returns null when the header is absent (no-op, no Sentry calls)', () => {
    expect(getClientId(req())).toBeNull();
    expect(setTag).not.toHaveBeenCalled();
    expect(captureMessage).not.toHaveBeenCalled();
  });

  it('returns a valid id unchanged and tags it', () => {
    expect(getClientId(req('muslimpedia'))).toBe('muslimpedia');
    expect(setTag).toHaveBeenCalledWith('client', 'muslimpedia');
    expect(setTag).toHaveBeenCalledTimes(1);
    expect(captureMessage).not.toHaveBeenCalled();
  });

  it('accepts first-party ids with hyphens', () => {
    expect(getClientId(req('askansari-web'))).toBe('askansari-web');
    expect(getClientId(req('askansari-android'))).toBe('askansari-android');
  });

  it('normalizes case and trims surrounding whitespace', () => {
    expect(getClientId(req('  MuslimPedia '))).toBe('muslimpedia');
    expect(setTag).toHaveBeenCalledWith('client', 'muslimpedia');
  });

  it.each([
    ['empty', ''],
    ['whitespace-only', '   '],
    ['too long (>64)', 'a'.repeat(65)],
    ['illegal chars', '<script>'],
    ['spaces inside', 'muslim pedia'],
    ['accented latin-1 (reachable in a header, unlike >255 unicode)', 'café'],
    ['leading non-alphanumeric', '-muslimpedia'],
    ['leading dot', '.muslimpedia'],
  ])('maps a malformed header (%s) to the sentinel + one WARNING', (_label, value) => {
    expect(getClientId(req(value))).toBe(INVALID_CLIENT);
    expect(setTag).toHaveBeenCalledWith('client', INVALID_CLIENT);
    expect(captureMessage).toHaveBeenCalledTimes(1);
    expect(captureMessage).toHaveBeenCalledWith(
      'invalid X-Ansari-Client header',
      expect.objectContaining({ level: 'warning' })
    );
  });

  it("treats the literal reserved word 'invalid' as malformed (not a real client)", () => {
    expect(getClientId(req('invalid'))).toBe(INVALID_CLIENT);
    expect(captureMessage).toHaveBeenCalledTimes(1);
  });

  it('accepts a 64-char id (upper boundary) but rejects 65', () => {
    expect(getClientId(req('a'.repeat(64)))).toBe('a'.repeat(64));
    expect(getClientId(req('a'.repeat(65)))).toBe(INVALID_CLIENT);
  });

  it('truncates the raw value in the Sentry warning (no unbounded payload)', () => {
    getClientId(req('!'.repeat(100)));
    const extra = captureMessage.mock.calls[0][1]?.extra as { rawTruncated: string };
    expect(extra.rawTruncated.length).toBeLessThanOrEqual(32);
  });
});

// Build a request with an optional ?src= query param and optional header.
function srcReq(src?: string, clientHeader?: string): NextRequest {
  const url = new URL('http://localhost/api/v2/mcp-complete?q=test');
  if (src !== undefined) url.searchParams.set(CLIENT_SRC_PARAM, src);
  const headers: Record<string, string> = {};
  if (clientHeader !== undefined) headers[CLIENT_HEADER] = clientHeader;
  return new NextRequest(url, { headers });
}

describe('getClientId ?src= query-param fallback (#87)', () => {
  it('uses ?src= when the header is absent', () => {
    expect(getClientId(srcReq('jbprompt'))).toBe('jbprompt');
    expect(setTag).toHaveBeenCalledWith('client', 'jbprompt');
    expect(captureMessage).not.toHaveBeenCalled();
  });

  it('normalizes case and trims the param like the header', () => {
    expect(getClientId(srcReq('  JBPrompt '))).toBe('jbprompt');
  });

  it('prefers the header when both are present', () => {
    expect(getClientId(srcReq('jbprompt', 'muslimpedia'))).toBe('muslimpedia');
    expect(setTag).toHaveBeenCalledWith('client', 'muslimpedia');
  });

  it('a malformed header still wins over a valid param (sentinel, not fallback)', () => {
    expect(getClientId(srcReq('jbprompt', '<script>'))).toBe(INVALID_CLIENT);
    expect(captureMessage).toHaveBeenCalledWith(
      `invalid ${CLIENT_HEADER} header`,
      expect.objectContaining({ level: 'warning' })
    );
  });

  it.each([
    ['empty', ''],
    ['whitespace-only', '   '],
    ['too long (>64)', 'a'.repeat(65)],
    ['illegal chars', '<script>'],
    ['leading non-alphanumeric', '-jbprompt'],
    ['the reserved sentinel word', 'invalid'],
  ])('maps a malformed ?src= (%s) to the sentinel + one WARNING, never a 4xx path', (_label, value) => {
    expect(getClientId(srcReq(value))).toBe(INVALID_CLIENT);
    expect(setTag).toHaveBeenCalledWith('client', INVALID_CLIENT);
    expect(captureMessage).toHaveBeenCalledTimes(1);
    expect(captureMessage).toHaveBeenCalledWith(
      `invalid ${CLIENT_SRC_PARAM} query param`,
      expect.objectContaining({ level: 'warning' })
    );
  });

  it('returns null when both header and ?src= are absent (unrelated params ignored)', () => {
    expect(getClientId(srcReq())).toBeNull();
    expect(setTag).not.toHaveBeenCalled();
    expect(captureMessage).not.toHaveBeenCalled();
  });
});
