import { describe, it, expect } from 'vitest';
import { createCitableDocumentCollector } from '../lib/facilitator/citable-documents';
import type { DocumentBlock } from '../lib/tools/types';

/**
 * Citable-document collector (issue #66): filter on citations.enabled (fail
 * closed), dedupe on (title, context, data) keeping first position, project to
 * the persisted `document` ContentBlock shape, undefined (never []) when empty.
 */

function doc(
  title: string,
  data: string,
  opts: { context?: string; enabled?: boolean | 'missing' } = {}
): DocumentBlock {
  const d: DocumentBlock = {
    type: 'document',
    source: { type: 'text', media_type: 'text/plain', data },
    title,
  };
  if (opts.context !== undefined) d.context = opts.context;
  if (opts.enabled !== 'missing') d.citations = { enabled: opts.enabled ?? true };
  return d;
}

describe('createCitableDocumentCollector', () => {
  it('returns undefined when nothing was added', () => {
    expect(createCitableDocumentCollector().collected()).toBeUndefined();
  });

  it('returns undefined (not []) when only non-citable documents were added', () => {
    const c = createCitableDocumentCollector();
    c.add([doc('Notice', 'No results', { context: 'System', enabled: false })]);
    c.add([]);
    expect(c.collected()).toBeUndefined();
  });

  it('keeps enabled: true, drops enabled: false and a missing citations flag', () => {
    const c = createCitableDocumentCollector();
    c.add([
      doc('Kept', 'a', { enabled: true }),
      doc('Disabled', 'b', { enabled: false }),
      doc('NoFlag', 'c', { enabled: 'missing' }),
    ]);
    expect(c.collected()!.map((d) => d.title)).toEqual(['Kept']);
  });

  it('projects to exactly type/source/title/context, dropping citations and extra fields', () => {
    const c = createCitableDocumentCollector();
    const withExtra = { ...doc('Al-Fatiha 1:1', 'In the name of Allah', { context: 'Quran' }), extra: 'x' };
    c.add([withExtra as DocumentBlock]);
    const [out] = c.collected()!;
    expect(out).toEqual({
      type: 'document',
      source: { type: 'text', media_type: 'text/plain', data: 'In the name of Allah' },
      title: 'Al-Fatiha 1:1',
      context: 'Quran',
    });
    expect(Object.keys(out).sort()).toEqual(['context', 'source', 'title', 'type']);
    expect(Object.keys(out.source).sort()).toEqual(['data', 'media_type', 'type']);
  });

  it('omits the context key entirely when the source document has none', () => {
    const c = createCitableDocumentCollector();
    c.add([doc('T', 'd')]);
    const [out] = c.collected()!;
    expect('context' in out).toBe(false);
    expect(Object.keys(out).sort()).toEqual(['source', 'title', 'type']);
  });

  it('drops an exact duplicate across calls, keeping the first position', () => {
    const c = createCitableDocumentCollector();
    c.add([doc('A', '1', { context: 'x' }), doc('B', '2', { context: 'x' })]);
    c.add([doc('C', '3', { context: 'x' }), doc('A', '1', { context: 'x' })]);
    expect(c.collected()!.map((d) => d.title)).toEqual(['A', 'B', 'C']);
  });

  it('treats a missing context and context: undefined as the same key', () => {
    const c = createCitableDocumentCollector();
    const explicitUndefined = { ...doc('A', '1'), context: undefined };
    c.add([doc('A', '1'), explicitUndefined]);
    expect(c.collected()).toHaveLength(1);
  });

  it('keeps a near-duplicate that differs in any one of title, context or data', () => {
    const c = createCitableDocumentCollector();
    c.add([
      doc('A', '1', { context: 'x' }),
      doc('A2', '1', { context: 'x' }),
      doc('A', '1', { context: 'y' }),
      doc('A', '1'),
      doc('A', '2', { context: 'x' }),
    ]);
    expect(c.collected()).toHaveLength(5);
  });

  it('is collision-safe where a separator-joined key would not be', () => {
    const c = createCitableDocumentCollector();
    // Joined with '|', both would be "a|b|c|d".
    c.add([doc('a|b', 'd', { context: 'c' }), doc('a', 'd', { context: 'b|c' })]);
    expect(c.collected()).toHaveLength(2);
  });
});
