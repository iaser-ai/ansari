/**
 * Does every hadith citation carry an `LK id` that a search actually returned?
 *
 * The facilitator prompt requires the id to be copied from the search result. So every
 * `LK id <id>` token in an answer is looked up among the ids search_hadith returned:
 * in this turn, in an earlier turn of the conversation, or nowhere (`fabricated`).
 * Alongside: citation entries that read as hadith but carry no id, and whether the grade
 * an answer states for a cited hadith agrees with the grade the search returned.
 */
import { parseAnswer } from './answer';
import { findRefs } from './quran-refs';
import type { RetrievedHadith } from './sources';

/** As apps/frontend reads it (`lib/citations.ts`): the literal "LK id", then the id. */
const LK_ID = /\bLK id[ \t]*:?[ \t]*([A-Za-z0-9_-]+)/gi;

export type GradeClass = 'sahih' | 'hasan' | 'daif' | 'mawdu';

const GRADE_PATTERNS: ReadonlyArray<readonly [GradeClass, RegExp]> = [
  ['sahih', /\b(?:sahih|saheeh|sahīh|authentic|sound)\b|صحيح/iu],
  ['hasan', /\b(?:hasan|hassan|good|fair)\b|حسن/iu],
  ['daif', /\b(?:da['’ʿ]?if|da['’ʿ]?eef|daeef|weak)\b|ضعيف/iu],
  ['mawdu', /\b(?:mawdu['’ʿ]?|mawdoo['’ʿ]?|fabricated|forged)\b|موضوع/iu],
];

/** The grade classes a piece of text names. Diacritics folded first (Ṣaḥīḥ, Ḍaʿīf). */
export function gradeClasses(text: string): GradeClass[] {
  const plain = text.normalize('NFD').replace(/[̀-ͯ]/g, '');
  return GRADE_PATTERNS.filter(([, pattern]) => pattern.test(plain)).map(([name]) => name);
}

/**
 * A grade as an answer states it: the word for "grade", then what follows on the line.
 * Only a statement introduced this way is read, so `Sahih Bukhari` (a book) and
 * `al-Hasan` (a narrator) are never taken for a grade.
 */
const GRADE_STATEMENT =
  /(?:\bgraded?\b|\bgrading\b|\bauthenticity\b|\bderajat\b|\bdegré\b|\bgrado\b|\bderece\b|\bstatus\b|الدرجة|درجة|درجته|الحكم|حكمه|درجہ)[ \t]*(?:as|is|of)?[ \t]*[:：\-–—]?[ \t]*([^\n\])]{0,60})/giu;

const HADITH_ENTRY =
  /bukhari|tirmidhi|tirmizi|abu\s*daw|abi\s*daw|nasa['’]?i|ibn\s*maja|muwatta|musnad|darimi|riyad|hadith|hadis|hadits|sunan|sahih\s+muslim|البخاري|صحيح مسلم|الترمذي|[أا]بو داود|[أا]بي داود|النسائي|ابن ماجه|موط[أا]|مسند|حديث/iu;
const NOT_HADITH_ENTRY = /qur['’]?an|koran|coran|القر[آا]ن|tafsir|tafseer|تفسير|mawsu|موسوعة/iu;

export type LkStatus = 'this_turn' | 'earlier_turn' | 'fabricated';
export type GradeAgreement = 'matches' | 'contradicts' | 'not_stated' | 'no_grade_in_source';

export interface LkIdScore {
  id: string;
  status: LkStatus;
  /** Null for a fabricated id: there is no source grade to agree with. */
  grade: GradeAgreement | null;
  sourceGrade?: string;
  stated?: GradeClass[];
}

export interface HadithScore {
  lkIds: LkIdScore[];
  total: number;
  thisTurn: number;
  earlierTurn: number;
  fabricated: number;
  /** Citation entries that read as hadith and carry no LK id: their first lines. */
  entriesWithoutLkId: string[];
  grades: Record<GradeAgreement, number>;
}

export interface HadithInput {
  answer: string;
  thisTurn: RetrievedHadith[];
  earlierTurns: RetrievedHadith[];
}

function lineAt(text: string, index: number): string {
  const from = text.lastIndexOf('\n', index - 1) + 1;
  const to = text.indexOf('\n', index);
  return text.slice(from, to === -1 ? text.length : to);
}

export function scoreHadith(input: HadithInput): HadithScore {
  const parsed = parseAnswer(input.answer);
  const now = new Map(input.thisTurn.map((h) => [h.lkId, h]));
  const before = new Map(input.earlierTurns.map((h) => [h.lkId, h]));

  // Each id once, with every place it is written (its citation entry, or its line).
  const contexts = new Map<string, string[]>();
  for (const m of input.answer.matchAll(LK_ID)) {
    const id = m[1].replace(/[-_]+$/, '');
    if (!id) continue;
    const entry = parsed.entries.find((e) => m.index >= e.start && m.index < e.end);
    const context = entry ? entry.text : lineAt(input.answer, m.index);
    contexts.set(id, [...(contexts.get(id) ?? []), context]);
  }

  const grades: Record<GradeAgreement, number> = { matches: 0, contradicts: 0, not_stated: 0, no_grade_in_source: 0 };
  const lkIds: LkIdScore[] = [...contexts].map(([id, places]) => {
    const source = now.get(id) ?? before.get(id);
    if (!source) return { id, status: 'fabricated' as const, grade: null };
    const status: LkStatus = now.has(id) ? 'this_turn' : 'earlier_turn';
    const sourceClasses = gradeClasses(source.grade);
    const stated = new Set<GradeClass>();
    for (const place of places) {
      for (const m of place.matchAll(GRADE_STATEMENT)) for (const c of gradeClasses(m[1])) stated.add(c);
    }
    let grade: GradeAgreement;
    if (sourceClasses.length === 0) grade = 'no_grade_in_source';
    else if (stated.size === 0) grade = 'not_stated';
    else grade = sourceClasses.some((c) => stated.has(c)) ? 'matches' : 'contradicts';
    grades[grade]++;
    return { id, status, grade, sourceGrade: source.grade, stated: [...stated] };
  });

  const entriesWithoutLkId = parsed.entries
    .filter((entry) => {
      const title = entry.text.split('\n')[0];
      if (!HADITH_ENTRY.test(title) || NOT_HADITH_ENTRY.test(title)) return false;
      if (findRefs(title).length > 0) return false;
      return !/\bLK id\b/i.test(entry.text);
    })
    .map((entry) => entry.text.split('\n')[0].trim());

  return {
    lkIds,
    total: lkIds.length,
    thisTurn: lkIds.filter((l) => l.status === 'this_turn').length,
    earlierTurn: lkIds.filter((l) => l.status === 'earlier_turn').length,
    fabricated: lkIds.filter((l) => l.status === 'fabricated').length,
    entriesWithoutLkId,
    grades,
  };
}
