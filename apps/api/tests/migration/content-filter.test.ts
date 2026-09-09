import { describe, it, expect, vi, beforeEach } from 'vitest';
import { filterMessage } from '../../scripts/migrate-users/source/content-filter';
import type { SourceMessage } from '../../scripts/migrate-users/types';

const makeMsg = (overrides: Partial<SourceMessage>): SourceMessage => ({
  mongoId: 'msg-001',
  role: 'user',
  content: 'Hello',
  createdAt: new Date('2024-01-15'),
  ...overrides,
});

describe('filterMessage', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  // --- String content ---

  it('wraps plain string content as a text block', () => {
    const result = filterMessage(makeMsg({ content: 'Hello world' }));
    expect(result).not.toBeNull();
    expect(result!.content).toEqual([{ type: 'text', text: 'Hello world' }]);
    expect(result!.role).toBe('user');
    expect(result!.mongoId).toBe('msg-001');
  });

  // --- Array content ---

  it('keeps text blocks from array content', () => {
    const result = filterMessage(makeMsg({
      content: [
        { type: 'text', text: 'First paragraph' },
        { type: 'text', text: 'Second paragraph' },
      ],
    }));
    expect(result!.content).toHaveLength(2);
    expect(result!.content[0]).toEqual({ type: 'text', text: 'First paragraph' });
    expect(result!.content[1]).toEqual({ type: 'text', text: 'Second paragraph' });
  });

  it('drops tool_use blocks silently', () => {
    const result = filterMessage(makeMsg({
      content: [
        { type: 'text', text: 'Searching...' },
        { type: 'tool_use', id: 'tool-1', name: 'search', input: {} },
      ],
    }));
    expect(result!.content).toHaveLength(1);
    expect(result!.content[0]).toEqual({ type: 'text', text: 'Searching...' });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('drops tool_result blocks silently', () => {
    const result = filterMessage(makeMsg({
      content: [
        { type: 'tool_result', content: 'result data' },
        { type: 'text', text: 'Here are the results' },
      ],
    }));
    expect(result!.content).toHaveLength(1);
    expect(result!.content[0]).toEqual({ type: 'text', text: 'Here are the results' });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('drops document blocks silently', () => {
    const result = filterMessage(makeMsg({
      content: [
        { type: 'document', source: { type: 'base64' } },
        { type: 'text', text: 'Summary' },
      ],
    }));
    expect(result!.content).toHaveLength(1);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('warns about unrecognized block types and drops them', () => {
    const result = filterMessage(makeMsg({
      content: [
        { type: 'text', text: 'Valid' },
        { type: 'image_url', url: 'https://example.com/img.png' },
      ],
    }));
    expect(result!.content).toHaveLength(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('image_url'),
    );
  });

  // --- Null / empty returns ---

  it('returns null for tool-role messages', () => {
    expect(filterMessage(makeMsg({ role: 'tool' }))).toBeNull();
  });

  it('returns null for null content', () => {
    expect(filterMessage(makeMsg({ content: null as unknown as string }))).toBeNull();
  });

  it('returns null for empty string content', () => {
    expect(filterMessage(makeMsg({ content: '' }))).toBeNull();
  });

  it('returns null when all array blocks are filtered out', () => {
    const result = filterMessage(makeMsg({
      content: [
        { type: 'tool_use', id: 'tool-1', name: 'search', input: {} },
        { type: 'tool_result', content: 'data' },
      ],
    }));
    expect(result).toBeNull();
  });

  // --- Metadata preservation ---

  it('preserves createdAt from source message', () => {
    const date = new Date('2024-06-15T10:30:00Z');
    const result = filterMessage(makeMsg({ createdAt: date }));
    expect(result!.createdAt).toEqual(date);
  });

  it('preserves null createdAt', () => {
    const result = filterMessage(makeMsg({ createdAt: null }));
    expect(result!.createdAt).toBeNull();
  });

  it('preserves assistant role', () => {
    const result = filterMessage(makeMsg({ role: 'assistant' }));
    expect(result!.role).toBe('assistant');
  });
});
