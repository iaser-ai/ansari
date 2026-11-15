import { describe, it, expect } from 'vitest';
import { scoreHadith, gradeClasses } from '../../eval/lib/score-hadith';
import { scoreLanguage } from '../../eval/lib/score-language';
import { HADITH, ANSWER_WITH_CITATIONS } from './fixtures';

describe('scoreHadith', () => {
  it('PASSES an LK id the search returned in this turn, with its grade', () => {
    const score = scoreHadith({ answer: ANSWER_WITH_CITATIONS, thisTurn: [HADITH.patience], earlierTurns: [] });
    expect(score.lkIds).toEqual([
      { id: '1_23_42_1302', status: 'this_turn', grade: 'matches', sourceGrade: 'Sahih-Authentic', stated: ['sahih'] },
    ]);
    expect(score.fabricated).toBe(0);
    expect(score.entriesWithoutLkId).toEqual([]);
  });

  it('FAILS an LK id no search returned, even one digit off a real one', () => {
    const answer = ANSWER_WITH_CITATIONS.replace('1_23_42_1302', '1_23_42_1303');
    const score = scoreHadith({ answer, thisTurn: [HADITH.patience], earlierTurns: [] });
    expect(score.fabricated).toBe(1);
    expect(score.lkIds[0]).toEqual({ id: '1_23_42_1303', status: 'fabricated', grade: null });
  });

  it('tells an id from an earlier turn apart from one from this turn', () => {
    const score = scoreHadith({ answer: ANSWER_WITH_CITATIONS, thisTurn: [], earlierTurns: [HADITH.patience] });
    expect(score.thisTurn).toBe(0);
    expect(score.earlierTurn).toBe(1);
    expect(score.fabricated).toBe(0);
  });

  it('counts an id once however often it is written, in prose or in a citation', () => {
    const answer = `The Prophet said real patience is at the first blow (LK id 1_23_42_1302) [1].\n\n${ANSWER_WITH_CITATIONS}`;
    const score = scoreHadith({ answer, thisTurn: [HADITH.patience], earlierTurns: [] });
    expect(score.total).toBe(1);
  });

  it('FAILS a grade that contradicts the search result, and passes the near-miss', () => {
    const cite = (grade: string) =>
      `It is reported [1].\n\n**Citations**:\n[1] Sunan Ibn Majah - Chapter 1, Hadith 224 (Grade: ${grade}) (LK id 6_1_17_224)\n    Arabic: طَلَبُ الْعِلْمِ فَرِيضَةٌ عَلَى كُلِّ مُسْلِمٍ`;
    const grade = (stated: string) =>
      scoreHadith({ answer: cite(stated), thisTurn: [HADITH.knowledge], earlierTurns: [] }).lkIds[0].grade;
    // The search result says Da'if.
    expect(grade('Sahih')).toBe('contradicts');
    expect(grade("Da'if (Darussalam)")).toBe('matches');
    expect(grade('Weak')).toBe('matches');
    expect(grade('ضعيف')).toBe('matches');
  });

  it('does not read a book or a narrator as a grade', () => {
    // "Sahih Bukhari" and "al-Hasan" are not grade statements: nothing follows the word "grade".
    const answer = `Narrated by al-Hasan in Sahih Bukhari (LK id 1_23_42_1302).`;
    const score = scoreHadith({ answer, thisTurn: [HADITH.patience], earlierTurns: [] });
    expect(score.lkIds[0].grade).toBe('not_stated');
    expect(gradeClasses('Ṣaḥīḥ')).toEqual(['sahih']);
    expect(gradeClasses('Hasan Sahih')).toEqual(['sahih', 'hasan']);
    expect(gradeClasses('Ḍaʿīf')).toEqual(['daif']);
  });

  it('lists a hadith citation that carries no LK id, and not a Quran or tafsir one', () => {
    const answer = `Text [1] [2] [3].\n\n**Citations**:\n[1] Sahih Bukhari, Book of Funerals, Hadith 1302\n    Arabic: الصَّبْرُ عِنْدَ الصَّدْمَةِ الأُولَى\n[2] Quran 2:153\n    Arabic: إِنَّ اللَّهَ مَعَ الصَّابِرِينَ\n[3] Tafsir Encyclopedia, Volume 3, Page 45 (on the hadith of patience)`;
    const score = scoreHadith({ answer, thisTurn: [], earlierTurns: [] });
    expect(score.entriesWithoutLkId).toEqual(['[1] Sahih Bukhari, Book of Funerals, Hadith 1302']);
  });
});

const ENGLISH = `Patience is one of the most emphasised virtues in the Quran. Allah says that He is with those who are patient, and the believers are told to seek help through patience and prayer. This is a command that the scholars have explained at length, and it applies to every hardship that a person may face in this life.

وَاسْتَعِينُوا بِالصَّبْرِ وَالصَّلَاةِ (2:45)`;

const ARABIC = `الصبر من أعظم الأخلاق التي حثّ عليها القرآن الكريم، وقد أمر الله تعالى عباده بالاستعانة بالصبر والصلاة، وبيّن أنه مع الصابرين في كل حال. قال تعالى: ﴿وَاسْتَعِينُوا بِالصَّبْرِ وَالصَّلَاةِ﴾ [البقرة: 45].`;

const FRENCH = `La patience est l'une des vertus les plus importantes dans le Coran. Allah dit qu'Il est avec ceux qui sont patients, et les croyants sont invités à chercher de l'aide dans la patience et la prière. Les savants ont expliqué que cette patience est une obligation pour le croyant dans les épreuves.`;

const INDONESIAN = `Sabar adalah salah satu akhlak yang paling ditekankan dalam Al-Qur'an. Allah berfirman bahwa Dia bersama orang-orang yang sabar, dan orang beriman diperintahkan untuk memohon pertolongan dengan sabar dan shalat. Para ulama menjelaskan bahwa kesabaran ini adalah kewajiban bagi setiap muslim dalam menghadapi ujian.`;

const URDU = `صبر ان اخلاق میں سے ہے جن پر قرآن مجید نے بہت زور دیا ہے۔ اللہ تعالیٰ فرماتا ہے کہ وہ صبر کرنے والوں کے ساتھ ہے، اور مومنوں کو حکم دیا گیا ہے کہ وہ صبر اور نماز سے مدد لیں۔ علماء نے اس کی تفصیل بیان کی ہے۔`;

const TURKISH = `Sabır, Kur'an'da en çok vurgulanan erdemlerden biridir. Allah sabredenlerle beraber olduğunu bildirir ve müminlere sabır ve namaz ile yardım dilemeleri emredilir. Bu, her zorluk için geçerli olan bir emirdir ve âlimler bunu uzun uzun açıklamıştır.`;

describe('scoreLanguage', () => {
  it.each([
    ['en', ENGLISH],
    ['ar', ARABIC],
    ['fr', FRENCH],
    ['id', INDONESIAN],
    ['ur', URDU],
    ['tr', TURKISH],
  ])('PASSES an answer in %s to a question in %s', (language, answer) => {
    const score = scoreLanguage(answer, language);
    expect(score.detected).toBe(language);
    expect(score.inLanguage).toBe(true);
  });

  it('FAILS an Arabic question answered in English, quoted Arabic and all (the staging report)', () => {
    const score = scoreLanguage(ENGLISH, 'ar');
    expect(score.inLanguage).toBe(false);
    expect(score.detected).toBe('en');
  });

  it.each([
    ['fr', ENGLISH, 'en'],
    ['en', ARABIC, 'ar'],
    ['ur', ARABIC, 'ar'],
    ['ar', URDU, 'ur'],
    ['id', FRENCH, 'fr'],
  ])('FAILS a %s question answered in another language', (expected, answer, detected) => {
    const score = scoreLanguage(answer, expected);
    expect(score.inLanguage).toBe(false);
    expect(score.detected).toBe(detected);
  });

  it('judges the prose, not the bilingual Citations section', () => {
    const answer = `${ARABIC}\n\n**Citations**:\n[1] Quran 2:45\n    Arabic: وَاسْتَعِينُوا بِالصَّبْرِ وَالصَّلَاةِ\n    English: ${ENGLISH}\n    English: ${ENGLISH}`;
    expect(scoreLanguage(answer, 'ar').inLanguage).toBe(true);
  });

  it('an empty answer is in no language', () => {
    expect(scoreLanguage('', 'en')).toMatchObject({ detected: 'none', inLanguage: false });
  });
});
