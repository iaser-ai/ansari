/**
 * Is the answer in the question's language?
 *
 * Decided on the prose only: the Citations section is bilingual by instruction, and
 * quoted Arabic is scripture, not the answer's language. Two measurements, both code:
 *
 *  - Script. For a question in an Arabic-script language (ar, ur, fa) the prose must be
 *    mostly Arabic script. For any other language it must be mostly not: an English
 *    answer that quotes a great deal of Arabic still has more Latin letters than Arabic.
 *  - Language within the script. Latin-script languages are told apart by counting each
 *    language's most common function words; Urdu and Persian are told from Arabic by the
 *    letters Arabic does not use (ے ں ٹ ڈ ڑ گ پ چ).
 *
 * The numbers behind the verdict are returned with it, so a threshold can be argued with.
 */
import { parseAnswer } from './answer';

export const LANGUAGES = ['en', 'ar', 'fr', 'id', 'tr', 'ur', 'es', 'de', 'bs', 'ms', 'fa'] as const;
export type Language = (typeof LANGUAGES)[number];

const ARABIC_SCRIPT: ReadonlySet<string> = new Set(['ar', 'ur', 'fa']);

/** Function words that are common in one language and absent from the others listed. */
const STOPWORDS: Readonly<Record<string, readonly string[]>> = {
  en: ['the', 'and', 'of', 'to', 'is', 'that', 'it', 'for', 'with', 'as', 'this', 'are', 'was', 'by', 'not', 'be', 'which', 'from', 'or', 'his', 'who', 'have', 'has', 'there', 'their', 'they', 'were', 'these', 'those', 'should'],
  fr: ['le', 'les', 'des', 'est', 'et', 'que', 'qui', 'dans', 'pour', 'une', 'du', 'au', 'sur', 'par', 'pas', 'ce', 'il', 'sont', 'avec', 'plus', 'comme', 'être', 'cette', 'ses', 'aux', 'nous', 'mais', 'ou', 'leur', 'selon'],
  id: ['yang', 'dan', 'dari', 'untuk', 'dengan', 'ini', 'itu', 'adalah', 'pada', 'dalam', 'tidak', 'kepada', 'atau', 'juga', 'akan', 'oleh', 'sebagai', 'mereka', 'kita', 'karena', 'bahwa', 'seperti', 'telah', 'lebih', 'ada', 'bagi', 'hal', 'para', 'serta', 'maka'],
  tr: ['ve', 'bir', 'bu', 'için', 'ile', 'olarak', 'olan', 'daha', 'gibi', 'değil', 'çok', 'her', 'ise', 'veya', 'şöyle', 'ancak', 'kadar', 'sonra', 'göre', 'ya', 'hem', 'ne', 'onun', 'bunu', 'şu', 'eder', 'etmek', 'olur', 'vardır', 'üzerine'],
  es: ['el', 'los', 'las', 'es', 'y', 'que', 'en', 'por', 'para', 'una', 'del', 'con', 'no', 'se', 'su', 'como', 'más', 'este', 'esta', 'son', 'pero', 'sobre', 'entre', 'cuando', 'también', 'fue', 'ha', 'sus', 'al', 'lo'],
  de: ['der', 'die', 'das', 'und', 'ist', 'nicht', 'mit', 'für', 'auf', 'ein', 'eine', 'den', 'dem', 'des', 'sich', 'auch', 'von', 'zu', 'als', 'wie', 'oder', 'aber', 'wird', 'sind', 'dass', 'bei', 'nach', 'durch', 'über', 'wenn'],
  bs: ['je', 'i', 'da', 'se', 'na', 'su', 'za', 'od', 'što', 'koji', 'kao', 'ili', 'ali', 'koje', 'biti', 'bio', 'nije', 'sa', 'to', 'kada', 'ovo', 'tako', 'jer', 'koja', 'njegov', 'prema', 'među', 'treba', 'može', 'također'],
  ms: ['yang', 'dan', 'daripada', 'untuk', 'dengan', 'ini', 'itu', 'adalah', 'pada', 'dalam', 'tidak', 'kepada', 'atau', 'juga', 'akan', 'oleh', 'sebagai', 'mereka', 'kita', 'kerana', 'bahawa', 'seperti', 'telah', 'lebih', 'ada', 'bagi', 'hal', 'para', 'serta', 'maka'],
};

/** Letters Urdu and Persian use and Arabic does not. */
const NON_ARABIC_LETTERS = /[ےںٹڈڑگپچژ]/gu;
const URDU_ONLY = /[ےںٹڈڑ]/gu;

const LETTER = /\p{L}/gu;
const ARABIC_LETTER = /(?=\p{L})\p{Script=Arabic}/gu;
const LATIN_WORD = /[\p{Script=Latin}]+(?:['’][\p{Script=Latin}]+)?/gu;

/** Share of the prose's letters that must be in the expected script. */
const SCRIPT_SHARE = 0.6;
/** Share of Arabic-script letters that are non-Arabic letters, above which the text is Urdu or Persian. */
const NON_ARABIC_SHARE = 0.02;
/** Function-word hits that name a Latin-script language outright. */
const MIN_HITS = 5;
/**
 * A short answer (a verse and its translation) has few function words. Fewer hits still
 * name the language when no other language comes close: at least this many, and at least
 * twice the runner-up's.
 */
const MIN_HITS_CLEAR = 2;

export interface LanguageScore {
  expected: string;
  /** What the prose reads as: a language code, `arabic-script`, `latin-script` or `none`. */
  detected: string;
  inLanguage: boolean;
  /** Share of the prose's letters that are Arabic script. */
  arabicShare: number;
  /** Function-word hits per Latin-script language, when the prose is Latin script. */
  hits?: Record<string, number>;
  /** Share of Arabic-script letters that Arabic does not use. */
  nonArabicLetterShare?: number;
}

export function scoreLanguage(answer: string, expected: string): LanguageScore {
  const body = parseAnswer(answer).body;
  const letters = body.match(LETTER)?.length ?? 0;
  const arabicLetters = body.match(ARABIC_LETTER)?.length ?? 0;
  const arabicShare = letters === 0 ? 0 : arabicLetters / letters;
  if (letters === 0) return { expected, detected: 'none', inLanguage: false, arabicShare };

  const expectArabicScript = ARABIC_SCRIPT.has(expected);

  if (arabicShare >= SCRIPT_SHARE) {
    const nonArabic = (body.match(NON_ARABIC_LETTERS)?.length ?? 0) / arabicLetters;
    const urdu = (body.match(URDU_ONLY)?.length ?? 0) / arabicLetters;
    let detected = 'ar';
    if (nonArabic >= NON_ARABIC_SHARE) detected = urdu >= NON_ARABIC_SHARE / 2 ? 'ur' : 'fa';
    return {
      expected,
      detected,
      inLanguage: expectArabicScript && detected === expected,
      arabicShare,
      nonArabicLetterShare: nonArabic,
    };
  }

  // Mostly not Arabic script: name the Latin-script language by its function words.
  const words = (body.toLowerCase().match(LATIN_WORD) ?? []).map((w) => w.normalize('NFC'));
  const hits: Record<string, number> = {};
  for (const [language, list] of Object.entries(STOPWORDS)) {
    const set = new Set(list);
    hits[language] = words.filter((w) => set.has(w)).length;
  }
  const ranked = Object.entries(hits).sort((a, b) => b[1] - a[1]);
  const [best, bestHits] = ranked[0];
  const runnerUp = ranked[1]?.[1] ?? 0;
  let detected = bestHits >= MIN_HITS || (bestHits >= MIN_HITS_CLEAR && bestHits >= 2 * runnerUp) ? best : 'latin-script';
  // Indonesian and Malay share most function words; an answer is not failed for the tie.
  if ((detected === 'id' || detected === 'ms') && (expected === 'id' || expected === 'ms')) detected = expected;
  // Between the two scripts: neither dominates. Named, and never a pass.
  if (arabicShare > 1 - SCRIPT_SHARE) detected = 'mixed';
  return {
    expected,
    detected,
    inLanguage: !expectArabicScript && detected === expected,
    arabicShare,
    hits,
  };
}
