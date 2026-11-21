import { describe, it, expect } from 'vitest';
import { normalizeAll, normalizeStandard, normalizeVerbatim, matchLevel } from '../lib/arabic';
import { AYAH_COUNTS, findRefs, formatRef, surahByArabicName, surahByEnglishName } from '../lib/quran-refs';
import { scoreQuran, refsToLookUp, type QuranInput } from '../lib/score-quran';
import {
  VERSES,
  HADITH,
  AYAT_AL_KURSI_STANDARD,
  ANSWER_MISQUOTE_68_48,
  ANSWER_CORRECT_52_48,
  ANSWER_RIGHT_TEXT_WRONG_REF,
  ANSWER_WITH_CITATIONS,
} from './fixtures';

const verse = (key: string) => ({ key, ar: VERSES[key] });
const lookups = (...keys: string[]) => Object.fromEntries(keys.map((k) => [k, { ar: VERSES[k] }]));

function input(answer: string, over: Partial<QuranInput> = {}): QuranInput {
  return { answer, thisTurn: [], earlierTurns: [], lookups: {}, hadith: [], ...over };
}

describe('arabic normalization', () => {
  it('a copy of the source with its marks dropped matches verbatim', () => {
    const bare = 'واصبر لحكم ربك فإنك بأعيننا';
    expect(matchLevel(normalizeAll(bare), normalizeAll(VERSES['52:48']))).toBe('verbatim');
  });

  it('standard spelling of a whole verse matches its Uthmani source at `standard`', () => {
    // السماوات for ٱلسَّمَـٰوَٰتِ, الحي for ٱلْحَىُّ, يئوده for يَـُٔودُهُۥ, إله for إِلَـٰهَ.
    expect(normalizeStandard(AYAT_AL_KURSI_STANDARD)).toBe(normalizeStandard(VERSES['2:255']));
    expect(matchLevel(normalizeAll(AYAT_AL_KURSI_STANDARD), normalizeAll(VERSES['2:255']))).toBe('standard');
  });

  it.each([
    ['ٱلصَّلَوٰةَ', 'الصَّلَاةَ'],
    ['ٱلزَّكَوٰةَ', 'الزَّكَاةَ'],
    ['ٱلْحَيَوٰةِ', 'الْحَيَاةِ'],
    ['ٱلسَّمَـٰوَٰتِ', 'السَّمَاوَاتِ'],
    ['ٱلْكِتَـٰبُ', 'الْكِتَابُ'],
    ['عَلَىٰ', 'عَلَى'],
    ['مُوسَىٰ', 'مُوسَى'],
    ['ٱلتَّوْرَىٰةَ', 'التَّوْرَاةَ'],
    ['يَـٰٓأَيُّهَا', 'يَا أَيُّهَا'],
    ['ءَامَنُوا۟', 'آمَنُوا'],
    ['ٱلْقُرْءَانُ', 'الْقُرْآنُ'],
    ['هَـٰذَا', 'هَذَا'],
    ['ذَٰلِكَ', 'ذَلِكَ'],
    ['أُو۟لَـٰٓئِكَ', 'أُولَئِكَ'],
    ['هَـٰٓؤُلَآءِ', 'هَؤُلَاءِ'],
    ['ٱلرَّحْمَـٰنِ', 'الرَّحْمَنِ'],
    ['ٱلَّيْلِ', 'اللَّيْلِ'],
    ['بِهِۦ', 'بِهِ'],
    ['لَهُۥ', 'لَهُ'],
    ['يُحْىِۦ', 'يُحْيِي'],
    ['شَيْـًٔا', 'شَيْئًا'],
    ['مَسْـُٔولًا', 'مَسْؤُولًا'],
    ['إِبْرَٰهِـۧمَ', 'إِبْرَاهِيمَ'],
  ])('%s and %s are one word at `standard`', (uthmani, standard) => {
    expect(normalizeStandard(uthmani)).toBe(normalizeStandard(standard));
  });

  // The near-misses: a real difference must survive every level.
  it.each([
    ['بِأَعْيُنِنَا', 'بِعَيْنِنَا'],
    ['وَٱصْبِرْ', 'فَٱصْبِرْ'],
    ['يُسْرًا', 'عُسْرًا'],
    ['نَرْزُقُكُمْ وَإِيَّاهُمْ', 'نَرْزُقُهُمْ وَإِيَّاكُمْ'],
  ])('%s and %s stay different at every level', (a, b) => {
    const x = normalizeAll(a);
    const y = normalizeAll(b);
    expect(x.verbatim).not.toBe(y.verbatim);
    expect(x.standard).not.toBe(y.standard);
    expect(x.skeleton).not.toBe(y.skeleton);
  });

  it('`skeleton` is the only level that forgives an alef, which is why it is reported, not passed', () => {
    const x = normalizeAll('قَالَ');
    const y = normalizeAll('قُلْ');
    expect(x.standard).not.toBe(y.standard);
    expect(x.skeleton).toBe(y.skeleton);
  });

  it('`verbatim` does not respell', () => {
    expect(normalizeVerbatim('ٱلصَّلَوٰةَ')).toBe('الصلوة');
    expect(normalizeVerbatim('الصَّلَاةَ')).toBe('الصلاة');
  });
});

describe('quran references', () => {
  it('the ayah counts add up to the Quran', () => {
    expect(AYAH_COUNTS).toHaveLength(114);
    expect(AYAH_COUNTS.reduce((a, b) => a + b, 0)).toBe(6236);
  });

  it('every surah has an Arabic and an English name that resolve to it', () => {
    expect(surahByArabicName('الطور')).toBe(52);
    expect(surahByArabicName('القلم')).toBe(68);
    expect(surahByArabicName('آل عمران')).toBe(3);
    expect(surahByArabicName('الإسراء')).toBe(17);
    expect(surahByEnglishName('At-Tur')).toBe(52);
    expect(surahByEnglishName('Aṭ-Ṭūr')).toBe(52);
    expect(surahByEnglishName('al-Baqara')).toBe(2);
    expect(surahByEnglishName('Al-Baqarah')).toBe(2);
    expect(surahByEnglishName('An-Nisa')).toBe(4);
    expect(surahByEnglishName('Nowhere')).toBeNull();
  });

  const refs = (text: string) => findRefs(text).map(formatRef);

  it.each([
    ['(Quran 52:48)', ['52:48']],
    ['Surah Ash-Sharh (94:5-6)', ['94:5-6']],
    ['[الطور: 48]', ['52:48']],
    ['[الطور: ٤٨]', ['52:48']],
    ['سورة البقرة، الآية 255', ['2:255']],
    ['(سورة المؤمنون: 1-3)', ['23:1-3']],
    ['Surah At-Tur, verse 48', ['52:48']],
    ['Sourate Al-Baqara, verset 255', ['2:255']],
    ['Surah Ash-Sharh (94), Verse 6', ['94:6']],
    ['Surah Al-Baqarah: 255', ['2:255']],
    ['QS. Al-Baqarah [2]: 153', ['2:153']],
    ['سورۃ البقرہ: 153', ['2:153']],
    ['Surah At-Tur (52:48)', ['52:48']],
    ['see 2:153 and 2:45', ['2:153', '2:45']],
    ['٢:٢٥٥', ['2:255']],
  ])('reads %s', (text, expected) => {
    expect(refs(text)).toEqual(expected);
  });

  // Near-misses: things shaped like a reference that are not one.
  it.each([
    ['at 10:30 in the morning the ratio was 3:400'], // 10:30 is a valid verse, 3:400 is not
    ['LK id 1_23_42_1302'],
    ['Sahih Muslim 8:3371'],
    ['115:1 and 2:287 do not exist'],
    ['12:30:45'],
    ['Surah Yusuf is a long surah revealed in 12 parts'],
    ['the surah of mercy: 5 lessons'],
  ])('does not over-read %s', (text) => {
    const found = refs(text);
    expect(found.filter((r) => r !== '10:30')).toEqual([]);
  });
});

describe('scoreQuran', () => {
  it('FAILS the staging misquote: بِعَيْنِنَا labelled 68:48', () => {
    // No search ran; the harness looked 68:48 up because the answer names it.
    const score = scoreQuran(input(ANSWER_MISQUOTE_68_48, { lookups: lookups('68:48') }));
    expect(score.quotes).toHaveLength(1);
    expect(score.quotes[0].outcome).toBe('mismatch');
    expect(score.quotes[0].labels).toEqual(['68:48']);
    expect(score.quotes[0].grounding).toBe('none');
    expect(score.counts.mismatch).toBe(1);
    expect(score.fromMemory).toBe(1);
  });

  it('FAILS it as a misquote of 52:48 when that verse is in hand, and shows the word', () => {
    const score = scoreQuran(
      input(ANSWER_MISQUOTE_68_48, { earlierTurns: [verse('52:48')], lookups: lookups('68:48') }),
    );
    const quote = score.quotes[0];
    expect(quote.outcome).toBe('mismatch');
    expect(quote.nearest?.key).toBe('52:48');
    expect(quote.diff).toEqual({ against: '52:48', extra: ['بعيننا'], missing: ['بءعيننا'] });
  });

  it('PASSES the near-miss: the right words under the right reference', () => {
    const score = scoreQuran(input(ANSWER_CORRECT_52_48, { thisTurn: [verse('52:48'), verse('68:48')] }));
    expect(score.quotes).toHaveLength(1);
    // These words carry no Uthmani-only spelling, so the retyped quote is letter-exact.
    expect(score.quotes[0].outcome).toBe('exact');
    expect(score.quotes[0].matched).toEqual(['52:48']);
    expect(score.quotes[0].grounding).toBe('this_turn');
    expect(score.counts.mismatch + score.counts.wrong_reference).toBe(0);
  });

  it('FAILS the right words under the wrong reference', () => {
    // 52:48 was retrieved, so the text is recognised: wrong_reference.
    const known = scoreQuran(
      input(ANSWER_RIGHT_TEXT_WRONG_REF, { thisTurn: [verse('52:48')], lookups: lookups('68:48') }),
    );
    expect(known.quotes[0].outcome).toBe('wrong_reference');
    expect(known.quotes[0].matched).toEqual(['52:48']);
    // Nothing was retrieved: the text is simply not 68:48's.
    const unknown = scoreQuran(input(ANSWER_RIGHT_TEXT_WRONG_REF, { lookups: lookups('68:48') }));
    expect(unknown.quotes[0].outcome).toBe('mismatch');
  });

  it('scores a quote inside a citation entry against that entry, and sets hadith text aside', () => {
    const score = scoreQuran(
      input(ANSWER_WITH_CITATIONS, { thisTurn: [verse('2:153'), verse('2:45')], hadith: [HADITH.patience] }),
    );
    const byOutcome = score.quotes.map((q) => [q.outcome, q.where]);
    expect(byOutcome).toEqual([
      ['standard', 'citation'],
      ['hadith_text', 'citation'],
    ]);
    expect(score.quotes[0].matched).toEqual(['2:153']);
    expect(score.quranQuotes).toBe(1);
    expect(score.notFromThisTurn).toBe(0);
  });

  it('a quote of a verse retrieved in an earlier turn is correct but not grounded in this turn', () => {
    const score = scoreQuran(input(ANSWER_CORRECT_52_48, { earlierTurns: [verse('52:48')] }));
    expect(score.quotes[0].outcome).toBe('exact');
    expect(score.quotes[0].grounding).toBe('earlier_turn');
    expect(score.notFromThisTurn).toBe(1);
    expect(score.fromMemory).toBe(0);
  });

  it('reads a quote that runs across two verses, and one that opens with the basmala', () => {
    const answer = `Allah says in Surah Ash-Sharh (94:5-6): فَإِنَّ مَعَ الْعُسْرِ يُسْرًا إِنَّ مَعَ الْعُسْرِ يُسْرًا

And in Surah Al-Ikhlas (112:1-2): بِسْمِ اللَّهِ الرَّحْمَنِ الرَّحِيمِ قُلْ هُوَ اللَّهُ أَحَدٌ اللَّهُ الصَّمَدُ`;
    const score = scoreQuran(
      input(answer, { thisTurn: [verse('94:5'), verse('94:6'), verse('112:1'), verse('112:2')] }),
    );
    expect(score.quotes.map((q) => q.outcome)).toEqual(['exact', 'exact']);
    expect(score.quotes[0].matched.sort()).toEqual(['94:5', '94:6']);
    expect(score.quotes[1].matched.sort()).toEqual(['112:1', '112:2']);
  });

  it('a phrase shared by two verses passes under either reference', () => {
    // إِنَّ مَعَ ٱلْعُسْرِ يُسْرًا is in both 94:5 and 94:6.
    const answer = 'As 94:6 says: إِنَّ مَعَ الْعُسْرِ يُسْرًا';
    const score = scoreQuran(input(answer, { thisTurn: [verse('94:5'), verse('94:6')] }));
    expect(score.quotes[0].outcome).toBe('exact');
    expect(score.quotes[0].matched).toEqual(['94:6']);
  });

  it('Ayat al-Kursi retyped in standard spelling passes at `standard`, not `exact`', () => {
    const answer = `Ayat al-Kursi (2:255):\n\n${AYAT_AL_KURSI_STANDARD}`;
    const score = scoreQuran(input(answer, { thisTurn: [verse('2:255')] }));
    expect(score.quotes.map((q) => q.outcome)).toEqual(['standard']);
    // The source's own string, copied, is exact.
    const copied = scoreQuran(input(`Ayat al-Kursi (2:255):\n\n${VERSES['2:255']}`, { thisTurn: [verse('2:255')] }));
    expect(copied.quotes.map((q) => q.outcome)).toEqual(['exact']);
  });

  it('a quote that differs only by an unwritten alef is `skeleton`: reported, not exact', () => {
    // السموات is a common spelling of السماوات; the checker cannot tell it from a slip.
    const answer = 'He owns everything (2:255): لَهُ مَا فِي السَّمَوَاتِ وَمَا فِي الْأَرْضِ';
    const score = scoreQuran(input(answer, { thisTurn: [verse('2:255')] }));
    expect(score.quotes.map((q) => q.outcome)).toEqual(['skeleton']);
  });

  it('a reference with no source text is unverifiable, never a pass and never a fail', () => {
    const score = scoreQuran(input(ANSWER_CORRECT_52_48, { lookups: { '52:48': null } }));
    expect(score.quotes[0].outcome).toBe('unverifiable');
    expect(score.unverifiable).toEqual(['52:48']);
  });

  it('in an Arabic answer only quoted or vowelled runs are read as quotes', () => {
    const answer = `أمر الله نبيه بالصبر على حكمه وبيّن أنه في حفظه ورعايته، قال تعالى: ﴿وَاصْبِرْ لِحُكْمِ رَبِّكَ فَإِنَّكَ بِأَعْيُنِنَا﴾ [الطور: 48]، وهذا من أعظم ما يثبت قلب المؤمن عند البلاء.`;
    const score = scoreQuran(input(answer, { thisTurn: [verse('52:48')] }));
    expect(score.quotes).toHaveLength(1);
    expect(score.quotes[0].outcome).toBe('exact');
    expect(score.quotes[0].labels).toEqual(['52:48']);
    expect(score.proseRunsSkipped).toBeGreaterThan(0);
    expect(score.counts.mismatch + score.counts.suspect).toBe(0);
  });

  it('and the misquote is still caught inside an Arabic answer', () => {
    const answer = `قال تعالى: ﴿وَاصْبِرْ لِحُكْمِ رَبِّكَ فَإِنَّكَ بِعَيْنِنَا﴾ [القلم: 48]، وهذا تثبيت للنبي.`;
    const score = scoreQuran(input(answer, { lookups: lookups('68:48') }));
    expect(score.quotes).toHaveLength(1);
    expect(score.quotes[0].outcome).toBe('mismatch');
  });

  it('an honorific next to a reference is not a quote, but a wrong verse there still fails', () => {
    const honorific = 'The Prophet (صلى الله عليه وسلم) recited it often (Quran 52:48).';
    const score = scoreQuran(input(honorific, { thisTurn: [verse('52:48')] }));
    expect(score.quotes.map((q) => q.outcome)).toEqual(['term']);
    // The same shape with four words that ARE meant as the verse and are not.
    const wrong = 'Allah says (Quran 52:48): إِنَّ اللَّهَ مَعَ الصَّابِرِينَ دَائِمًا';
    expect(scoreQuran(input(wrong, { thisTurn: [verse('52:48')] })).quotes.map((q) => q.outcome)).toEqual(['mismatch']);
  });

  it('Arabic far from its reference that matches nothing is suspect, not a failure', () => {
    const answer = `The scholars discuss 52:48 at length in their commentaries.\nOne supplication reads:\nاللَّهُمَّ إِنِّي أَعُوذُ بِكَ مِنَ الْهَمِّ وَالْحَزَنِ`;
    const score = scoreQuran(input(answer, { thisTurn: [verse('52:48')] }));
    expect(score.quotes.map((q) => [q.outcome, q.labelScope])).toEqual([['suspect', 'paragraph']]);
    expect(score.counts.mismatch).toBe(0);
  });

  it('reports whether the references a question expects were named and quoted', () => {
    const right = scoreQuran(input(ANSWER_CORRECT_52_48, { thisTurn: [verse('52:48')], expectRefs: ['52:48'] }));
    expect(right.expected).toEqual([{ ref: '52:48', labelled: true, quoted: true }]);
    const wrong = scoreQuran(
      input(ANSWER_MISQUOTE_68_48, { lookups: lookups('68:48'), expectRefs: ['52:48'] }),
    );
    expect(wrong.expected).toEqual([{ ref: '52:48', labelled: false, quoted: false }]);
  });

  it('refsToLookUp names the references no search returned', () => {
    expect(refsToLookUp(ANSWER_MISQUOTE_68_48, [])).toEqual(['68:48']);
    expect(refsToLookUp(ANSWER_MISQUOTE_68_48, ['68:48'])).toEqual([]);
    expect(refsToLookUp(ANSWER_WITH_CITATIONS, ['2:45'])).toEqual(['2:153']);
  });
});
