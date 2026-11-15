/**
 * Finding Quran references in an answer: `2:255`, `94:5-6`, `٢:٢٥٥`, `[الطور: 48]`,
 * `سورة البقرة، الآية 255`, `Surah At-Tur, verse 48`.
 *
 * A reference is only accepted when the surah exists and the ayah is within that surah's
 * length, which is what keeps `10:30` the time and `Muslim 8:3371` from being read as one.
 */

/** Ayah count per surah, index 0 = surah 1. The total is 6236; a test holds that. */
export const AYAH_COUNTS: readonly number[] = [
  7, 286, 200, 176, 120, 165, 206, 75, 129, 109, 123, 111, 43, 52, 99, 128, 111, 110, 98, 135,
  112, 78, 118, 64, 77, 227, 93, 88, 69, 60, 34, 30, 73, 54, 45, 83, 182, 88, 75, 85,
  54, 53, 89, 59, 37, 35, 38, 29, 18, 45, 60, 49, 62, 55, 78, 96, 29, 22, 24, 13,
  14, 11, 11, 18, 12, 12, 30, 52, 52, 44, 28, 28, 20, 56, 40, 31, 50, 40, 46, 42,
  29, 19, 36, 25, 22, 17, 19, 26, 30, 20, 15, 21, 11, 8, 8, 19, 5, 8, 8, 11,
  11, 8, 3, 9, 5, 4, 7, 3, 6, 3, 5, 4, 5, 6,
];

/** Arabic surah names, index 0 = surah 1. */
const ARABIC_NAMES: readonly string[] = [
  'الفاتحة', 'البقرة', 'آل عمران', 'النساء', 'المائدة', 'الأنعام', 'الأعراف', 'الأنفال', 'التوبة', 'يونس',
  'هود', 'يوسف', 'الرعد', 'إبراهيم', 'الحجر', 'النحل', 'الإسراء', 'الكهف', 'مريم', 'طه',
  'الأنبياء', 'الحج', 'المؤمنون', 'النور', 'الفرقان', 'الشعراء', 'النمل', 'القصص', 'العنكبوت', 'الروم',
  'لقمان', 'السجدة', 'الأحزاب', 'سبأ', 'فاطر', 'يس', 'الصافات', 'ص', 'الزمر', 'غافر',
  'فصلت', 'الشورى', 'الزخرف', 'الدخان', 'الجاثية', 'الأحقاف', 'محمد', 'الفتح', 'الحجرات', 'ق',
  'الذاريات', 'الطور', 'النجم', 'القمر', 'الرحمن', 'الواقعة', 'الحديد', 'المجادلة', 'الحشر', 'الممتحنة',
  'الصف', 'الجمعة', 'المنافقون', 'التغابن', 'الطلاق', 'التحريم', 'الملك', 'القلم', 'الحاقة', 'المعارج',
  'نوح', 'الجن', 'المزمل', 'المدثر', 'القيامة', 'الإنسان', 'المرسلات', 'النبأ', 'النازعات', 'عبس',
  'التكوير', 'الانفطار', 'المطففين', 'الانشقاق', 'البروج', 'الطارق', 'الأعلى', 'الغاشية', 'الفجر', 'البلد',
  'الشمس', 'الليل', 'الضحى', 'الشرح', 'التين', 'العلق', 'القدر', 'البينة', 'الزلزلة', 'العاديات',
  'القارعة', 'التكاثر', 'العصر', 'الهمزة', 'الفيل', 'قريش', 'الماعون', 'الكوثر', 'الكافرون', 'النصر',
  'المسد', 'الإخلاص', 'الفلق', 'الناس',
];

/**
 * English surah names as keys: lowercase, no diacritics, no article, no punctuation.
 * `englishKey` reduces what a model writes ("Aṭ-Ṭūr", "al-Baqarah") to the same form.
 */
const ENGLISH_KEYS: readonly string[] = [
  'fatihah', 'baqarah', 'imran', 'nisa', 'maidah', 'anam', 'araf', 'anfal', 'tawbah', 'yunus',
  'hud', 'yusuf', 'rad', 'ibrahim', 'hijr', 'nahl', 'isra', 'kahf', 'maryam', 'taha',
  'anbiya', 'hajj', 'muminun', 'nur', 'furqan', 'shuara', 'naml', 'qasas', 'ankabut', 'rum',
  'luqman', 'sajdah', 'ahzab', 'saba', 'fatir', 'yasin', 'saffat', 'sad', 'zumar', 'ghafir',
  'fussilat', 'shura', 'zukhruf', 'dukhan', 'jathiyah', 'ahqaf', 'muhammad', 'fath', 'hujurat', 'qaf',
  'dhariyat', 'tur', 'najm', 'qamar', 'rahman', 'waqiah', 'hadid', 'mujadilah', 'hashr', 'mumtahanah',
  'saff', 'jumuah', 'munafiqun', 'taghabun', 'talaq', 'tahrim', 'mulk', 'qalam', 'haqqah', 'maarij',
  'nuh', 'jinn', 'muzzammil', 'muddaththir', 'qiyamah', 'insan', 'mursalat', 'naba', 'naziat', 'abasa',
  'takwir', 'infitar', 'mutaffifin', 'inshiqaq', 'buruj', 'tariq', 'ala', 'ghashiyah', 'fajr', 'balad',
  'shams', 'layl', 'duha', 'sharh', 'tin', 'alaq', 'qadr', 'bayyinah', 'zalzalah', 'adiyat',
  'qariah', 'takathur', 'asr', 'humazah', 'fil', 'quraysh', 'maun', 'kawthar', 'kafirun', 'nasr',
  'masad', 'ikhlas', 'falaq', 'nas',
];

export const SURAH_COUNT = 114;

export interface QuranRef {
  surah: number;
  /** First ayah. */
  ayah: number;
  /** Last ayah of a range; equals `ayah` for a single verse. */
  ayahEnd: number;
}

export interface RefOccurrence extends QuranRef {
  /** Offsets of the reference in the text it was found in. */
  start: number;
  end: number;
  /** How it was written: `2:255`, or by surah name. */
  form: 'numeric' | 'named';
}

export function refKey(surah: number, ayah: number): string {
  return `${surah}:${ayah}`;
}

/** Every verse key a reference covers, e.g. 94:5-6 → ['94:5', '94:6']. */
export function refVerses(ref: QuranRef): string[] {
  const out: string[] = [];
  for (let a = ref.ayah; a <= ref.ayahEnd; a++) out.push(refKey(ref.surah, a));
  return out;
}

export function formatRef(ref: QuranRef): string {
  return ref.ayahEnd > ref.ayah ? `${ref.surah}:${ref.ayah}-${ref.ayahEnd}` : `${ref.surah}:${ref.ayah}`;
}

/** Parse `52:48` or `94:5-6`; null when it is not a valid reference. */
export function parseRef(text: string): QuranRef | null {
  const m = /^(\d{1,3}):(\d{1,3})(?:-(\d{1,3}))?$/.exec(text.trim());
  if (!m) return null;
  return validRef(Number(m[1]), Number(m[2]), m[3] === undefined ? undefined : Number(m[3]));
}

function validRef(surah: number, ayah: number, ayahEnd?: number): QuranRef | null {
  if (!Number.isInteger(surah) || surah < 1 || surah > SURAH_COUNT) return null;
  const count = AYAH_COUNTS[surah - 1];
  if (ayah < 1 || ayah > count) return null;
  if (ayahEnd === undefined || ayahEnd === ayah) return { surah, ayah, ayahEnd: ayah };
  if (ayahEnd < ayah || ayahEnd > count) return null;
  return { surah, ayah, ayahEnd };
}

/** Arabic-Indic and Persian digits as ASCII, one character for one, so offsets hold. */
export function asciiDigits(text: string): string {
  return text.replace(/[٠-٩۰-۹]/g, (d) => {
    const cp = d.charCodeAt(0);
    return String(cp >= 0x06f0 ? cp - 0x06f0 : cp - 0x0660);
  });
}

/** An Arabic name with marks and hamza seats folded, so `الإسراء` and `الاسراء` agree. */
function arabicNameKey(name: string): string {
  return name
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[ٱأإآ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/[ةہۃ]/g, 'ه')
    .replace(/\s+/g, ' ')
    .trim();
}

const ARTICLE = /^(?:al|an|ar|as|ash|at|ath|ad|adh|az|aal|ali|el)[-\s'’]+/;

/** Reduce an English surah name to its key; see ENGLISH_KEYS. */
export function englishKey(name: string): string {
  let key = name
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[ʿʾ`]/g, "'")
    .trim();
  key = key.replace(/^(?:surah|surat|sura|sourate|sure|surah\s+al)\s+/, '');
  for (let i = 0; i < 2; i++) key = key.replace(ARTICLE, '');
  key = key.replace(/[^a-z]/g, '');
  // Spelling variants a model produces for the same name.
  key = key.replace(/aa/g, 'a').replace(/ee/g, 'i').replace(/oo/g, 'u');
  return key;
}

const ENGLISH_ALIASES: Readonly<Record<string, string>> = {
  fatiha: 'fatihah', baqara: 'baqarah', aliimran: 'imran', maida: 'maidah', tawba: 'tawbah',
  tauba: 'tawbah', anaam: 'anam', yaseen: 'yasin', yasin: 'yasin', sajda: 'sajdah',
  jathiya: 'jathiyah', waqia: 'waqiah', mujadila: 'mujadilah', mumtahana: 'mumtahanah',
  juma: 'jumuah', jumua: 'jumuah', haqqa: 'haqqah', qiyama: 'qiyamah', ghashiya: 'ghashiyah',
  bayyina: 'bayyinah', zalzala: 'zalzalah', qaria: 'qariah', humaza: 'humazah', inshirah: 'sharh',
  kafirun: 'kafirun', kafiroon: 'kafirun', muminoon: 'muminun', munafiqoon: 'munafiqun',
  toor: 'tur', noor: 'nur', room: 'rum', hood: 'hud', nooh: 'nuh', teen: 'tin', feel: 'fil',
  layl: 'layl', lail: 'layl', duhaa: 'duha', quraish: 'quraysh', kauthar: 'kawthar', kausar: 'kawthar',
  ikhlaas: 'ikhlas', naas: 'nas', asr: 'asr', isra: 'isra', israa: 'isra', taha: 'taha',
};

const ARABIC_NAME_TO_SURAH = new Map<string, number>(
  ARABIC_NAMES.map((name, i) => [arabicNameKey(name), i + 1]),
);
const ENGLISH_KEY_TO_SURAH = new Map<string, number>(ENGLISH_KEYS.map((key, i) => [key, i + 1]));

export function surahByArabicName(name: string): number | null {
  const key = arabicNameKey(name);
  return ARABIC_NAME_TO_SURAH.get(key) ?? ARABIC_NAME_TO_SURAH.get(`ال${key}`) ?? null;
}

export function surahByEnglishName(name: string): number | null {
  const key = englishKey(name);
  if (!key) return null;
  const direct = ENGLISH_KEY_TO_SURAH.get(key) ?? ENGLISH_KEY_TO_SURAH.get(ENGLISH_ALIASES[key] ?? '');
  if (direct) return direct;
  // A trailing h is optional in transliteration (Baqara / Baqarah).
  return ENGLISH_KEY_TO_SURAH.get(`${key}h`) ?? ENGLISH_KEY_TO_SURAH.get(key.replace(/h$/, '')) ?? null;
}

/**
 * `surah:ayah` and `surah:ayah-ayah`. Not preceded by a digit, colon or underscore (an
 * `LK id 1_23_42`, a time), and not followed by another `:digit` or by an underscore.
 */
const NUMERIC_REF = /(?<![\d:_])(\d{1,3})\s?:\s?(\d{1,3})(?:\s?[-–—]\s?(\d{1,3}))?(?![\d_]|\s?:\s?\d)/g;

const AYAH_WORD = '(?:الآيات|الآيتان|الآيتين|الآية|آية|اية|الاية|آیت|ayahs?|ayat|ayet|verses?|versets?|ayat|v\\.)';
const ARABIC_NAME_ALT = [...ARABIC_NAME_TO_SURAH.keys()]
  .sort((a, b) => b.length - a.length)
  // The keys are folded (arabicNameKey); widen each folded letter back to what a model
  // may write, so `المؤمنون`, `المائدة` and `الإسراء` are found as written.
  .map((name) =>
    [...name]
      .map((ch, i) => {
        if (ch === 'ا') return '[اأإآٱ]';
        if (ch === 'و') return '[وؤ]';
        if (ch === 'ي') return '[يئى]';
        if (ch === 'ه' && i === name.length - 1) return '[هةہ]';
        return ch;
      })
      .join(''),
  )
  .join('|');

/**
 * A surah named in Arabic, then an ayah number: `سورة الطور: 48`, `[الطور: 48]`,
 * `(البقرة، الآية 255)`. Short names are ordinary words (ص, ق, محمد), so the name must
 * follow سورة or open a bracket.
 */
const ARABIC_NAMED_REF = new RegExp(
  `(?:(?:سورة|سورۃ)\\s+|[\\[\\(﴿])(${ARABIC_NAME_ALT})\\s*[:،,]?\\s*(?:${AYAH_WORD}\\s*[:]?\\s*)?(\\d{1,3})(?:\\s?[-–—]\\s?(\\d{1,3}))?`,
  'gu',
);

/**
 * A surah named in Latin script, then an ayah number: `Surah At-Tur, verse 48`,
 * `Sourate Al-Baqara, verset 255`, `Surah Ash-Sharh (94), Verse 6`, `Surah Al-Baqarah: 255`,
 * `QS. Al-Baqarah [2]: 255`. The word for "surah" (or QS) is required, and then either a
 * word for "verse" or a colon before the number.
 */
const LATIN_NAMED_REF = new RegExp(
  `\\b(?:surah|surat|sura|sourate|sure|qs\\.?)\\s+([\\p{L}'’ʿʾ\`-]+(?:[\\s-][\\p{L}'’ʿʾ\`-]+)?)\\s*(?:[\\[(]\\d{1,3}[\\])])?\\s*(?:[,(]?\\s*${AYAH_WORD}\\s*:?|:)\\s*(\\d{1,3})(?:\\s?[-–—]\\s?(\\d{1,3}))?`,
  'giu',
);

/** Every Quran reference in `text`, in order of appearance, overlapping finds merged. */
export function findRefs(text: string): RefOccurrence[] {
  const ascii = asciiDigits(text);
  const found: RefOccurrence[] = [];

  for (const m of ascii.matchAll(NUMERIC_REF)) {
    const ref = validRef(Number(m[1]), Number(m[2]), m[3] === undefined ? undefined : Number(m[3]));
    // An out-of-range end (`2:255-300`) is not a range; keep the first verse.
    const single = ref ?? (m[3] !== undefined ? validRef(Number(m[1]), Number(m[2])) : null);
    if (single) found.push({ ...single, start: m.index, end: m.index + m[0].length, form: 'numeric' });
  }

  for (const m of ascii.matchAll(ARABIC_NAMED_REF)) {
    const surah = surahByArabicName(m[1]);
    if (!surah) continue;
    const ref = validRef(surah, Number(m[2]), m[3] === undefined ? undefined : Number(m[3]));
    if (ref) found.push({ ...ref, start: m.index, end: m.index + m[0].length, form: 'named' });
  }

  for (const m of ascii.matchAll(LATIN_NAMED_REF)) {
    const surah = surahByEnglishName(m[1]);
    if (!surah) continue;
    const ref = validRef(surah, Number(m[2]), m[3] === undefined ? undefined : Number(m[3]));
    if (ref) found.push({ ...ref, start: m.index, end: m.index + m[0].length, form: 'named' });
  }

  found.sort((a, b) => a.start - b.start || b.end - a.end);
  // A named reference that contains a numeric one ("Surah At-Tur 52:48") is one reference.
  const merged: RefOccurrence[] = [];
  for (const ref of found) {
    const prev = merged[merged.length - 1];
    if (prev && ref.start < prev.end) continue;
    merged.push(ref);
  }
  return merged;
}
