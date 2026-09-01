import { describe, expect, it } from 'vitest';
import {
  formatTraceLine,
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

describe('traceReducer', () => {
  it('opens a pending entry on tool_call and completes it on the matching tool_result', () => {
    const entries = reduce([call('hadith'), result('hadith', 'patience', 12)]);
    expect(entries).toEqual([
      { tool: 'hadith', query: 'patience', resultCount: 12, pending: false },
    ]);
  });

  it('completes the earliest pending entry (facilitator searches one tool at a time)', () => {
    const entries = reduce([
      call('hadith'),
      call('quran'),
      result('hadith', 'patience', 3),
    ]);
    expect(entries[0]).toEqual({
      tool: 'hadith',
      query: 'patience',
      resultCount: 3,
      pending: false,
    });
    expect(entries[1]).toEqual({ tool: 'quran', pending: true });
  });

  it('appends a completed entry when a tool_result has no preceding call', () => {
    const entries = reduce([result('quran', 'mercy', 5)]);
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

describe('formatTraceLine', () => {
  it('renders a pending line while awaiting the result', () => {
    expect(formatTraceLine({ tool: 'hadith', pending: true })).toBe(
      'Searching hadith…',
    );
  });

  it('renders query and result count for a completed search', () => {
    expect(
      formatTraceLine({
        tool: 'hadith',
        query: 'patience',
        resultCount: 12,
        pending: false,
      }),
    ).toBe('Searching hadith for "patience" — 12 results');
  });

  it('reads honestly when a search finds nothing (never "0 results")', () => {
    expect(
      formatTraceLine({
        tool: 'hadith',
        query: 'patience',
        resultCount: 0,
        pending: false,
      }),
    ).toBe('no hadith found');
  });

  it('uses the singular for exactly one result', () => {
    expect(
      formatTraceLine({
        tool: 'quran',
        query: 'mercy',
        resultCount: 1,
        pending: false,
      }),
    ).toBe('Searching quran for "mercy" — 1 result');
  });

  it('degrades gracefully when the tool name is missing', () => {
    expect(formatTraceLine({ tool: 'the sources', pending: true })).toBe(
      'Searching the sources…',
    );
    expect(
      formatTraceLine({ tool: 'the sources', resultCount: 0, pending: false }),
    ).toBe('no results found');
  });
});
