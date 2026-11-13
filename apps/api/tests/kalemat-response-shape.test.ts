import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { SearchQuran } from '../lib/tools/search-quran';
import { SearchHadith } from '../lib/tools/search-hadith';

// Regression tests for issue #383. Kalimat answers /search with a bare array or with an
// envelope `{ results: [...], total_results_num }`. The tools accepted only the array, so
// from 2026-11-05 every search_hadith call in production degraded with `invalid_body`, and
// so did every search_quran call whose query was a verse reference or a surah name.
//
// The fixtures under tests/fixtures/kalemat/ are REAL production responses captured on
// 2026-11-12, cut down to one or two whole items. They are what pins the item field names:
// a hand-written sample is how the tool came to read an `ar_text` that Kalimat does not send.

vi.mock('@sentry/nextjs', () => ({
  captureMessage: vi.fn(),
  captureException: vi.fn(),
}));

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(resolve(__dirname, 'fixtures/kalemat', name), 'utf8'));
}

function serve(body: unknown) {
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => body,
  }) as unknown as typeof fetch;
}

interface HadithItem {
  id: string;
  text: string;
  en_text: string;
}

const HADITH_ENVELOPE = fixture('hadith-envelope.json') as { results: HadithItem[] };
const QURAN_VERSE_REF_ENVELOPE = fixture('quran-verse-ref-envelope.json') as {
  results: Array<{ text: string; en_text: string }>;
};
const QURAN_SURAH_NAME_ENVELOPE = fixture('quran-surah-name-envelope.json');
const QURAN_ARRAY = fixture('quran-array.json') as unknown[];

let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
  process.env.GEMINI_API_KEY = 'test-gemini-key';
  process.env.KALEMAT_API_KEY = 'test-kalemat-key';
  process.env.USUL_API_TOKEN = 'test-usul-token';
  process.env.JWT_SECRET = 'test-secret-key-for-testing-purposes-only-32chars';
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('SearchHadith response shapes (issue #383)', () => {
  it('reads the hadith out of the { results: [...] } envelope production returns', async () => {
    serve(HADITH_ENVELOPE);

    const result = await new SearchHadith().run('patience');

    expect(result.isDegraded).toBeUndefined();
    expect(result.content).toBe('Please see the hadith references below.');
    expect(result.documents.map((d) => d.title)).toEqual([
      "Bukhari - Chapter 23: Funerals (Al-Janaa'iz), Hadith 1302 (Grade: Sahih-Authentic) (LK id 1_23_42_1302)",
      'IbnMaja - Chapter 6: Chapters Regarding Funerals, Hadith 1596 (Grade: Hasan - Good) (LK id 4_6_-1_1596)',
    ]);
    expect(result.documents.every((d) => d.citations?.enabled)).toBe(true);
  });

  it('carries the Arabic and English text of a real item into the document', async () => {
    serve(HADITH_ENVELOPE);

    const result = await new SearchHadith().run('patience');

    const [first] = HADITH_ENVELOPE.results;
    expect(first.text).toMatch(/[؀-ۿ]/);
    expect(first.en_text.length).toBeGreaterThan(0);
    expect(JSON.parse(result.documents[0].source.data)).toEqual({
      ar: first.text,
      en: first.en_text,
      grade: 'Sahih-Authentic',
      collection: 'Bukhari',
      chapter: "Funerals (Al-Janaa'iz)",
      lk_id: '1_23_42_1302',
    });
  });

  it('still reads a bare array of the same items', async () => {
    serve(HADITH_ENVELOPE);
    const fromEnvelope = await new SearchHadith().run('patience');

    serve(HADITH_ENVELOPE.results);
    const fromArray = await new SearchHadith().run('patience');

    expect(fromArray.isDegraded).toBeUndefined();
    expect(fromArray.documents).toHaveLength(2);
    expect(fromArray).toEqual(fromEnvelope);
  });

  it('treats an envelope with no results as "no hadith found", not as a failure', async () => {
    serve({ results: [], total_results_num: 0 });

    const result = await new SearchHadith().run('patience');

    expect(result.isDegraded).toBeUndefined();
    expect(result.content).toMatch(/No hadith found/i);
    expect(result.documents[0].title).toBe('No Results');
  });
});

describe('SearchQuran response shapes (issue #383)', () => {
  it('reads the verse out of the envelope a verse-reference query returns', async () => {
    serve(QURAN_VERSE_REF_ENVELOPE);

    const result = await new SearchQuran().run('2:255');

    expect(result.isDegraded).toBeUndefined();
    expect(result.documents).toHaveLength(1);
    expect(result.documents[0].title).toBe('Quran 2:255');
    expect(result.documents[0].citations?.enabled).toBe(true);
    const [verse] = QURAN_VERSE_REF_ENVELOPE.results;
    expect(verse.text).toMatch(/[؀-ۿ]/);
    expect(JSON.parse(result.documents[0].source.data)).toEqual({
      ar: verse.text,
      en: verse.en_text,
    });
  });

  it('does not degrade on the envelope a surah-name query returns', async () => {
    serve(QURAN_SURAH_NAME_ENVELOPE);

    const result = await new SearchQuran().run('Surah Al-Baqarah');

    expect(result.isDegraded).toBeUndefined();
    expect(result.documents).toHaveLength(1);
    expect(result.documents[0].title).not.toBe('Source Temporarily Unavailable');
  });

  it('still reads the bare array an ordinary query returns', async () => {
    serve(QURAN_ARRAY);

    const result = await new SearchQuran().run('patience');

    expect(result.isDegraded).toBeUndefined();
    expect(result.documents.map((d) => d.title)).toEqual(['Quran 94', 'Quran 2:45']);
  });

  it('treats an envelope with no results as "no verses found", not as a failure', async () => {
    serve({ results: [], total_results_num: 0 });

    const result = await new SearchQuran().run('patience');

    expect(result.isDegraded).toBeUndefined();
    expect(result.content).toMatch(/No Quran verses found/i);
    expect(result.documents[0].title).toBe('No Results');
  });
});

// A 200 that is neither shape must stay a LOUD failure. Each of these would read as an empty
// result under a lenient unwrap (`body.results ?? []`), telling the model the source had
// nothing to say while the degraded counter and Sentry saw nothing.
describe.each([
  ['SearchHadith', () => new SearchHadith(), /No hadith found/i],
  ['SearchQuran', () => new SearchQuran(), /No Quran verses found/i],
] as const)('%s: a body that is neither shape (issue #383)', (_name, makeTool, emptyContentRe) => {
  it.each([
    ['an error object', { error: 'quota exceeded' }],
    ['an envelope without results', { total_results_num: 0 }],
    ['results: null', { results: null, total_results_num: 0 }],
    ['results that is an object', { results: { '0': {} }, total_results_num: 1 }],
    ['results that is a string', { results: 'none' }],
    ['null', null],
    ['a string', 'no results'],
    ['a number', 0],
  ])('degrades with invalid_body on %s', async (_label, body) => {
    serve(body);

    const result = await makeTool().run('patience');

    expect(result.isDegraded).toBe(true);
    expect(result.degradation).toEqual({ errorClass: 'invalid_body', attempts: 1 });
    expect(result.documents[0].title).toBe('Source Temporarily Unavailable');
    expect(result.content).not.toMatch(emptyContentRe);
  });
});
