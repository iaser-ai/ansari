import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// The root layout needs its whole provider tree to render, so where it
// applies the public-page rule is checked in its source (as
// components/SidebarLegalLinks.test.ts does for the rail): the auth gate,
// the rail and account chrome, and the deferred guest all key on
// `isPublicPath`, so the reset pages get exactly what a shared thread gets.
const source = readFileSync(path.join(__dirname, '..', 'app', '_layout.tsx'), 'utf8');

describe('_layout applies the public-page rule (#311)', () => {
  it.each([
    ['the auth gate', "status === 'loading' && !isPublicPath(path)"],
    ['the rail', '!isPublicPath(path) && (desktop ? <Sidebar /> : <SidebarDrawer />)'],
    ['the account chrome', '!isPublicPath(path) && desktop && <AccountChrome />'],
    ['the deferred guest', '<AuthProvider deferGuest={isPublicPath(path)}>'],
  ])('%s keys on isPublicPath', (_label, line) => {
    expect(source).toContain(line);
  });

  it('none of them still keys on the share-only predicate', () => {
    expect(source).not.toMatch(/deferGuest=\{isSharePath|!isSharePath\(path\) &&/);
  });

  it('the scan can fail (a near-miss: the share-only gate)', () => {
    const planted = source.replace("!isPublicPath(path)) {", "!isSharePath(path)) {");
    expect(planted).not.toContain("status === 'loading' && !isPublicPath(path)");
  });
});
