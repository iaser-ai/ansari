import { describe, expect, it } from 'vitest';
import {
  displayTool,
  sourceProgress,
  traceReducer,
  type TraceEntry,
} from '@/lib/chat-trace';
import type { ChatStreamEvent } from '@/lib/api';

const call = (name?: string): ChatStreamEvent => ({ type: 'tool_call', name });
const result = (
  tool?: string,
  query?: string,
  resultCount?: number,
): ChatStreamEvent => ({ type: 'tool_result', tool, query, resultCount });

const reduce = (events: ChatStreamEvent[]): TraceEntry[] =>
  events.reduce(traceReducer, [] as TraceEntry[]);

describe('displayTool — backend tool id → bare inline label', () => {
  it('strips the search_ prefix from the facilitator tool ids', () => {
    expect(displayTool('search_quran')).toBe('quran');
    expect(displayTool('search_hadith')).toBe('hadith');
    expect(displayTool('search_mawsuah')).toBe('mawsuah');
  });

  it('flattens underscores in a multi-word id', () => {
    expect(displayTool('search_tafsir_encyclopedia')).toBe('tafsir encyclopedia');
  });

  it('passes an unknown / unprefixed tool id through (underscores flattened)', () => {
    expect(displayTool('search_something_new')).toBe('something new');
    expect(displayTool('lexicon')).toBe('lexicon');
  });

  it('falls back to the generic label for an absent or empty id (GENERIC_TOOL path)', () => {
    expect(displayTool(undefined)).toBe('the sources');
    expect(displayTool('')).toBe('the sources');
    expect(displayTool('search_')).toBe('the sources');
  });
});

describe('traceReducer', () => {
  it('opens a pending entry on tool_call and completes it on the matching tool_result', () => {
    const entries = reduce([
      call('search_hadith'),
      result('search_hadith', 'patience', 12),
    ]);
    expect(entries).toEqual([
      { tool: 'hadith', query: 'patience', resultCount: 12, pending: false },
    ]);
  });

  it('completes the earliest pending entry (facilitator searches one tool at a time)', () => {
    const entries = reduce([
      call('search_hadith'),
      call('search_quran'),
      result('search_hadith', 'patience', 3),
    ]);
    expect(entries[0]).toEqual({
      tool: 'hadith',
      query: 'patience',
      resultCount: 3,
      pending: false,
    });
    expect(entries[1]).toEqual({ tool: 'quran', pending: true });
  });

  it('matches by tool so parallel calls resolving out of order land on the right line', () => {
    // Two calls open, the SECOND tool resolves first — it must complete the
    // quran entry, leaving hadith pending (not complete the earliest by position).
    const entries = reduce([
      call('search_hadith'),
      call('search_quran'),
      result('search_quran', 'mercy', 7),
    ]);
    expect(entries[0]).toEqual({ tool: 'hadith', pending: true });
    expect(entries[1]).toEqual({
      tool: 'quran',
      query: 'mercy',
      resultCount: 7,
      pending: false,
    });
  });

  it('falls back to the earliest pending entry when no pending tool matches (name mismatch)', () => {
    const entries = reduce([call('search_hadith'), result('search_quran', 'mercy', 2)]);
    // No pending "quran" entry; rather than strand the hadith spinner, the
    // result completes it with the result's authoritative tool label.
    expect(entries).toEqual([
      { tool: 'quran', query: 'mercy', resultCount: 2, pending: false },
    ]);
  });

  it('appends a completed entry when a tool_result has no preceding call', () => {
    const entries = reduce([result('search_quran', 'mercy', 5)]);
    expect(entries).toEqual([
      { tool: 'quran', query: 'mercy', resultCount: 5, pending: false },
    ]);
  });

  it('ignores non-tool events', () => {
    const before = reduce([call('hadith')]);
    const after = [
      { type: 'text', content: 'hi' } as ChatStreamEvent,
      { type: 'done' } as ChatStreamEvent,
    ].reduce(traceReducer, before);
    expect(after).toEqual(before);
  });
});

describe('sourceProgress — per-call entries → the fixed source row', () => {
  const states = (events: ChatStreamEvent[]) =>
    Object.fromEntries(sourceProgress(reduce(events)).sources.map((s) => [s.label, s.state]));

  it('shows all four sources idle, in catalogue order, before any tool event', () => {
    expect(sourceProgress([])).toEqual({
      phase: 'searching',
      sources: [
        { key: 'quran', label: "Qur'an", state: 'idle' },
        { key: 'hadith', label: 'Hadith', state: 'idle' },
        { key: 'tafsir encyclopedia', label: 'Tafsir', state: 'idle' },
        { key: 'mawsuah', label: 'Fiqh', state: 'idle' },
      ],
    });
  });

  it('marks a source searching while its call is in flight', () => {
    expect(states([call('search_hadith')])).toEqual({
      "Qur'an": 'idle',
      Hadith: 'searching',
      Tafsir: 'idle',
      Fiqh: 'idle',
    });
  });

  it('marks a source done once its call resolves — including a search that found nothing', () => {
    expect(
      states([
        call('search_quran'),
        result('search_quran', 'mercy', 4),
        call('search_mawsuah'),
        result('search_mawsuah', 'riba', 0),
      ]),
    ).toMatchObject({ "Qur'an": 'done', Fiqh: 'done', Hadith: 'idle' });
  });

  it('keeps a source searching until every one of its calls has resolved', () => {
    const open = [call('search_quran'), call('search_quran'), result('search_quran', 'a', 2)];
    expect(states(open)["Qur'an"]).toBe('searching');
    expect(states([...open, result('search_quran', 'b', 3)])["Qur'an"]).toBe('done');
  });

  it('returns a finished source to searching when a later round searches it again', () => {
    expect(
      states([call('search_hadith'), result('search_hadith', 'a', 1), call('search_hadith')])
        .Hadith,
    ).toBe('searching');
  });

  it('leaves no source stuck searching after a call/result name mismatch', () => {
    // traceReducer's fallback re-labels the pending hadith entry as quran.
    expect(states([call('search_hadith'), result('search_quran', 'mercy', 2)])).toEqual({
      "Qur'an": 'done',
      Hadith: 'idle',
      Tafsir: 'idle',
      Fiqh: 'idle',
    });
  });

  it('appends a tool outside the catalogue rather than dropping it', () => {
    const { sources } = sourceProgress(reduce([call('search_fatwa_archive')]));
    expect(sources.map((s) => s.label)).toEqual([
      "Qur'an",
      'Hadith',
      'Tafsir',
      'Fiqh',
      'Fatwa Archive',
    ]);
    expect(sources[4].state).toBe('searching');
  });

  it('counts a nameless call toward the phase without lighting any source', () => {
    const progress = sourceProgress(reduce([call()]));
    expect(progress.phase).toBe('searching');
    expect(progress.sources.every((s) => s.state === 'idle')).toBe(true);
  });

  it("reads 'searched' once there are calls and every one has resolved", () => {
    expect(sourceProgress(reduce([call('search_quran')])).phase).toBe('searching');
    expect(
      sourceProgress(reduce([call('search_quran'), result('search_quran', 'm', 1)])).phase,
    ).toBe('searched');
  });
});
