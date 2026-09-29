import { describe, it, expect, vi } from 'vitest';

/**
 * deriveCitableDocuments (spec 168) — the pure rule that turns stored tool
 * records into citable documents. Table-driven over hand-built records.
 */

// The module imports the db singleton; the pure function never touches it.
vi.mock('@/lib/db/index', () => ({ db: {} }));

import { deriveCitableDocuments, type RejectReason } from '@/lib/db/citable-documents';
import type { DocumentContentBlock } from '@/db/schema/messages';

type Entry = { title: string; context?: string; content: string };

let seq = 0;
function use(name = 'search_quran') {
  seq++;
  return { type: 'tool_use', id: `tool_${seq}`, name, input: { query: 'q' } };
}
function result(entries: Entry[], citations: unknown, extra: Record<string, unknown> = {}) {
  return {
    type: 'tool_result',
    tool_use_id: `tool_${seq}`,
    content: { results: entries, summary: 's' },
    status: 'ok',
    duration_ms: 1,
    ...(citations === undefined ? {} : { citations }),
    ...extra,
  };
}
const on = { enabled: true };
const off = { enabled: false };

const V1: Entry = { title: 'Quran 2:153', context: 'Retrieved from the Holy Quran', content: 'verse one' };
const V2: Entry = { title: 'Quran 2:155', context: 'Retrieved from the Holy Quran', content: 'verse two' };
const H1: Entry = { title: 'Sahih Muslim, Hadith 2999', context: 'Retrieved from hadith collections', content: 'hadith' };
const NO_RESULTS: Entry = { title: 'No Results', context: 'Quran Search', content: 'No results found.' };

const doc = (e: Entry): DocumentContentBlock => ({
  type: 'document',
  source: { type: 'text', media_type: 'text/plain', data: e.content },
  title: e.title,
  ...(e.context !== undefined ? { context: e.context } : {}),
});

describe('deriveCitableDocuments: selection and order', () => {
  it('derives real hits in dispatch order across records and rounds', () => {
    const tc = [use(), result([V1, V2], [on, on]), use('search_hadith'), result([H1], [on])];
    expect(deriveCitableDocuments(tc)).toEqual({ documents: [doc(V1), doc(V2), doc(H1)], rejected: [] });
  });

  it('keeps only entries flagged citable within a mixed record', () => {
    const tc = [use(), result([V1, NO_RESULTS, V2], [on, off, on])];
    expect(deriveCitableDocuments(tc).documents).toEqual([doc(V1), doc(V2)]);
  });

  it('status-independence: a zero-result notice under status ok is excluded by its flag', () => {
    const tc = [use(), result([V1], [on]), use('search_tafsir'), result([NO_RESULTS], [off])];
    // A status-based rule would admit the notice — both records are 'ok'.
    const statusRule = tc.filter((r) => r.type === 'tool_result' && r.status === 'ok').flatMap(
      (r) => (r as { content: { results: Entry[] } }).content.results
    );
    expect(statusRule).toContainEqual(NO_RESULTS);
    // The flag-based rule does not.
    expect(deriveCitableDocuments(tc).documents).toEqual([doc(V1)]);
  });

  it.each([
    ['degraded', { title: 'Source Temporarily Unavailable', context: 'Quran', content: 'The Quran source is temporarily unavailable.' }, 'degraded'],
    ['tool limit', { title: 'Tool Limit Notice', context: 'System', content: 'Tool usage limit reached.' }, 'limit_refused'],
    ['unknown tool', { title: 'Error', context: 'System', content: 'Unknown tool: nope' }, 'unknown_tool'],
    ['no results', NO_RESULTS, 'ok'],
  ] as const)('a %s notice is never a document', (_kind, notice, status) => {
    const tc = [use(), result([notice], [off], { status })];
    expect(deriveCitableDocuments(tc)).toEqual({ documents: [], rejected: [] });
  });

  it('a budget-skipped record (no results, citations []) contributes nothing', () => {
    const tc = [use(), result([], [], { status: 'budget_skipped', duration_ms: null, skip_trigger: 'T1' })];
    expect(deriveCitableDocuments(tc)).toEqual({ documents: [], rejected: [] });
  });

  it('ignores tool_use records entirely', () => {
    expect(deriveCitableDocuments([use(), use()])).toEqual({ documents: [], rejected: [] });
  });
});

describe('deriveCitableDocuments: dedup and context', () => {
  it('collapses duplicates on (title, context, text), first occurrence kept in place', () => {
    const tc = [use(), result([V1, V2], [on, on]), use(), result([H1, V1], [on, on])];
    expect(deriveCitableDocuments(tc).documents).toEqual([doc(V1), doc(V2), doc(H1)]);
  });

  it('documents differing only in context are both kept', () => {
    const other = { ...V1, context: 'Other context' };
    const tc = [use(), result([V1, other], [on, on])];
    expect(deriveCitableDocuments(tc).documents).toEqual([doc(V1), doc(other)]);
  });

  it('absent context vs present context are distinct, and absent context is omitted from the output', () => {
    const bare: Entry = { title: V1.title, content: V1.content };
    const tc = [use(), result([bare, V1], [on, on])];
    const { documents } = deriveCitableDocuments(tc);
    expect(documents).toEqual([doc(bare), doc(V1)]);
    expect(documents[0]).not.toHaveProperty('context');
    expect(Object.keys(documents[0])).toEqual(['type', 'source', 'title']);
  });
});

describe('deriveCitableDocuments: fail closed, never throw', () => {
  const good = () => [use(), result([V1], [on])];

  it.each<[string, unknown[], RejectReason]>([
    ['legacy record (no citations)', [use(), result([V2], undefined)], 'no_citations'],
    ['misaligned citations', [use(), result([V2, H1], [on])], 'length_mismatch'],
    ['citations not an array', [use(), result([V2], { enabled: true })], 'bad_citations'],
    ['citations element without boolean enabled', [use(), result([V2], [{ enabled: 'yes' }])], 'bad_citations'],
    ['content missing', [{ type: 'tool_result', citations: [on] }], 'bad_content'],
    ['content not an object', [{ type: 'tool_result', content: 'str', citations: [on] }], 'bad_content'],
    ['results not an array', [{ type: 'tool_result', content: { results: {} }, citations: [on] }], 'bad_results'],
    ['entry with non-string title', [use(), result([{ ...V2, title: 7 } as unknown as Entry], [on])], 'bad_entry'],
    ['entry with non-string content', [use(), result([{ ...V2, content: null } as unknown as Entry], [on])], 'bad_entry'],
    ['entry with non-string context', [use(), result([{ ...V2, context: 3 } as unknown as Entry], [on])], 'bad_entry'],
    ['non-object record', ['garbage'], 'bad_record'],
  ])('%s: that record yields nothing, a well-formed sibling still derives', (_name, bad, reason) => {
    const tc = [...bad, ...good()];
    let out!: ReturnType<typeof deriveCitableDocuments>;
    expect(() => {
      out = deriveCitableDocuments(tc);
    }).not.toThrow();
    expect(out.documents).toEqual([doc(V1)]);
    expect(out.rejected).toEqual([reason]);
  });

  it.each([null, undefined, 'str', 42, { a: 1 }])('non-array tool_calls (%s) → nothing, not_array', (tc) => {
    expect(deriveCitableDocuments(tc)).toEqual({ documents: [], rejected: ['not_array'] });
  });

  it('a record with any bad entry contributes nothing, even its good entries', () => {
    const tc = [use(), result([V1, { ...V2, title: 1 } as unknown as Entry], [on, on])];
    expect(deriveCitableDocuments(tc)).toEqual({ documents: [], rejected: ['bad_entry'] });
  });

  it('rejected carries only reason codes, never record text', () => {
    const tc = [use(), result([{ ...V2, title: 'SENTINEL-TEXT', context: 99 } as unknown as Entry], [on])];
    const { rejected } = deriveCitableDocuments(tc);
    expect(JSON.stringify(rejected)).not.toContain('SENTINEL');
  });
});

// No expectTypeOf here: tsconfig excludes tests/**, so a type-level assertion
// would never be checked. The output TYPE is pinned by the function's declared
// return type (DocumentContentBlock[]), which tsc checks in lib/; this suite
// pins the runtime keys.
describe('output shape', () => {
  it('runtime output carries no record keys', () => {
    const [d] = deriveCitableDocuments([use(), result([V1], [on])]).documents;
    expect(Object.keys(d).sort()).toEqual(['context', 'source', 'title', 'type']);
    expect(Object.keys(d.source).sort()).toEqual(['data', 'media_type', 'type']);
  });
});
