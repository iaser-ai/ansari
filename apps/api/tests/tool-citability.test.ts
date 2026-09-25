import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SearchQuran } from '../lib/tools/search-quran';
import { SearchHadith } from '../lib/tools/search-hadith';
import { SearchMawsuah } from '../lib/tools/search-mawsuah';
import { SearchTafsir } from '../lib/tools/search-tafsir';
import { citabilityOf } from '../lib/tools/types';
import { unavailableResult } from '../lib/tools/resilience';

/**
 * Per-result citability at the tool boundary (spec 168), through the REAL four
 * search tools with fetch stubbed. The load-bearing case is the zero-result
 * search: it is NOT degraded (status 'ok' when recorded) yet its only document
 * is a "No Results" notice — citabilityOf must report it not citable, from the
 * tool's own flag, never from status or wording.
 */

vi.mock('@sentry/nextjs', () => ({
  captureMessage: vi.fn(),
  captureException: vi.fn(),
}));

beforeEach(() => {
  process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
  process.env.JWT_SECRET = 'test-secret-key-for-testing-purposes-only-32chars';
  process.env.GEMINI_API_KEY = 'test-gemini-key';
  process.env.KALEMAT_API_KEY = 'test-kalemat-key';
  process.env.USUL_API_TOKEN = 'test-usul-token';
});

let originalFetch: typeof globalThis.fetch;
beforeEach(() => {
  originalFetch = globalThis.fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function stubFetch(body: unknown) {
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => body,
  }) as unknown as typeof fetch;
}

const QURAN = { id: '2:153', text: 'يَٰٓأَيُّهَا ٱلَّذِينَ', en_text: 'O you who have believed' };
const HADITH = {
  id: 'h1',
  source_book: 'Sahih Muslim',
  chapter_number: '1',
  chapter_english: 'Patience',
  section_number: '1',
  section_english: 'Patience',
  hadith_number: '2999',
  en_text: 'How wonderful is the affair of the believer',
  ar_text: 'عَجَبًا لأَمْرِ الْمُؤْمِنِ',
  grade_en: 'Sahih',
};
const USUL = {
  node: {
    text: 'The ruling on this matter is...',
    metadata: { pages: [{ page: '42', volume: '3' }], chapters: [{ title: 'Kitab al-Sabr' }] },
  },
};

describe.each([
  ['SearchQuran', () => new SearchQuran(), [], [QURAN, QURAN]],
  ['SearchHadith', () => new SearchHadith(), [], [HADITH]],
  ['SearchMawsuah', () => new SearchMawsuah(), { results: [] }, { results: [USUL, USUL] }],
  ['SearchTafsir', () => new SearchTafsir(), { results: [] }, { results: [USUL] }],
] as const)('%s', (_name, makeTool, emptyBody, hitBody) => {
  it('a zero-result search is NOT degraded but its only document is not citable', async () => {
    stubFetch(emptyBody);
    const result = await makeTool().run('patience');
    // Not a degrade: this is recorded as status 'ok' — status cannot tell it apart.
    expect(result.isDegraded).toBeUndefined();
    expect(result.documents).toHaveLength(1);
    expect(citabilityOf(result)).toEqual([{ enabled: false }]);
  });

  it('real hits are citable, one entry per document, in order', async () => {
    stubFetch(hitBody);
    const result = await makeTool().run('patience');
    expect(result.isDegraded).toBeUndefined();
    const n = Array.isArray(hitBody) ? hitBody.length : hitBody.results.length;
    expect(result.documents).toHaveLength(n);
    expect(citabilityOf(result)).toEqual(Array.from({ length: n }, () => ({ enabled: true })));
  });

  it('a degraded source ("temporarily unavailable") is not citable', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      statusText: 'Service Unavailable',
      json: async () => ({}),
    }) as unknown as typeof fetch;
    const result = await makeTool().run('patience');
    expect(result.isDegraded).toBe(true);
    expect(citabilityOf(result)).toEqual([{ enabled: false }]);
  });
});

describe('citabilityOf rule', () => {
  const doc = (citations?: { enabled: boolean }) => ({
    type: 'document' as const,
    source: { type: 'text' as const, media_type: 'text/plain' as const, data: 'x' },
    title: 't',
    ...(citations ? { citations } : {}),
  });

  it('a missing flag is not citable (fail closed)', () => {
    expect(citabilityOf({ content: '', documents: [doc()] })).toEqual([{ enabled: false }]);
  });

  it('mixed documents keep per-entry order', () => {
    expect(
      citabilityOf({ content: '', documents: [doc({ enabled: true }), doc({ enabled: false }), doc({ enabled: true })] })
    ).toEqual([{ enabled: true }, { enabled: false }, { enabled: true }]);
  });

  it('no documents → []', () => {
    expect(citabilityOf({ content: '', documents: [] })).toEqual([]);
  });

  it('the unified unavailable result is not citable', () => {
    expect(citabilityOf(unavailableResult('Quran'))).toEqual([{ enabled: false }]);
  });
});
