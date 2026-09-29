import { describe, expect, it } from 'vitest';
import type { Citation } from '@/lib/api';
import { footnoteLabel, groupFootnotes } from '@/lib/footnote-groups';

const cite = (marker: number, sourceType: string, reference: string, extra: Partial<Citation> = {}): Citation => ({
  id: `c-${marker}`,
  marker,
  sourceType: sourceType as Citation['sourceType'],
  reference,
  sourceTitle: '',
  translationText: '',
  ...extra,
});

describe('groupFootnotes', () => {
  it("orders groups Qur'an, hadith, scholarly, and each group by marker", () => {
    const groups = groupFootnotes([
      cite(3, 'scholarly', 'Tafsir Encyclopedia, Volume 3, Page 12'),
      cite(4, 'hadith', 'AbuDaud 135'),
      cite(1, 'hadith', 'IbnMaja 397'),
      cite(2, 'quran', "Qur'an 5:6"),
    ]);
    expect(groups.map((g) => [g.label, g.citations.map((c) => c.marker)])).toEqual([
      ["Qur'an", [2]],
      ['Hadith', [1, 4]],
      ['Scholarly works', [3]],
    ]);
  });

  it('leaves out empty groups and puts an unknown kind last', () => {
    const groups = groupFootnotes([cite(1, 'fatwa', 'Some fatwa'), cite(2, 'quran', "Qur'an 2:222")]);
    expect(groups.map((g) => g.kind)).toEqual(['quran', 'other']);
  });

  it('is empty for no citations', () => {
    expect(groupFootnotes([])).toEqual([]);
  });
});

describe('footnoteLabel', () => {
  it("drops the Qur'an prefix the heading already says", () => {
    expect(footnoteLabel(cite(1, 'quran', "Qur'an 5:6"))).toEqual({ reference: '5:6' });
  });

  it('gives a hadith its grade, not its chapter', () => {
    expect(
      footnoteLabel(cite(1, 'hadith', 'AbuDaud 101', { sourceTitle: 'Purification · Grade: Sahih', grade: 'Sahih' })),
    ).toEqual({ reference: 'AbuDaud 101', detail: 'Sahih' });
  });

  it('counts the rest of a multi-graded hadith', () => {
    expect(
      footnoteLabel(cite(1, 'hadith', 'AbuDaud 61', { grade: 'Sahih', grades: ['Sahih', 'Sahih Mauquf', 'Daif'] })),
    ).toEqual({ reference: 'AbuDaud 61', detail: 'Sahih (+2 more)' });
  });

  it('shows an ungraded hadith and a scholarly work by reference alone', () => {
    expect(footnoteLabel(cite(1, 'hadith', 'AbuDaud 135'))).toEqual({ reference: 'AbuDaud 135' });
    expect(footnoteLabel(cite(2, 'scholarly', 'Tafsir Encyclopedia, Volume 3, Page 12'))).toEqual({
      reference: 'Tafsir Encyclopedia, Volume 3, Page 12',
    });
  });
});
