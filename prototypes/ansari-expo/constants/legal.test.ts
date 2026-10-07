import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  EFFECTIVE_DATE,
  PRIVACY,
  TERMS,
  type LegalBlock,
  type LegalDoc,
  type LegalInline,
} from '@/constants/legal';

// Legal text is reproduced, not written (#241). The fixtures are the two
// documents exactly as they were supplied in the issue — with the one
// change made on instruction at review, the effective date moved from
// 2026-10-07 to 2026-10-06 — and each page's data is read back into the
// same lines and must match them one for one.
//
// Two differences are allowed, and both are spelled out here rather than
// hidden in the comparison: the Privacy Policy's title carries a `# `
// marker the Terms' does not, and the Terms' pointer to the Privacy
// Policy carries an editor's note asking for an in-app link — which is
// what the page has in its place.

const fixture = (name: string) =>
  readFileSync(path.join(__dirname, '__fixtures__', name), 'utf8');

const EDITOR_NOTE =
  ' (link to the in-app Privacy page, not a relative `privacy.md` file)';

function sourceLines(markdown: string): string[] {
  return markdown
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line, i) => (i === 0 ? line.replace(/^# /, '') : line))
    .map((line) => line.replace(EDITOR_NOTE, ''));
}

const spans = (parts: LegalInline[]) =>
  parts
    .map((p) =>
      typeof p === 'string' ? p : p.kind === 'link' ? p.text : p.address,
    )
    .join('');

const blockLines = (block: LegalBlock) =>
  block.type === 'p'
    ? [spans(block.parts)]
    : block.items.map((item) => `- ${spans(item)}`);

function docLines(doc: LegalDoc): string[] {
  return [
    doc.title,
    `Effective Date: ${doc.effectiveDate}`,
    ...doc.preamble.flatMap(blockLines),
    ...doc.sections.flatMap((s) => [
      `## ${s.heading}`,
      ...s.blocks.flatMap(blockLines),
    ]),
  ];
}

describe('legal text is the supplied text, verbatim', () => {
  it.each([
    ['Terms of Service', TERMS, 'terms.md'],
    ['Privacy Policy', PRIVACY, 'privacy.md'],
  ] as const)('%s', (_name, doc, file) => {
    expect(docLines(doc)).toEqual(sourceLines(fixture(file)));
  });

  it('the editor’s note was there to remove, exactly once', () => {
    expect(fixture('terms.md').split(EDITOR_NOTE)).toHaveLength(2);
  });

  it('is in force from 2026-10-06', () => {
    expect(EFFECTIVE_DATE).toBe('2026-10-06');
    expect(fixture('terms.md')).toContain('Effective Date: 2026-10-06');
    expect(fixture('privacy.md')).toContain('Effective Date: 2026-10-06');
  });

  // The comparison is only evidence if it can fail.
  describe('the check catches', () => {
    const terms = () => structuredClone(TERMS);

    it('one changed character', () => {
      const doc = terms();
      const block = doc.sections[2].blocks[0];
      if (block.type !== 'p') throw new Error('expected a paragraph');
      block.parts = [(block.parts[0] as string).replace('18', '13')];
      expect(docLines(doc)).not.toEqual(sourceLines(fixture('terms.md')));
    });

    it('a dropped clause', () => {
      const doc = terms();
      doc.sections[1].blocks.pop();
      expect(docLines(doc)).not.toEqual(sourceLines(fixture('terms.md')));
    });

    it('a list item turned into a paragraph', () => {
      const doc = structuredClone(PRIVACY);
      const list = doc.sections[0].blocks[1];
      if (list.type !== 'list') throw new Error('expected a list');
      doc.sections[0].blocks[1] = { type: 'p', parts: list.items[0] };
      expect(docLines(doc)).not.toEqual(sourceLines(fixture('privacy.md')));
    });
  });
});

describe('the Terms point to the in-app Privacy page', () => {
  it('as a link, not a file', () => {
    const privacy = TERMS.sections.find((s) => s.heading === 'Privacy');
    const parts = privacy?.blocks.flatMap((b) =>
      b.type === 'p' ? b.parts : b.items.flat(),
    );
    expect(parts).toContainEqual({
      kind: 'link',
      href: '/privacy',
      text: 'Privacy Policy',
    });
    expect(JSON.stringify(TERMS)).not.toContain('privacy.md');
  });
});
