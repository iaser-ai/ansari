/**
 * Source texts and answers for the model-eval scorer tests.
 *
 * The verse texts are Uthmani script as Kalimat serves it (2:255 and 2:45 are copied from
 * tests/fixtures/kalemat/). The answers are written for these tests in the formats the
 * facilitator prompt asks for; none is a real user's conversation.
 */
import type { ToolCallRecord } from '@/db/schema/messages';

export const VERSES: Record<string, string> = {
  '52:48': 'وَٱصْبِرْ لِحُكْمِ رَبِّكَ فَإِنَّكَ بِأَعْيُنِنَا ۖ وَسَبِّحْ بِحَمْدِ رَبِّكَ حِينَ تَقُومُ',
  '68:48': 'فَٱصْبِرْ لِحُكْمِ رَبِّكَ وَلَا تَكُن كَصَاحِبِ ٱلْحُوتِ إِذْ نَادَىٰ وَهُوَ مَكْظُومٌ',
  '2:45': 'وَٱسْتَعِينُوا بِٱلصَّبْرِ وَٱلصَّلَوٰةِ ۚ وَإِنَّهَا لَكَبِيرَةٌ إِلَّا عَلَى ٱلْخَـٰشِعِينَ',
  '2:153': 'يَـٰٓأَيُّهَا ٱلَّذِينَ ءَامَنُوا۟ ٱسْتَعِينُوا۟ بِٱلصَّبْرِ وَٱلصَّلَوٰةِ ۚ إِنَّ ٱللَّهَ مَعَ ٱلصَّـٰبِرِينَ',
  '2:255':
    'ٱللَّهُ لَآ إِلَـٰهَ إِلَّا هُوَ ٱلْحَىُّ ٱلْقَيُّومُ ۚ لَا تَأْخُذُهُۥ سِنَةٌ وَلَا نَوْمٌ ۚ لَّهُۥ مَا فِى ٱلسَّمَـٰوَٰتِ وَمَا فِى ٱلْأَرْضِ ۗ مَن ذَا ٱلَّذِى يَشْفَعُ عِندَهُۥٓ إِلَّا بِإِذْنِهِۦ ۚ يَعْلَمُ مَا بَيْنَ أَيْدِيهِمْ وَمَا خَلْفَهُمْ ۖ وَلَا يُحِيطُونَ بِشَىْءٍۢ مِّنْ عِلْمِهِۦٓ إِلَّا بِمَا شَآءَ ۚ وَسِعَ كُرْسِيُّهُ ٱلسَّمَـٰوَٰتِ وَٱلْأَرْضَ ۖ وَلَا يَـُٔودُهُۥ حِفْظُهُمَا ۚ وَهُوَ ٱلْعَلِىُّ ٱلْعَظِيمُ',
  '94:5': 'فَإِنَّ مَعَ ٱلْعُسْرِ يُسْرًا',
  '94:6': 'إِنَّ مَعَ ٱلْعُسْرِ يُسْرًا',
  '112:1': 'قُلْ هُوَ ٱللَّهُ أَحَدٌ',
  '112:2': 'ٱللَّهُ ٱلصَّمَدُ',
};

/** 2:255 retyped in standard spelling with vowels, as a model writes it from memory. */
export const AYAT_AL_KURSI_STANDARD =
  'اللَّهُ لَا إِلَٰهَ إِلَّا هُوَ الْحَيُّ الْقَيُّومُ لَا تَأْخُذُهُ سِنَةٌ وَلَا نَوْمٌ لَهُ مَا فِي السَّمَاوَاتِ وَمَا فِي الْأَرْضِ مَنْ ذَا الَّذِي يَشْفَعُ عِنْدَهُ إِلَّا بِإِذْنِهِ يَعْلَمُ مَا بَيْنَ أَيْدِيهِمْ وَمَا خَلْفَهُمْ وَلَا يُحِيطُونَ بِشَيْءٍ مِنْ عِلْمِهِ إِلَّا بِمَا شَاءَ وَسِعَ كُرْسِيُّهُ السَّمَاوَاتِ وَالْأَرْضَ وَلَا يَئُودُهُ حِفْظُهُمَا وَهُوَ الْعَلِيُّ الْعَظِيمُ';

export interface HadithFixture {
  lkId: string;
  ar: string;
  en: string;
  grade: string;
  collection: string;
}

export const HADITH: Record<string, HadithFixture> = {
  patience: {
    lkId: '1_23_42_1302',
    ar: 'حَدَّثَنَا مُحَمَّدُ بْنُ بَشَّارٍ، عَنِ النَّبِيِّ صلى الله عليه وسلم قَالَ الصَّبْرُ عِنْدَ الصَّدْمَةِ الأُولَى',
    en: 'Narrated Anas: The Prophet (ﷺ) said, "The real patience is at the first stroke of a calamity."',
    grade: 'Sahih-Authentic',
    collection: 'Sahih Bukhari',
  },
  knowledge: {
    lkId: '6_1_17_224',
    ar: 'طَلَبُ الْعِلْمِ فَرِيضَةٌ عَلَى كُلِّ مُسْلِمٍ',
    en: 'Seeking knowledge is a duty upon every Muslim.',
    grade: "Da'if (Darussalam)",
    collection: 'Sunan Ibn Majah',
  },
};

let seq = 0;

/** The tool-call records a search_quran call leaves, as the facilitator records them. */
export function quranSearch(keys: string[], query = 'patience'): ToolCallRecord[] {
  const id = `tool_test_${++seq}`;
  return [
    { type: 'tool_use', id, name: 'search_quran', input: { query } },
    {
      type: 'tool_result',
      tool_use_id: id,
      content: {
        results: keys.map((key) => ({
          title: `Quran ${key}`,
          context: 'Retrieved from the Holy Quran',
          content: JSON.stringify({ ar: VERSES[key], en: `translation of ${key}` }),
        })),
        summary: 'Please see the Quran verses below.',
      },
      status: 'ok',
      duration_ms: 120,
      citations: keys.map(() => ({ enabled: true })),
    },
  ];
}

/** The tool-call records a search_hadith call leaves. */
export function hadithSearch(items: HadithFixture[], query = 'patience'): ToolCallRecord[] {
  const id = `tool_test_${++seq}`;
  return [
    { type: 'tool_use', id, name: 'search_hadith', input: { query } },
    {
      type: 'tool_result',
      tool_use_id: id,
      content: {
        results: items.map((h) => ({
          title: `${h.collection} - Chapter 1: Test, Hadith 1 (Grade: ${h.grade}) (LK id ${h.lkId})`,
          context: 'Retrieved from hadith collections',
          content: JSON.stringify({
            ar: h.ar,
            en: h.en,
            grade: h.grade,
            collection: h.collection,
            chapter: 'Test',
            lk_id: h.lkId,
          }),
        })),
        summary: 'Please see the hadith references below.',
      },
      status: 'ok',
      duration_ms: 150,
      citations: items.map(() => ({ enabled: true })),
    },
  ];
}

/** A search that degraded: the model received a notice, not a source. */
export function degradedSearch(name: string): ToolCallRecord[] {
  const id = `tool_test_${++seq}`;
  return [
    { type: 'tool_use', id, name, input: { query: 'q' } },
    {
      type: 'tool_result',
      tool_use_id: id,
      content: { results: [{ title: 'Unavailable', context: 'System', content: 'temporarily unavailable' }], summary: 'unavailable' },
      status: 'degraded',
      duration_ms: 20000,
      error_class: 'timeout',
      citations: [{ enabled: false }],
    },
  ];
}

// ── Answers ──────────────────────────────────────────────────────────────────

/**
 * THE misquote from staging (issue #393): بِعَيْنِنَا for بِأَعْيُنِنَا, and the 52:48 text
 * labelled 68:48, on a turn with no search_quran call.
 */
export const ANSWER_MISQUOTE_68_48 = `Allah tells His Messenger to be patient with His decree:

وَاصْبِرْ لِحُكْمِ رَبِّكَ فَإِنَّكَ بِعَيْنِنَا (Quran 68:48)

"So be patient for the decision of your Lord, for indeed, you are in Our eyes."`;

/** The near-miss that must PASS: the right words, the right reference, standard spelling. */
export const ANSWER_CORRECT_52_48 = `Allah tells His Messenger to be patient with His decree:

وَاصْبِرْ لِحُكْمِ رَبِّكَ فَإِنَّكَ بِأَعْيُنِنَا (Quran 52:48)

"So be patient for the decision of your Lord, for indeed, you are in Our eyes."`;

/** The right words of 52:48 under the wrong reference. */
export const ANSWER_RIGHT_TEXT_WRONG_REF = `Allah says:

وَاصْبِرْ لِحُكْمِ رَبِّكَ فَإِنَّكَ بِأَعْيُنِنَا (Quran 68:48)`;

/** An answer in the prompt's citation format: markers in the prose, texts in the entries. */
export const ANSWER_WITH_CITATIONS = `Patience is tied to prayer in the Quran [1], and the Prophet (PBUH) said that real patience is at the first stroke of a calamity [2].

**Citations**:
[1] Quran 2:153
    Arabic: يَا أَيُّهَا الَّذِينَ آمَنُوا اسْتَعِينُوا بِالصَّبْرِ وَالصَّلَاةِ إِنَّ اللَّهَ مَعَ الصَّابِرِينَ
    English: O you who believe, seek help through patience and prayer.
[2] Sahih Bukhari - Chapter 23: Funerals, Hadith 1302 (Grade: Sahih-Authentic) (LK id 1_23_42_1302)
    Arabic: الصَّبْرُ عِنْدَ الصَّدْمَةِ الأُولَى
    English: The real patience is at the first stroke of a calamity.`;
