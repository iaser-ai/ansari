import type { Citation } from '@/lib/api/types';

/**
 * FIXED SAMPLE CITATIONS — sample data, not real output.
 *
 * Real answers now carry their own sources (`GET /threads/{id}/documents`,
 * spec 168 — mapped in `lib/document-citations.ts`, issue #161). This hardcoded
 * set is kept only as a FALLBACK DEMO, for an answer with no documents (an
 * apps/api without spec 168, or a turn that ran no tool), so the citation UI
 * (`AnswerMessage` pills, `CitationChip`, the source sheet) can still be shown.
 *
 * These are NOT derived from the answer they appear beneath — they are a fixed
 * set chosen to support the question "How can I develop khushu' in my prayer?".
 * They are attached ONLY to the FIRST assistant answer of a thread about khushu'
 * (the one answer these sources support), and only when that answer has no real
 * documents; follow-ups carry none. Treat them as illustrative only. Do not read
 * them as evidence the API returned.
 *
 * Accuracy: every reference, Arabic text, and translation below is real and
 * verified (Qur'an 20:14 / 23:1-2; Sahih al-Bukhari 528 via sunnah.com). A wrong
 * real citation is worse than none — do not add entries unless every field is
 * verified against a primary source.
 */
/**
 * FIXED SAMPLE ANSWER — paired with SAMPLE_CITATIONS above.
 *
 * `AnswerMessage`'s citation UI is two parts working together: small
 * superscript `[N]` markers inline in the prose, and the footnote pill
 * block at the foot of the answer, both opening the same illuminated-folio
 * citation sheet (see `AnswerMessage.tsx`'s own doc comment). The model's own
 * `[N]` markers in a real answer refer to ITS sources, not these, so pairing
 * SAMPLE_CITATIONS with the real text left the footnote pills with nothing
 * in the prose pointing to them (issue #145).
 *
 * This rewritten answer embeds literal `[1]`, `[2]`, `[3]` at the sentence
 * each sample citation actually supports (in `SAMPLE_CITATIONS` order:
 * establishing prayer for remembrance, humble submission during prayer, the
 * five daily prayers as a cleansing), and REPLACES the real answer text on
 * that one gated message only — same "illustrative, not real API output"
 * caveat as `SAMPLE_CITATIONS`. Every other message keeps its real content.
 */
export const SAMPLE_ANSWER_CONTENT =
  "Khushu' — presence of heart in prayer — grows less from a single " +
  'technique than from steady attention to what prayer actually is. Start ' +
  'with the words: slow down enough to notice what you are reciting, since ' +
  'prayer is established for the remembrance of God [1]. Let that ' +
  'remembrance turn into humility, the quiet submission that marks a ' +
  "believer at prayer, so the body's stillness reflects the heart's [2]. " +
  'Keep at it across all five prayers, even when a session feels dry — ' +
  'offered with sincerity, they wash away what came before, the way ' +
  'washing in a river leaves no trace of dirt behind [3].';

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
