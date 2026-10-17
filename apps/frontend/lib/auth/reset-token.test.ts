// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  handOverResetToken,
  peekResetToken,
  takeResetToken,
  takeResetTokenFromUrl,
} from '@/lib/auth/reset-token';

// Against jsdom's REAL location and history: the property under test is
// that the token leaves the address and the history entry in place.

const TOKEN = 'reset-token-abcdef0123456789';

afterEach(() => {
  takeResetToken();
  window.history.replaceState(null, '', '/');
});

describe('takeResetTokenFromUrl (the web entry, before expo-router loads)', () => {
  it('moves ?token= into memory and out of the address and the history entry, in place', () => {
    window.history.replaceState({ router: 'kept' }, '', `/reset-password?token=${TOKEN}`);
    const entries = window.history.length;

    takeResetTokenFromUrl(window);

    expect(window.location.pathname).toBe('/reset-password');
    expect(window.location.search).toBe('');
    expect(window.location.href).not.toContain(TOKEN);
    expect(window.history.length).toBe(entries);
    expect(window.history.state).toEqual({ router: 'kept' });
    expect(takeResetToken()).toBe(TOKEN);
  });

  it('keeps any other parameter and the hash', () => {
    window.history.replaceState(null, '', `/reset-password?utm_source=mail&token=${TOKEN}#top`);
    takeResetTokenFromUrl(window);
    expect(window.location.search).toBe('?utm_source=mail');
    expect(window.location.hash).toBe('#top');
    expect(window.location.href).not.toContain(TOKEN);
  });

  it('a percent-encoded token arrives decoded', () => {
    window.history.replaceState(null, '', '/reset-password?token=a%2Bb%3Dc');
    takeResetTokenFromUrl(window);
    expect(takeResetToken()).toBe('a+b=c');
  });

  it.each([
    ['another page', `/share/x?token=${TOKEN}`],
    ['a near-miss path', `/reset-password-x?token=${TOKEN}`],
  ])('leaves %s alone', (_label, url) => {
    window.history.replaceState(null, '', url);
    takeResetTokenFromUrl(window);
    expect(window.location.href).toContain(TOKEN);
    expect(peekResetToken()).toBeNull();
  });

  it('with no token, changes nothing', () => {
    window.history.replaceState({ a: 1 }, '', '/reset-password?x=1');
    takeResetTokenFromUrl(window);
    expect(window.location.search).toBe('?x=1');
    expect(peekResetToken()).toBeNull();
  });

  it('does nothing without a window (server)', () => {
    expect(() => takeResetTokenFromUrl(undefined)).not.toThrow();
  });

  // React Native defines a global `window` with neither `location` nor
  // `history` (#311: reading them red-boxed the app at boot on iOS).
  it.each([
    ['React Native (window, no location, no history)', {}],
    ['a location without history', { location: { pathname: '/reset-password', search: `?token=${TOKEN}` } }],
    ['history without replaceState', { location: { pathname: '/reset-password', search: `?token=${TOKEN}` }, history: {} }],
  ])('never throws on %s, and takes nothing', (_label, win) => {
    expect(() => takeResetTokenFromUrl(win as never)).not.toThrow();
    expect(peekResetToken()).toBeNull();
  });
});

describe('the slot', () => {
  it('take empties it; peek does not', () => {
    handOverResetToken(` ${TOKEN} `);
    expect(peekResetToken()).toBe(TOKEN);
    expect(takeResetToken()).toBe(TOKEN);
    expect(peekResetToken()).toBeNull();
  });

  it('an empty token is no token', () => {
    handOverResetToken('  ');
    expect(peekResetToken()).toBeNull();
  });
});

describe('the app entry strips before the router loads', () => {
  const root = path.join(__dirname, '..', '..');

  it('package.json main is the entry, and the entry imports the strip FIRST', () => {
    const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as { main: string };
    expect(pkg.main).toBe('index.ts');
    const imports = [...readFileSync(path.join(root, 'index.ts'), 'utf8').matchAll(/^import '([^']+)';$/gm)].map(
      (m) => m[1],
    );
    expect(imports).toEqual(['./lib/auth/strip-reset-token', 'expo-router/entry']);
  });

  it('the strip module is gated on Platform.OS, not on window (window exists on React Native)', () => {
    const strip = readFileSync(path.join(root, 'lib', 'auth', 'strip-reset-token.ts'), 'utf8');
    expect(strip).toMatch(/if \(Platform\.OS === 'web' && typeof window !== 'undefined'\)/);
  });

  it('the strip module runs the strip on the real window at import', async () => {
    window.history.replaceState(null, '', `/reset-password?token=${TOKEN}`);
    await import('@/lib/auth/strip-reset-token');
    expect(window.location.search).toBe('');
    expect(takeResetToken()).toBe(TOKEN);
  });
});
