/**
 * Regression tests from the first credentialed run (2026-11-15). Until then the scorers
 * had only seen fixtures I wrote; real answers quote tafsir in Arabic, put verse fragments
 * inside tafsir and hadith citations, and write `﴿verse﴾ الآية`. Every case here was
 * scored as a failed Quran quote and is not one. Each is paired with the near-miss that
 * must still fail, so the correction cannot quietly pass a real misquote.
 *
 * The verse and tafsir texts are the ones the search tools returned in that run.
 */
import { describe, it, expect } from 'vitest';
import { scoreLanguage } from '../../eval/lib/score-language';
import { HARD_FAIL, scoreQuran, type QuranInput } from '../../eval/lib/score-quran';
import { VERSES } from './fixtures';

const V_49_13 = "يَـٰٓأَيُّهَا ٱلنَّاسُ إِنَّا خَلَقْنَـٰكُم مِّن ذَكَرٍۢ وَأُنثَىٰ وَجَعَلْنَـٰكُمْ شُعُوبًا وَقَبَآئِلَ لِتَعَارَفُوٓا ۚ إِنَّ أَكْرَمَكُمْ عِندَ ٱللَّهِ أَتْقَىٰكُمْ ۚ إِنَّ ٱللَّهَ عَلِيمٌ خَبِيرٌ";
const V_2_286 = "لَا يُكَلِّفُ ٱللَّهُ نَفْسًا إِلَّا وُسْعَهَا ۚ لَهَا مَا كَسَبَتْ وَعَلَيْهَا مَا ٱكْتَسَبَتْ ۗ رَبَّنَا لَا تُؤَاخِذْنَآ إِن نَّسِينَآ أَوْ أَخْطَأْنَا ۚ رَبَّنَا وَلَا تَحْمِلْ عَلَيْنَآ إِصْرًا كَمَا حَمَلْتَهُۥ عَلَى ٱلَّذِينَ مِن قَبْلِنَا ۚ رَبَّنَا وَلَا تُحَمِّلْنَا مَا لَا طَاقَةَ لَنَا بِهِۦ ۖ وَٱعْفُ عَنَّا وَٱغْفِرْ لَنَا وَٱرْحَمْنَآ ۚ أَنتَ مَوْلَىٰنَا فَٱنصُرْنَا عَلَى ٱلْقَوْمِ ٱلْكَـٰفِرِينَ";
const V_2_284 = "لِّلَّهِ مَا فِى ٱلسَّمَـٰوَٰتِ وَمَا فِى ٱلْأَرْضِ ۗ وَإِن تُبْدُوا مَا فِىٓ أَنفُسِكُمْ أَوْ تُخْفُوهُ يُحَاسِبْكُم بِهِ ٱللَّهُ ۖ فَيَغْفِرُ لِمَن يَشَآءُ وَيُعَذِّبُ مَن يَشَآءُ ۗ وَٱللَّهُ عَلَىٰ كُلِّ شَىْءٍۢ قَدِيرٌ";
/** What search_tafsir_encyclopedia returned, cut short. */
const TAFSIR_2_286 = "(ز)﴿لا يكلف الله نفسا إلا وسعها﴾\n\n١١٦٩٥ - عن عبد الله بن عباس -من طريق علي بن أبي طلحة- في قوله: ﴿لا يكلف الله نفسا إلا وسعها﴾، قال: هم المؤمنون، وسع الله عليهم أمر دينهم، فقال: ﴿وما جعل عليكم في الدين من حرج﴾[الحج: ٧٨]";
const TAFSIR_49_13 = "قال ابن عطية: قوله تعالى: ﴿من ذكر وأنثى﴾ يحتمل أن يريد: آدم وحواء. فكأنه قال: إنا خلقنا جميعكم من آدم وحواء. ويحتمل أن يريد: الذكر والأنثى اسم الجنس.";

function input(answer: string, over: Partial<QuranInput> = {}): QuranInput {
  return { answer, thisTurn: [], earlierTurns: [], lookups: {}, hadith: [], ...over };
}
const outcomes = (i: QuranInput) => scoreQuran(i).quotes.map((q) => q.outcome);
const hardFails = (i: QuranInput) => scoreQuran(i).quotes.filter((q) => HARD_FAIL.has(q.outcome));

/** A tafsir citation, as gemini-4-argon wrote it: Arabic tafsir, a verse fragment in ﴿ ﴾, and an English line that names another verse. */
const TAFSIR_ENTRY_ANSWER = `Allah relieved the believers of what is beyond their capacity [1], as Ibn Abbas explained [2].

**Citations**:
[1] Quran 2:286
    Arabic: ${V_2_286}
    English: Allah does not require of any soul more than what it can afford.

[2] Tafsir Encyclopedia, Volume 4, Page 731
    Arabic: عن عبد الله بن عباس -من طريق علي بن أبي طلحة- في قوله: ﴿لا يكلف الله نفسا إلا وسعها﴾، قال: هم المؤمنون، وسع الله عليهم أمر دينهم
    English: When [2:284] was revealed, the believers were distressed. So Jibril came with this verse.`;

describe('Arabic from a tafsir is not a Quran quote', () => {
  const sources = { thisTurn: [{ key: '2:286', ar: V_2_286 }], lookups: { '2:284': { ar: V_2_284 } } };

  it('a tafsir citation entry: its Arabic is the tafsir, and the verse named in its English line is not its label', () => {
    const score = scoreQuran(input(TAFSIR_ENTRY_ANSWER, { ...sources, otherTexts: [TAFSIR_2_286] }));
    expect(score.counts).toMatchObject({ exact: 1, mismatch: 0, wrong_reference: 0, suspect: 0, unlabelled: 0 });
    expect(score.counts.other_source).toBe(score.quotes.length - 1);
    expect(score.counts.other_source).toBeGreaterThanOrEqual(3);
    expect(score.quranQuotes).toBe(1);
    expect(score.fromMemory).toBe(0);
  });

  it('the same entry when the tafsir text is not in hand: still no failed quote, and the verse inside it is read as a verse', () => {
    const score = scoreQuran(input(TAFSIR_ENTRY_ANSWER, sources));
    expect(score.quotes.filter((q) => HARD_FAIL.has(q.outcome))).toEqual([]);
    expect(score.counts).toMatchObject({ exact: 1, unlabelled: 1, suspect: 0 });
    expect(score.quotes.find((q) => q.outcome === 'unlabelled')).toMatchObject({ text: 'لا يكلف الله نفسا إلا وسعها', matched: ['2:286'] });
    expect(score.counts.other_source).toBe(score.quotes.length - 2);
  });

  it('known-bad: a Quran citation entry with one wrong word still fails', () => {
    const answer = `Be patient [1].

**Citations**:
[1] Quran 68:48
    Arabic: فَاصْبِرْ لِحُكْمِ رَبِّكَ وَلَا تَكُن كَصَاحِبِ الْحُوتِ إِذْ نَادَىٰ وَهُوَ مَغْمُومٌ
    English: So be patient.`;
    const failed = hardFails(input(answer, { thisTurn: [{ key: '68:48', ar: VERSES['68:48'] }] }));
    expect(failed.map((q) => q.outcome)).toEqual(['mismatch']);
    expect(failed[0].labels).toEqual(['68:48']);
  });

  it('known-bad: a Quran citation entry headed 68:48 that holds the text of 52:48 is a wrong reference', () => {
    const answer = `Be patient [1].

**Citations**:
[1] Quran 68:48
    Arabic: ${VERSES['52:48']}
    English: So be patient.`;
    const both = [{ key: '68:48', ar: VERSES['68:48'] }, { key: '52:48', ar: VERSES['52:48'] }];
    expect(hardFails(input(answer, { thisTurn: both })).map((q) => q.outcome)).toEqual(['wrong_reference']);
  });

  it('tafsir Arabic in the prose that resembles a verse: set aside when the tafsir is in hand, read by a person when it is not', () => {
    const answer = 'Ibn Atiyyah said of this verse: ويحتمل أن يريد الذكر والأنثى اسم الجنس. That is, the two sexes.';
    const verses = { thisTurn: [{ key: '49:13', ar: V_49_13 }, { key: '53:45', ar: 'وَأَنَّهُۥ خَلَقَ ٱلزَّوْجَيْنِ ٱلذَّكَرَ وَٱلْأُنثَىٰ' }] };
    expect(outcomes(input(answer, { ...verses, otherTexts: [TAFSIR_49_13] }))).toEqual(['other_source']);
    const alone = outcomes(input(answer, verses));
    expect(alone).toHaveLength(1);
    expect(['suspect', 'unattributed']).toContain(alone[0]);
  });
});

describe('a verse between ﴿ ﴾ is read without the word after the bracket', () => {
  const sources = { thisTurn: [{ key: '49:13', ar: V_49_13 }] };

  it('`﴿verse﴾ الآية` on a line that names the verse is a correct quote', () => {
    const answer = 'The Prophet recited (49:13): ﴿يا أيها الناس إنا خلقناكم من ذكر وأنثى﴾ الآية';
    const score = scoreQuran(input(answer, sources));
    expect(score.quotes.map((q) => [q.outcome, q.text])).toEqual([['standard', 'يا أيها الناس إنا خلقناكم من ذكر وأنثى']]);
  });

  it('known-bad: a wrong word inside the brackets still fails', () => {
    const answer = 'The Prophet recited (49:13): ﴿يا أيها الناس إنا خلقناكم من ذكر وأنثى وجعلناكم أمما وقبائل﴾ الآية';
    const failed = hardFails(input(answer, sources));
    expect(failed.map((q) => q.outcome)).toEqual(['mismatch']);
    expect(failed[0].diff?.extra).toContain('ءمما');
  });
});

describe('a wrong reference needs the reference on the quote’s own line', () => {
  const sources = { thisTurn: [{ key: '2:286', ar: V_2_286 }], lookups: { '2:284': { ar: V_2_284 } } };

  it('a paragraph that names one verse and quotes another on a different line is for a person to read', () => {
    const answer = `When verse 2:284 was revealed the Companions were distressed.
Then Allah revealed:
﴿لا يكلف الله نفسا إلا وسعها﴾`;
    expect(outcomes(input(answer, sources))).toEqual(['suspect']);
  });

  it('known-bad: the reference on the same line as another verse’s text is a wrong reference', () => {
    const answer = 'Quran 2:284: ﴿لا يكلف الله نفسا إلا وسعها﴾';
    expect(outcomes(input(answer, sources))).toEqual(['wrong_reference']);
  });
});

describe('grounding: a verse quoted from a tafsir or hadith result was not written from memory', () => {
  const answer = 'Allah says (2:286): ﴿لا يكلف الله نفسا إلا وسعها﴾';
  const lookedUp = { lookups: { '2:286': { ar: V_2_286 } } };

  it('no search returned the verse or its words: from memory', () => {
    const score = scoreQuran(input(answer, lookedUp));
    expect(score.quotes[0]).toMatchObject({ outcome: 'exact', grounding: 'none' });
    expect(score.fromMemory).toBe(1);
  });

  it('a tafsir result of this turn holds the words: grounded in this turn', () => {
    const score = scoreQuran(input(answer, { ...lookedUp, otherTexts: [TAFSIR_2_286] }));
    expect(score.quotes[0]).toMatchObject({ outcome: 'exact', grounding: 'this_turn' });
    expect(score.fromMemory).toBe(0);
    expect(score.notFromThisTurn).toBe(0);
  });

  it('a tafsir result of an earlier turn holds the words: grounded in an earlier turn', () => {
    const score = scoreQuran(input(answer, { ...lookedUp, earlierOtherTexts: [TAFSIR_2_286] }));
    expect(score.quotes[0].grounding).toBe('earlier_turn');
    expect(score.notFromThisTurn).toBe(1);
  });
});

describe('language of a short answer', () => {
  /** gemini-4-hydrogen, question ref-sharh-5-6: read as undetermined, though it is English. */
  const SHORT_ENGLISH = `In Surah Ash-Sharh (Chapter 94), Allah says:

**Quran 94:5** [1]
**Arabic:** فَإِنَّ مَعَ ٱلْعُسْرِ يُسْرًا
**Translation:** "So, surely with hardship comes ease."

**Quran 94:6** [2]
**Arabic:** إِنَّ مَعَ ٱلْعُسْرِ يُسْرًا
**Translation:** "Surely with ˹that˺ hardship comes ˹more˺ ease."`;

  it('a verse and its translation is in English', () => {
    expect(scoreLanguage(SHORT_ENGLISH, 'en')).toMatchObject({ detected: 'en', inLanguage: true });
  });

  it('known-bad: the same short answer in French fails an English question', () => {
    const french = `Dans la sourate Ash-Sharh, Allah dit :

**Arabe :** فَإِنَّ مَعَ ٱلْعُسْرِ يُسْرًا
**Traduction :** « Certes, avec la difficulté est la facilité. »`;
    expect(scoreLanguage(french, 'en')).toMatchObject({ detected: 'fr', inLanguage: false });
    expect(scoreLanguage(french, 'fr').inLanguage).toBe(true);
  });

  it('one stray function word does not name a language', () => {
    expect(scoreLanguage('Sabr. Tawakkul. Shukr the', 'en')).toMatchObject({ detected: 'latin-script', inLanguage: false });
  });
});

describe('an Urdu translation of a verse is not the verse', () => {
  const V_4_101 = 'وَإِذَا ضَرَبْتُمْ فِى ٱلْأَرْضِ فَلَيْسَ عَلَيْكُمْ جُنَاحٌ أَن تَقْصُرُوا۟ مِنَ ٱلصَّلَوٰةِ إِنْ خِفْتُمْ أَن يَفْتِنَكُمُ ٱلَّذِينَ كَفَرُوٓا۟';
  const sources = { thisTurn: [{ key: '4:101', ar: V_4_101 }] };
  /** gemini-3.7-flash, question ur-fiqh-travel-prayer: the Urdu line was scored as a misquote of 4:101. */
  const urdu = (arabic: string) => `قرآن مجید میں اللہ تعالیٰ کا ارشاد ہے (4:101):
> **﴿${arabic}﴾**
> *"اور جب تم زمین میں سفر کرو تو تم پر اس بات میں کوئی گناہ نہیں کہ نماز مختصر کر کے پڑھو۔"* (4:101)`;

  it('the Arabic is scored, the Urdu under it is left out', () => {
    const score = scoreQuran(input(urdu('وَإِذَا ضَرَبْتُمْ فِى ٱلْأَرْضِ فَلَيْسَ عَلَيْكُمْ جُنَاحٌ أَن تَقْصُرُوا مِنَ ٱلصَّلَوٰةِ'), sources));
    expect(score.quotes.map((q) => q.outcome)).toEqual(['exact']);
    expect(score.proseRunsSkipped).toBeGreaterThanOrEqual(1);
  });

  it('known-bad: a wrong word in the Arabic of an Urdu answer still fails', () => {
    const failed = hardFails(input(urdu('وَإِذَا ضَرَبْتُمْ فِى ٱلْأَرْضِ فَلَيْسَ عَلَيْكُمْ إِثْمٌ أَن تَقْصُرُوا مِنَ ٱلصَّلَوٰةِ'), sources));
    expect(failed.map((q) => q.outcome)).toEqual(['mismatch']);
    expect(failed[0].diff?.extra).toEqual(['ءثم']);
  });
});

describe('a misquote of a verse that a retrieved hadith or tafsir also cites still fails', () => {
  // Found by corrupting real answers (eval/selfcheck.ts): the corrupted verse shared most
  // of its letters with the tafsir or hadith that cites the verse, and was set aside as
  // that source's text.
  const verseInHand = { thisTurn: [{ key: '2:286', ar: V_2_286 }] };
  const HADITH_CITING_2_286 = {
    lkId: '2_1_57_328',
    ar: 'فَأَنْزَلَ اللَّهُ عَزَّ وَجَلَّ لاَ يُكَلِّفُ اللَّهُ نَفْسًا إِلاَّ وُسْعَهَا لَهَا مَا كَسَبَتْ وَعَلَيْهَا مَا اكْتَسَبَتْ رَبَّنَا لاَ تُؤَاخِذْنَا إِنْ نَسِينَا أَوْ أَخْطَأْنَا قَالَ نَعَمْ',
    en: '',
    grade: 'Sahih',
    collection: 'Muslim',
  };
  const swapped = 'Allah says (2:286): ﴿لا يكلف الله نفسا إلا وسعها لها ما كسبت وعليها اكتسبت ما﴾';

  it('with a hadith in hand that cites the verse', () => {
    expect(outcomes(input(swapped, { ...verseInHand, hadith: [HADITH_CITING_2_286] }))).toEqual(['mismatch']);
  });

  it('with a tafsir in hand that cites the verse', () => {
    const tafsir = 'عن قتادة قوله: ﴿لا يكلف الله نفسا إلا وسعها لها ما كسبت﴾ أي: من خير، ﴿وعليها ما اكتسبت﴾ أي: من شر';
    expect(outcomes(input(swapped, { ...verseInHand, otherTexts: [tafsir] }))).toEqual(['mismatch']);
  });

  it('near-miss: the hadith quoted word for word beside the same reference is hadith text', () => {
    const answer = 'On this verse (2:286) the hadith says: فَأَنْزَلَ اللَّهُ عَزَّ وَجَلَّ لاَ يُكَلِّفُ اللَّهُ نَفْسًا إِلاَّ وُسْعَهَا';
    expect(hardFails(input(answer, { ...verseInHand, hadith: [HADITH_CITING_2_286] }))).toEqual([]);
  });
});

describe('a reference in the next sentence is not the quote’s label', () => {
  const V_2_62 = 'إِنَّ ٱلَّذِينَ ءَامَنُوا۟ وَٱلَّذِينَ هَادُوا۟ وَٱلنَّصَـٰرَىٰ وَٱلصَّـٰبِـِٔينَ مَنْ ءَامَنَ بِٱللَّهِ وَٱلْيَوْمِ ٱلْـَٔاخِرِ';
  const V_5_69 = 'إِنَّ ٱلَّذِينَ ءَامَنُوا۟ وَٱلَّذِينَ هَادُوا۟ وَٱلصَّـٰبِـُٔونَ وَٱلنَّصَـٰرَىٰ مَنْ ءَامَنَ بِٱللَّهِ وَٱلْيَوْمِ ٱلْـَٔاخِرِ';
  const sources = { thisTurn: [{ key: '2:62', ar: V_2_62 }, { key: '5:69', ar: V_5_69 }] };

  it('gemini-4-argon, near-2-62-vs-5-69: the words of 2:62, then a new sentence about 5:69', () => {
    const answer =
      'In `الَّذِينَ آمَنُوا وَالَّذِينَ هَادُوا وَالنَّصَارَىٰ`, none of those words show visible case endings (*harakat zahirah*). In **5:69**, by placing the Sabians first, the Quran highlights a nuance.';
    const score = scoreQuran(input(answer, sources));
    expect(score.quotes.map((q) => q.outcome)).toEqual(['suspect']);
    expect(score.quotes[0].matched).toEqual(['2:62']);
  });

  it('known-bad: the same words with 5:69 in their own sentence are a wrong reference', () => {
    const after = 'The verse reads `الَّذِينَ آمَنُوا وَالَّذِينَ هَادُوا وَالنَّصَارَىٰ` (5:69). It promises a reward.';
    const before = 'Quran 5:69. `الَّذِينَ آمَنُوا وَالَّذِينَ هَادُوا وَالنَّصَارَىٰ`';
    expect(outcomes(input(after, sources))).toEqual(['wrong_reference']);
    expect(outcomes(input(before, sources))).toEqual(['wrong_reference']);
  });
});
