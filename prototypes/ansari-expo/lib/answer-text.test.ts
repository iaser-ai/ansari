import { describe, expect, it } from 'vitest';
import type { Citation } from '@/lib/api';
import { answerWithSources } from '@/lib/answer-text';

const cite = (marker: number, sourceType: string, reference: string, extra: Partial<Citation> = {}): Citation => ({
  id: `c-${marker}`,
  marker,
  sourceType: sourceType as Citation['sourceType'],
  reference,
  sourceTitle: '',
  translationText: '',
  ...extra,
});

describe('answerWithSources', () => {
  it('leaves an answer with no sources as it is', () => {
    expect(answerWithSources('Pray on time.', [])).toBe('Pray on time.');
  });

  it('keys every marker to its source, in marker order, after the prose', () => {
    const text = answerWithSources('Pray on time [2], at dawn [1].\n', [
      cite(2, 'hadith', 'Muslim 877', { grade: 'Sahih - Authentic' }),
      cite(1, 'quran', "Qur'an 17:78"),
    ]);
    expect(text).toBe(
      [
        'Pray on time [2], at dawn [1].',
        '',
        'Sources:',
        "[1] Qur'an 17:78",
        '[2] Muslim 877 · Sahih - Authentic',
      ].join('\n'),
    );
  });

  it("keeps the full Qur'an reference the pill abbreviates", () => {
    expect(answerWithSources('x [1]', [cite(1, 'quran', "Qur'an 4:103")])).toContain(
      "[1] Qur'an 4:103",
    );
  });

  it("carries a hadith's first grade and a count of the rest", () => {
    const text = answerWithSources('x [1]', [
      cite(1, 'hadith', 'IbnMaja', {
        grade: 'Hasan - Good',
        grades: ['Hasan - Good', 'Daif - Weak'],
      }),
    ]);
    expect(text).toContain('[1] IbnMaja · Hasan - Good (+1 more)');
  });

  it('names a scholarly source by its reference alone', () => {
    expect(
      answerWithSources('x [1]', [
        cite(1, 'scholarly', 'Riyad as-Salihin', { sourceTitle: 'Book of Prayer' }),
      ]),
    ).toMatch(/\[1\] Riyad as-Salihin$/);
  });
});
