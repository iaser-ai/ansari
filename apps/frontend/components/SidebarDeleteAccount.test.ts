import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// The rail's "Delete account" entry (#306) is offered to a real account only:
// a guest has nothing of its own to delete and must never see it. A source
// scan, like SidebarLegalLinks.test.ts: the rail needs its whole provider tree
// to render, and what is checked is which branch of the account footer holds
// the link and where it goes. (The page itself is render-tested in
// DeleteAccountScreen.test.tsx, guest case included.)

const source = readFileSync(path.join(__dirname, 'Sidebar.tsx'), 'utf8');

/** The account footer's two branches: `hasRealAccount ? (real) : (other)`. */
function footerBranches(text: string): { real: string; other: string } {
  const start = text.indexOf('{hasRealAccount ? (');
  if (start < 0) throw new Error('no account footer');
  const split = text.indexOf(') : (', start);
  const end = text.indexOf(')}', split);
  return { real: text.slice(start, split), other: text.slice(split, end) };
}

describe('rail "Delete account" entry (issue #306)', () => {
  it('is in the real-account branch and not in the guest/signed-out one', () => {
    const { real, other } = footerBranches(source);
    expect(real).toContain('testID="sidebar-delete-account"');
    expect(other).not.toContain('sidebar-delete-account');
    expect(source.match(/sidebar-delete-account/g)).toHaveLength(1);
  });

  it('opens /delete-account', () => {
    const handler = source.match(/const openDeleteAccount = \(\) => \{[\s\S]*?\};/);
    expect(handler?.[0]).toContain("router.push('/delete-account')");
  });

  it('the scan tells the branches apart (near-miss: the link in the guest branch)', () => {
    const planted = source.replace(
      'Keep what you&apos;ve learned',
      'Keep what you&apos;ve learned testID="sidebar-delete-account"',
    );
    expect(planted).not.toBe(source);
    expect(footerBranches(planted).other).toContain('sidebar-delete-account');
  });
});
