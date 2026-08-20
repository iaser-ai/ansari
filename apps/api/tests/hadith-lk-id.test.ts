import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SearchHadith } from '../lib/tools/search-hadith';
import { FACILITATOR_SYSTEM_PROMPT } from '../lib/ai/prompts/facilitator';

// Regression tests for issue #84: the frontend linkifies the literal token
// "LK id <collection>_<chapter>_<section>_<hadith>" in answers, but the backend
// never surfaced hadith.id (the LK id) to the model, so the feature was dead.

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

function okJson(body: unknown) {
  return { ok: true, status: 200, statusText: 'OK', json: async () => body };
}

const HADITH_RESULT = {
  id: '2_38_5_5524',
  source_book: 'Sahih Bukhari',
  chapter_number: '2',
  chapter_english: 'Belief',
  section_number: '1',
  section_english: 'Faith',
  hadith_number: '8',
  en_text: 'Islam is based on five...',
  ar_text: 'بُنِيَ الإسلام',
  grade_en: 'Sahih',
};

describe('SearchHadith LK id (issue #84)', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('includes the LK id token in the document title', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(okJson([HADITH_RESULT])) as unknown as typeof fetch;

    const result = await new SearchHadith().run('faith');

    expect(result.documents).toHaveLength(1);
    expect(result.documents[0].title).toContain('(LK id 2_38_5_5524)');
  });

  it('includes lk_id in the document content JSON', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(okJson([HADITH_RESULT])) as unknown as typeof fetch;

    const result = await new SearchHadith().run('faith');

    const content = JSON.parse(result.documents[0].source.data);
    expect(content.lk_id).toBe('2_38_5_5524');
  });

  it('keeps the LK id intact even when the title exceeds the trim limit', async () => {
    const longResult = {
      ...HADITH_RESULT,
      chapter_english:
        'A very long chapter name that pushes the citation title well past the one hundred character truncation threshold',
    };
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(okJson([longResult])) as unknown as typeof fetch;

    const result = await new SearchHadith().run('faith');

    const title = result.documents[0].title;
    // The base title gets truncated ("...") but the LK id must survive at the end.
    expect(title).toContain('...');
    expect(title.endsWith('(LK id 2_38_5_5524)')).toBe(true);
  });
});

describe('Facilitator prompt LK id citation format (issue #84)', () => {
  it('citation example includes the LK id token', () => {
    // The example format is load-bearing: the model mirrors it verbatim.
    expect(FACILITATOR_SYSTEM_PROMPT).toContain(
      '[1] Sahih Bukhari - Book of Revelation, Hadith 1 (LK id 1_1_1_1)'
    );
  });

  it('instructs the model to include the LK id verbatim in hadith citations', () => {
    expect(FACILITATOR_SYSTEM_PROMPT).toMatch(/LK id token .* verbatim/i);
  });
});
