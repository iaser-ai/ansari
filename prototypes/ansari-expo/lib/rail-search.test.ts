import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { railSectionLabel } from './rail-search';

describe('railSectionLabel (issue #235)', () => {
  it('names the full list "Questions" when nothing is searched', () => {
    expect(railSectionLabel('')).toBe('Questions');
  });

  it('ignores a query of only whitespace, as the filter does', () => {
    expect(railSectionLabel('   ')).toBe('Questions');
  });

  it('says "Search results" once a search is active', () => {
    expect(railSectionLabel('wudu')).toBe('Search results');
    expect(railSectionLabel('  wudu ')).toBe('Search results');
  });
});

describe('Sidebar wiring (issue #235)', () => {
  const source = readFileSync(
    path.resolve(__dirname, '../components/Sidebar.tsx'),
    'utf8',
  );

  it('heads the list with the search-aware label, not a fixed string', () => {
    expect(source).toContain('{railSectionLabel(query)}');
    expect(source).not.toMatch(/>\s*Questions\s*</);
  });

  it('gives the rail search field a clear action that empties the query', () => {
    expect(source).toMatch(/onClear=\{\(\) => setQuery\(''\)\}/);
  });
});
