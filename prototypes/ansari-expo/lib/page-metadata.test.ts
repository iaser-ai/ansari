import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// The words a reader sees outside the page itself — the tab strip, a search
// listing, a share card — carry no em-dash (#238). These are source scans:
// the titles live in `<Head>` blocks that only render on the web, and the
// shell's tags are static markup a crawler reads without running the app.

const root = path.resolve(__dirname, '..');
const read = (file: string) => readFileSync(path.join(root, file), 'utf8');

const TITLE_SOURCES = [
  'app/index.tsx',
  'app/about.tsx',
  'app/terms.tsx',
  'app/privacy.tsx',
  'app/chat/[id].tsx',
  'components/AuthForm.tsx',
];

function titleBlocks(source: string): string[] {
  return [...source.matchAll(/<title>([\s\S]*?)<\/title>/g)].map((m) => m[1]);
}

function metaTags(html: string): string[] {
  return [...html.matchAll(/<meta\b[\s\S]*?\/>/g)].map((m) => m[0]);
}

function metaContent(html: string, key: string): string | undefined {
  const tag = metaTags(html).find((t) =>
    new RegExp(`(?:name|property)="${key.replace(/:/g, '\\:')}"`).test(t),
  );
  return tag?.match(/content="([^"]*)"/)?.[1];
}

describe('page titles', () => {
  it.each(TITLE_SOURCES)('%s has a title with no em-dash', (file) => {
    const titles = titleBlocks(read(file));
    expect(titles.length).toBeGreaterThan(0);
    for (const title of titles) expect(title).not.toContain('—');
  });

  it('separates with the middle dot', () => {
    const titles = TITLE_SOURCES.flatMap((f) => titleBlocks(read(f))).join('\n');
    expect(titles).toContain('Ansari · Ask about the Qur&apos;an and Sunnah');
    expect(titles).toContain('${threadTitle} · Ansari');
    expect(titles).toContain("'Log in · Ansari'");
    expect(titles).toContain('Terms of Service · Ansari');
    expect(titles).toContain('Privacy Policy · Ansari');
  });

  it('the scan sees an em-dash when one is there', () => {
    expect(titleBlocks('<title>Log in — Ansari</title>')[0]).toContain('—');
  });

  it('names the web app plainly, without a version number', () => {
    expect(JSON.parse(read('app.json')).expo.name).toBe('Ansari');
  });
});

describe('document shell metadata', () => {
  const html = read('public/index.html');

  it.each([
    'description',
    'og:type',
    'og:title',
    'og:description',
    'og:image',
    'twitter:card',
    'twitter:title',
    'twitter:description',
    'twitter:image',
  ])('declares %s', (key) => {
    expect(metaContent(html, key)).toBeTruthy();
  });

  it('points the share card at the generated image', () => {
    expect(metaContent(html, 'og:image')).toBe('/og-image.png');
    expect(metaContent(html, 'twitter:image')).toBe('/og-image.png');
    expect(metaContent(html, 'twitter:card')).toBe('summary_large_image');
    expect(metaContent(html, 'og:type')).toBe('website');
  });

  it('carries no em-dash in any meta tag or the title', () => {
    for (const tag of metaTags(html)) expect(tag).not.toContain('—');
    expect(titleBlocks(html).join('')).not.toContain('—');
  });

  it('the meta lookup misses a near-miss key', () => {
    expect(metaContent(html, 'og:imagex')).toBeUndefined();
  });
});
