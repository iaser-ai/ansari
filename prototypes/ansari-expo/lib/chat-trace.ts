import type { ChatStreamEvent } from '@/lib/api';

/**
 * The transient retrieval trace shown while the assistant is still working:
 * one line per tool call, driven live by the stream's `tool_call` /
 * `tool_result` events (see the chat screen's `onEvent` wiring).
 *
 * It is deliberately transient — shown ONLY while awaiting the answer, never
 * persisted or replayed on reload — and it is NOT citation UI: it shows what the
 * answer is being built FROM, not the sources the finished answer cites. Keeping
 * the reducer and the copy pure lets the honesty rules (`resultCount: 0` reads
 * "no hadith found", never "0 results") be unit-tested without React Native.
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

/**
 * Render one trace entry as a single line, in the answer's own voice:
 *  - pending                → `Searching hadith…`
 *  - completed, count > 0   → `Searching hadith for "patience" — 12 results`
 *  - completed, count === 0 → `no hadith found` (honest, never "0 results")
 * Missing query/count degrade to a plain "Searched …" line rather than inventing
 * detail.
 */
export function formatTraceLine(entry: TraceEntry): string {
  const named = entry.tool !== GENERIC_TOOL;
  if (entry.pending) {
    return `Searching ${entry.tool}…`;
  }
  if (entry.resultCount === 0) {
    return named ? `no ${entry.tool} found` : 'no results found';
  }
  if (
    typeof entry.query === 'string' &&
    entry.query.length > 0 &&
    typeof entry.resultCount === 'number'
  ) {
    return `Searching ${entry.tool} for "${entry.query}" — ${entry.resultCount} ${plural(entry.resultCount)}`;
  }
  if (typeof entry.resultCount === 'number') {
    return `Searched ${entry.tool} — ${entry.resultCount} ${plural(entry.resultCount)}`;
  }
  return `Searched ${entry.tool}`;
}

function plural(n: number): string {
  return n === 1 ? 'result' : 'results';
}
