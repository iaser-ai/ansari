/**
 * What the search tools returned, read back out of the facilitator's tool-call records:
 * the Quran verses and the hadith a turn retrieved, and the text of every other result.
 * These are the texts an answer's quotes and `LK id` tokens are checked against.
 *
 * The record's `content` is exactly what the model received (`formatToolResultForGemini`):
 * `{ results: [{ title, context, content }], summary }`. search_quran titles a verse
 * `Quran 2:255` with content `{"ar": …, "en": …}`; search_hadith ends its title with
 * `(LK id …)` and carries `{"ar", "en", "grade", "collection", "chapter", "lk_id"}`.
 */
import type { ToolCallRecord } from '@/db/schema/messages';

export type ToolResultRecord = Extract<ToolCallRecord, { type: 'tool_result' }>;
export type ToolUseRecord = Extract<ToolCallRecord, { type: 'tool_use' }>;

export interface RetrievedVerse {
  /** `surah:ayah`. */
  key: string;
  ar: string;
  en: string;
}

export interface RetrievedHadith {
  lkId: string;
  ar: string;
  en: string;
  grade: string;
  collection: string;
}

export interface ToolCallSummary {
  name: string;
  query: string;
  status: string;
  durationMs: number | null;
  resultCount: number;
}

export interface TurnSources {
  verses: RetrievedVerse[];
  hadith: RetrievedHadith[];
  /**
   * The raw text of every result a tool other than search_quran returned (tafsir, fiqh
   * encyclopedia, hadith): Arabic an answer copies from these is that source's text, not
   * a Quran quote.
   */
  otherTexts: string[];
  calls: ToolCallSummary[];
}

const QURAN_TITLE = /^Quran (\d{1,3}):(\d{1,3})$/;

interface GeminiResult {
  title?: unknown;
  content?: unknown;
}

function resultsOf(record: ToolResultRecord): GeminiResult[] {
  const results = (record.content as { results?: unknown }).results;
  return Array.isArray(results) ? (results as GeminiResult[]) : [];
}

function parseJsonObject(text: unknown): Record<string, unknown> | null {
  if (typeof text !== 'string') return null;
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const str = (value: unknown): string => (typeof value === 'string' ? value : '');

/** The verses, hadith and call summaries in one turn's tool-call records. */
export function turnSources(records: ToolCallRecord[] | null | undefined): TurnSources {
  const out: TurnSources = { verses: [], hadith: [], otherTexts: [], calls: [] };
  if (!records) return out;
  const uses = new Map<string, ToolUseRecord>();
  for (const record of records) {
    if (record.type === 'tool_use') {
      uses.set(record.id, record);
      continue;
    }
    const use = uses.get(record.tool_use_id);
    const name = use?.name ?? 'unknown';
    // Only a result the tool actually returned counts as retrieved: a degraded,
    // skipped or refused call carries a notice, not a source.
    if (record.status === 'ok') {
      for (const result of resultsOf(record)) {
        if (name !== 'search_quran' && str(result.content)) out.otherTexts.push(str(result.content));
        const body = parseJsonObject(result.content);
        if (!body) continue;
        const verse = QURAN_TITLE.exec(str(result.title));
        if (name === 'search_quran' && verse) {
          out.verses.push({ key: `${Number(verse[1])}:${Number(verse[2])}`, ar: str(body.ar), en: str(body.en) });
        } else if (name === 'search_hadith' && str(body.lk_id)) {
          out.hadith.push({
            lkId: str(body.lk_id),
            ar: str(body.ar),
            en: str(body.en),
            grade: str(body.grade),
            collection: str(body.collection),
          });
        }
      }
    }
    out.calls.push({
      name,
      query: str(use?.input.query),
      status: record.status,
      durationMs: record.duration_ms,
      // Citable results: a "no results" or "unavailable" notice is not one (spec 168).
      resultCount: (record.citations ?? []).filter((c) => c.enabled).length,
    });
  }
  return out;
}
