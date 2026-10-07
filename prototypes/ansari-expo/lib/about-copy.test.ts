import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// The About page's words carry no em-dash (#241 review). A source scan
// over what a reader sees: the page's JSX with its comments removed, and
// the featured entries it lists.

const root = path.resolve(__dirname, '..');
const read = (file: string) => readFileSync(path.join(root, file), 'utf8');

const stripComments = (source: string) =>
  source
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

describe('About copy', () => {
  it.each(['app/about.tsx', 'constants/featured.ts'])(
    '%s has no em-dash outside comments',
    (file) => {
      expect(stripComments(read(file))).not.toContain('—');
    },
  );

  it('the scan sees an em-dash in copy, and not in a comment', () => {
    expect(stripComments("venue: 'A — podcast',")).toContain('—');
    expect(stripComments('// a note — aside\n/* also — */')).not.toContain('—');
  });
});
