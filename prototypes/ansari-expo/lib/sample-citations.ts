import type { Citation } from '@/lib/api/types';

/**
 * FIXED SAMPLE CITATIONS — sample data, not real output.
 *
 * `apps/api` carries no citation data, so without this the citation UI
 * (`AnswerMessage` pills, `CitationChip`, `CitationSheet`) never renders and a
 * demo can't show it. This is a hardcoded set so that surface is visible.
 *
 * These are NOT derived from the answer they appear beneath — they are a fixed
 * set chosen to support the question "How can I develop khushu' in my prayer?".
 * They become REAL, answer-derived citations when issue #66 ships; until then,
 * treat them as illustrative only. Do not read them as evidence the API returned.
 *
 * Accuracy: every reference, Arabic text, and translation below is real and
 * verified (Qur'an 20:14 / 23:1-2; Sahih al-Bukhari 528 via sunnah.com). A wrong
 * real citation is worse than none — do not add entries unless every field is
 * verified against a primary source.
 */
export const SAMPLE_CITATIONS: Citation[] = [
  {
    id: 'sample-quran-20-14',
    marker: 1,
    sourceType: 'quran',
    reference: "Qur'an 20:14",
    sourceTitle: 'Surah Ta-Ha',
    arabicText: 'وَأَقِمِ ٱلصَّلَوٰةَ لِذِكْرِىٓ',
    translationText: 'And establish prayer for My remembrance.',
    url: 'https://quran.com/20/14',
  },
  {
    id: 'sample-quran-23-1-2',
    marker: 2,
    sourceType: 'quran',
    reference: "Qur'an 23:1-2",
    sourceTitle: "Surah al-Mu'minun",
    arabicText:
      'قَدْ أَفْلَحَ ٱلْمُؤْمِنُونَ ٱلَّذِينَ هُمْ فِى صَلَاتِهِمْ خَٰشِعُونَ',
    translationText:
      'Certainly will the believers have succeeded: they who are during their prayer humbly submissive.',
    url: 'https://quran.com/23/1-2',
  },
  {
    id: 'sample-bukhari-528',
    marker: 3,
    sourceType: 'hadith',
    reference: 'Sahih al-Bukhari 528',
    sourceTitle: 'Sahih al-Bukhari',
    arabicText:
      'أَرَأَيْتُمْ لَوْ أَنَّ نَهَرًا بِبَابِ أَحَدِكُمْ يَغْتَسِلُ فِيهِ كُلَّ يَوْمٍ خَمْسًا، مَا تَقُولُ ذَلِكَ يُبْقِي مِنْ دَرَنِهِ؟ قَالُوا: لَا يُبْقِي مِنْ دَرَنِهِ شَيْئًا. قَالَ: فَذَلِكَ مِثْلُ الصَّلَوَاتِ الْخَمْسِ، يَمْحُو اللَّهُ بِهِنَّ الْخَطَايَا.',
    translationText:
      'The Messenger of Allah (ﷺ) said, "If there was a river at the door of anyone of you and he took a bath in it five times a day, would you notice any dirt on him?" They said, "Not a trace of dirt would be left." The Prophet (ﷺ) added, "That is the example of the five prayers with which Allah blots out (annuls) evil deeds."',
    url: 'https://sunnah.com/bukhari:528',
  },
];
