import type { ChatStreamEvent } from '@/lib/api';

/**
 * The transient retrieval trace shown while the assistant is still working,
 * driven live by the stream's `tool_call` / `tool_result` events (see the chat
 * screen's `onEvent` wiring).
 *
 * Two layers: `traceReducer` records one entry per tool CALL (the hard part —
 * out-of-order results, name mismatches, orphan results), and `sourceProgress`
 * folds those entries into the fixed row of source categories the waiting line
 * shows (issue #204). The row is derived, never stored, so it inherits the
 * reducer's "never strand a spinner" guarantee.
 *
 * It is deliberately transient — shown ONLY while awaiting the answer, never
 * persisted or replayed on reload — and it is NOT citation UI: it shows what the
 * answer is being built FROM, not the sources the finished answer cites.
 */

export interface TraceEntry {
  /** The tool being queried, e.g. "hadith" / "quran"; a generic stand-in when omitted. */
  tool: string;
  /** The search query, once the result arrives. */
  query?: string;
  /** How many results the tool returned. */
  resultCount?: number;
  /** True between the `tool_call` and its matching `tool_result`. */
  pending: boolean;
}

// Used when the backend omits a tool name; phrased so every template still reads
// naturally ("Searching the sources…", "no results found").
const GENERIC_TOOL = 'the sources';

/**
 * Turn a backend tool id into the bare label the trace copy reads inline. The
 * facilitator's tools are named `search_quran` / `search_hadith` /
 * `search_mawsuah` / `search_tafsir_encyclopedia`; stripping the `search_`
 * prefix (and underscores) yields "quran", "hadith", "tafsir encyclopedia" — so
 * a line reads "Searching hadith for …" rather than "Searching search_hadith …".
 * An unknown or unprefixed id passes through (underscores flattened); an absent
 * or empty id falls back to the GENERIC_TOOL path, unchanged.
 */
export function displayTool(raw: string | undefined): string {
  if (!raw) return GENERIC_TOOL;
  const label = raw.replace(/^search_/, '').replace(/_/g, ' ').trim();
  return label.length > 0 ? label : GENERIC_TOOL;
}

/**
 * Fold one stream event into the trace. `tool_call` opens a pending entry;
 * `tool_result` completes the earliest still-pending entry FOR THAT TOOL with the
 * result's authoritative query / count — matching by tool so that parallel tool
 * calls resolving out of order land on the right line. If no pending entry has a
 * matching tool (a call/result name mismatch), it falls back to the earliest
 * pending entry of any tool so a spinner is never stranded; with nothing pending
 * it appends an already-complete line. Non-tool events pass through untouched.
 */
export function traceReducer(
  entries: TraceEntry[],
  event: ChatStreamEvent,
): TraceEntry[] {
  if (event.type === 'tool_call') {
    return [...entries, { tool: displayTool(event.name), pending: true }];
  }
  if (event.type === 'tool_result') {
    const tool = displayTool(event.tool);
    const completed: TraceEntry = {
      tool,
      query: event.query,
      resultCount: event.resultCount,
      pending: false,
    };
    let idx = entries.findIndex((e) => e.pending && e.tool === tool);
    if (idx === -1) idx = entries.findIndex((e) => e.pending);
    if (idx === -1) return [...entries, completed];
    const next = entries.slice();
    next[idx] = completed;
    return next;
  }
  return entries;
}

export type SourceState = 'idle' | 'searching' | 'done';

export interface SourceProgress {
  /** The `displayTool` label the category's entries carry, e.g. "quran". */
  key: string;
  /** What the row reads, e.g. "Qur'an". */
  label: string;
  state: SourceState;
}

/**
 * The sources Ansari can consult, in the order the row shows them — the
 * order the facilitator's prompt lists its tools in
 * (apps/api/lib/ai/prompts/facilitator.ts), and so the order the model
 * usually reaches for them: the row tends to light left to right rather
 * than jumping about. Keys are the `displayTool` labels of the four tools
 * (`TOOL_LABELS`, apps/api/lib/tools/resilience.ts); the Mawsuah is the
 * encyclopedia of fiqh.
 */
export const SOURCE_CATALOGUE: ReadonlyArray<{ key: string; label: string }> = [
  { key: 'quran', label: "Qur'an" },
  { key: 'hadith', label: 'Hadith' },
  { key: 'mawsuah', label: 'Fiqh' },
  { key: 'tafsir encyclopedia', label: 'Tafsir' },
];

/**
 * Fold per-call trace entries into one state per source category:
 *  - `searching` while any of its calls is pending (a category searched again
 *    in a later round goes back to searching),
 *  - `done` once it has calls and all have resolved — a search that found
 *    nothing is still a finished search,
 *  - `idle` if it has not been searched.
 * All four known sources are always present, in catalogue order, so the row
 * never changes shape; a tool outside the catalogue is appended rather than
 * dropped. Nameless entries belong to no category.
 */
export function sourceProgress(entries: TraceEntry[]): SourceProgress[] {
  const categories = SOURCE_CATALOGUE.map(({ key, label }) => ({ key, label }));
  for (const { tool } of entries) {
    if (tool === GENERIC_TOOL) continue;
    if (!categories.some((c) => c.key === tool)) {
      categories.push({ key: tool, label: titleCase(tool) });
    }
  }
  return categories.map(({ key, label }) => {
    const own = entries.filter((e) => e.tool === key);
    const state: SourceState =
      own.length === 0 ? 'idle' : own.some((e) => e.pending) ? 'searching' : 'done';
    return { key, label, state };
  });
}

function titleCase(label: string): string {
  return label.replace(/\b\w/g, (c) => c.toUpperCase());
}
