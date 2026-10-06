import { describe, expect, it } from 'vitest';
import {
  answerDirection,
  isArabicPassageLine,
  splitTrailingReference,
  isMostlyArabic,
  splitArabicRuns,
} from '@/lib/script';

const AYAH = 'قَدْ أَفْلَحَ ٱلْمُؤْمِنُونَ';
const TRANSLATION = 'Successful indeed are the believers.';

describe('isArabicPassageLine', () => {
  it.each([
    ['a bare verse', AYAH],
    ['a verse with a source marker', `${AYAH} [1]`],
    ['a verse with a numeric reference', `${AYAH} (23:1)`],
    ['a verse with a named reference', `${AYAH} (Qur'an 23:1).`],
    ['a verse with an Arabic reference', `${AYAH} (المؤمنون: ١)`],
    ['a verse in bold', `**${AYAH}**`],
    ['a hadith in quotation marks', '«إِنَّمَا الأَعْمَالُ بِالنِّيَّاتِ»'],
    // Arabic-Indic digits and Qur'anic marks are Arabic script but not
    // letters; a verse carrying them is still wholly Arabic.
    ['a verse with its ayah number', 'وَٱلْعَصْرِ ﴿١﴾'],
    ['a verse with a Qur\'anic annotation mark', 'وَلَمْ يَكُن لَّهُۥ كُفُوًا أَحَدٌۢ'],
  ])('is true for %s', (_, line) => {
    expect(isArabicPassageLine(line)).toBe(true);
  });

  it.each([
    ['an English lead-in before a verse', `Allah says: ${AYAH}`],
    ['a translation', TRANSLATION],
    ['transliteration', 'Bismillah ir-Rahman ir-Rahim'],
    ['an empty line', ''],
    ['markers and digits only', '[1] (2:255)'],
    // Only ONE trailing reference is forgiven; Latin anywhere else counts.
    ['Latin before the trailing reference', `${AYAH} — Muslim (1)`],
  ])('is false for %s', (_, line) => {
    expect(isArabicPassageLine(line)).toBe(false);
  });
});

describe('answerDirection', () => {
  it('reads an answer written in Arabic right-to-left', () => {
    expect(
      answerDirection('الخشوع في الصلاة هو حضور القلب.\n\nقال تعالى: ' + AYAH),
    ).toBe('rtl');
  });

  it('reads an answer written in Urdu right-to-left', () => {
    expect(answerDirection('نماز میں خشوع دل کی حاضری ہے۔')).toBe('rtl');
  });

  it('keeps an English answer that quotes verses left-to-right', () => {
    const source = `Khushu' grows from attention.\n\n> ${AYAH}\n> ${TRANSLATION} [1]\n\nKeep at it.`;
    expect(answerDirection(source)).toBe('ltr');
  });

  it('is left-to-right with no letters at all', () => {
    expect(answerDirection('')).toBe('ltr');
    expect(answerDirection('[1] 2:255')).toBe('ltr');
  });
});

describe('isMostlyArabic', () => {
  it('splits at half the letters', () => {
    expect(isMostlyArabic(AYAH)).toBe(true);
    expect(isMostlyArabic(TRANSLATION)).toBe(false);
    expect(isMostlyArabic('')).toBe(false);
  });
});

describe('splitArabicRuns', () => {
  it('keeps the spaces around a run with the sentence', () => {
    expect(splitArabicRuns("Khushu' (خشوع القلب) matters")).toEqual([
      { text: "Khushu' (", arabic: false },
      { text: 'خشوع القلب', arabic: true },
      { text: ') matters', arabic: false },
    ]);
  });

  it('keeps diacritics inside the run', () => {
    expect(splitArabicRuns(AYAH)).toEqual([{ text: AYAH, arabic: true }]);
  });

  it('returns English untouched as one run', () => {
    expect(splitArabicRuns(TRANSLATION)).toEqual([
      { text: TRANSLATION, arabic: false },
    ]);
  });
});

describe('splitTrailingReference', () => {
  it('takes a reference in parentheses off the end of a line', () => {
    expect(splitTrailingReference(`${AYAH} (Qur'an 23:1)`)).toEqual({
      line: AYAH,
      reference: "Qur'an 23:1",
    });
  });

  it('keeps source markers and punctuation that follow the reference', () => {
    expect(splitTrailingReference(`${AYAH} (23:1). [1]`)).toEqual({
      line: `${AYAH}. [1]`,
      reference: '23:1',
    });
  });

  it('leaves a line whose parenthesis is not at the end alone', () => {
    const line = `(${AYAH}) ${AYAH}`;
    expect(splitTrailingReference(line)).toEqual({ line, reference: null });
  });

  it('ignores empty parentheses', () => {
    expect(splitTrailingReference(`${AYAH} ()`)).toEqual({
      line: `${AYAH} ()`,
      reference: null,
    });
  });
});
