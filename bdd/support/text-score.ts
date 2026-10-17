/**
 * How much of an image's real text a model's answer recovered.
 *
 * Scored as word recall: the share of the real words that appear in the
 * answer, each counted at most as often as it appears in the real text. Recall
 * (not exact match) because the answer may add an introduction or commentary
 * around the transcription, and that should not count against the reading.
 *
 * The Quran answer keys are Uthmani script, which spells some words differently
 * from what a model types (ءَايَٰت for آيات, ٱلَّذِى for الذي) and uses its own
 * sukun and pause marks. Those are spelling conventions, not reading mistakes,
 * so both sides are normalised the same way before comparing.
 */

// Every Arabic mark: harakat, tanween, shadda, sukun, superscript alef, maddah,
// hamza above/below, Quranic small letters and pause marks, open tanween.
const ALL_MARKS = /[ؐ-ًؚ-ٰٟۖ-ۭ࣓-ࣿ]/g;
// Kept for the "with diacritics" score: harakat, tanween, shadda, sukun, superscript alef.
const SCORED_MARKS = /[ً-ْٰ]/;
const TATWEEL = /ـ/g;
// Punctuation in both scripts; letters, digits and marks are kept.
const PUNCTUATION = /[.,;:!?"'()\[\]{}«»“”‘’\-–—_*#/\\|<>،؛؟٫٬۞]/g;

function normaliseLetters(t: string): string {
  return (
    t
      // Uthmani hamza-then-alef is how it writes a long initial alef (ءَامَنُوا = آمنوا).
      .replace(/ء([ً-ْٰۖ-ۭ]*)ا/g, 'ا$1')
      // Alef forms (wasla, madda, hamza above/below) → bare alef.
      .replace(/[ٱآأإ]/g, 'ا')
      // Alef maksura and yeh are interchangeable at word end in print.
      .replace(/ى/g, 'ي')
  );
}

function normaliseMarks(t: string): string {
  return (
    t
      // Uthmani sukun (small high dotless head of khah) → standard sukun.
      .replace(/ۡ/g, 'ْ')
      // Open tanween → standard tanween.
      .replace(/ࣰ/g, 'ً')
      .replace(/ࣱ/g, 'ٌ')
      .replace(/ࣲ/g, 'ٍ')
      // Drop every mark that is not scored.
      .replace(ALL_MARKS, (m) => (SCORED_MARKS.test(m) ? m : ''))
  );
}

const ALEF = 'ا';
const SUPERSCRIPT_ALEF = 'ٰ';
const SHADDA = 'ّ';
const SUKUN = 'ْ';
const IS_MARK = new RegExp(`^${ALL_MARKS.source}$`);

/**
 * One comparable key per word. Alefs are left out of the comparison: long-vowel
 * spelling is where Uthmani and normal print differ most (عَٰهَدُوا vs عَاهَدُوا,
 * ذَٰلِكَ vs ذَلِكَ), and dropping it on both sides makes those agree. The cost
 * is that rare pairs differing only by an alef (قال / قل) also agree.
 *
 * With diacritics, the key also carries each consonant's vowel marks. A shadda
 * on a word's FIRST letter is ignored: that is the Uthmani tajweed mark for
 * assimilation (مِّنَ), which normal print leaves out. A sukun counts the same
 * as no mark: it only means "no vowel", and Uthmani leaves it off letters that
 * are assimilated or hidden in recitation (مِنْهُم vs مِنۡهُمۡ / مِنهُم).
 */
function wordKey(word: string, keepDiacritics: boolean): string {
  const letters: { ch: string; marks: string[] }[] = [];
  for (const ch of word) {
    if (ch === SUPERSCRIPT_ALEF) continue;
    if (IS_MARK.test(ch)) {
      letters.at(-1)?.marks.push(ch);
    } else {
      letters.push({ ch, marks: [] });
    }
  }
  const kept: { ch: string; marks: string[] }[] = [];
  for (const l of letters) {
    if (l.ch === ALEF) {
      // Tanween written on the alef (تبديلاً) belongs to the letter before it.
      const prev = kept.at(-1);
      if (prev && prev.marks.length === 0) prev.marks.push(...l.marks);
      continue;
    }
    kept.push(l);
  }
  if (kept.length > 0) kept[0].marks = kept[0].marks.filter((m) => m !== SHADDA);
  for (const l of kept) l.marks = l.marks.filter((m) => m !== SUKUN);
  const skeleton = kept.map((l) => l.ch).join('');
  if (!keepDiacritics) return skeleton;
  return `${skeleton}|${kept.map((l) => [...new Set(l.marks)].sort().join('')).join('.')}`;
}

function words(text: string, keepDiacritics: boolean): string[] {
  const t = normaliseLetters(normaliseMarks(text.normalize('NFC').replace(TATWEEL, '').replace(PUNCTUATION, ' ').toLowerCase()));
  return t
    .split(/\s+/)
    .map((w) => wordKey(w, keepDiacritics))
    .filter((k) => k.length > 0 && !k.startsWith('|'));
}

export function wordRecall(truth: string, answer: string, keepDiacritics: boolean): number {
  const expected = words(truth, keepDiacritics);
  if (expected.length === 0) return 1;
  const available = new Map<string, number>();
  for (const w of words(answer, keepDiacritics)) available.set(w, (available.get(w) ?? 0) + 1);
  let found = 0;
  for (const w of expected) {
    const n = available.get(w) ?? 0;
    if (n > 0) {
      found += 1;
      available.set(w, n - 1);
    }
  }
  return found / expected.length;
}

/** Whether the real text has any scored diacritics (else "with diacritics" equals "without"). */
export function hasDiacritics(text: string): boolean {
  return new RegExp(SCORED_MARKS.source).test(normaliseMarks(text));
}
