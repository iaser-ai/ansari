import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// The rail's Terms and Privacy links open the documents as pages, not as a
// system alert holding a placeholder paragraph (#241). A source scan: the
// rail needs its whole provider tree to render, and what is being checked
// is only which handler each link is given.

const source = readFileSync(path.join(__dirname, 'Sidebar.tsx'), 'utf8');

function footerLinkCall(label: string): string {
  const call = source.match(
    new RegExp(`footerLink\\(\\s*'${label}',[\\s\\S]*?\\)\\s*\\}`),
  );
  if (!call) throw new Error(`no footerLink for ${label}`);
  return call[0];
}

describe('rail legal links (issue #241)', () => {
  it.each([
    ['Terms', '/terms', 'terms-button'],
    ['Privacy', '/privacy', 'privacy-button'],
  ])('%s navigates to %s', (label, route, testID) => {
    const call = footerLinkCall(label);
    expect(call).toContain(`router.push('${route}')`);
    expect(call).toContain(`'${testID}'`);
  });

  it('shows no notice for either', () => {
    expect(source).not.toMatch(/showTerms|showPrivacy|showNotice/);
  });

  it('the scan finds a link that is there, and not one that is not', () => {
    expect(footerLinkCall('About')).toContain("router.push('/about')");
    expect(() => footerLinkCall('Cookies')).toThrow();
  });
});

describe('legal routes', () => {
  const layout = readFileSync(
    path.join(__dirname, '..', 'app', '_layout.tsx'),
    'utf8',
  );
  it.each(['terms', 'privacy'])(
    '%s is a registered, grain-free route',
    (name) => {
      expect(layout).toContain(`<Stack.Screen name="${name}" />`);
      expect(layout).toContain(`path.startsWith('/${name}')`);
    },
  );
});
