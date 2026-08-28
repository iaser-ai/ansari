import { describe, expect, it } from 'vitest';
import {
  ChatStreamError,
  reduceChatStream,
  type ChatStreamEvent,
} from '@/lib/api/chat-stream';

const text = (s: string) => `data: ${JSON.stringify({ type: 'text', content: s })}\n\n`;
const done = 'data: {"type":"done"}\n\n';

describe('reduceChatStream — happy path', () => {
  it('reassembles text events and returns the answer on done', () => {
    expect(reduceChatStream([text('Hello, '), text('world.'), done])).toBe(
      'Hello, world.',
    );
  });

  it('ignores heartbeat comment lines', () => {
    expect(reduceChatStream([': ping\n\n', text('A'), ': ping\n\n', text('B'), done])).toBe(
      'AB',
    );
  });

  it('reassembles an event split across chunks', () => {
    const frame = text('multi-chunk');
    const mid = Math.floor(frame.length / 2);
    expect(reduceChatStream([frame.slice(0, mid), frame.slice(mid), done])).toBe(
      'multi-chunk',
    );
  });

  it('forwards every event to the onEvent listener', () => {
    const seen: ChatStreamEvent[] = [];
    reduceChatStream(
      [text('hi'), 'data: {"type":"tool_call","name":"search"}\n\n', done],
      (e) => seen.push(e),
    );
    expect(seen).toContainEqual({ type: 'tool_call', name: 'search' });
    expect(seen.at(-1)).toEqual({ type: 'done' });
  });
});

describe('reduceChatStream — loud failures', () => {
  it('throws on a malformed (non-JSON) data frame instead of skipping it', () => {
    expect(() => reduceChatStream(['data: not json at all\n\n', done])).toThrow(
      ChatStreamError,
    );
  });

  it('surfaces an error event as a thrown ChatStreamError with its message', () => {
    expect(() =>
      reduceChatStream([text('partial'), 'data: {"type":"error","message":"boom"}\n\n']),
    ).toThrowError(/boom/);
  });

  it('throws on a text frame whose content is not a string', () => {
    expect(() =>
      reduceChatStream(['data: {"type":"text","content":123}\n\n', done]),
    ).toThrow(ChatStreamError);
  });

  it('throws when the stream ends WITHOUT a done frame', () => {
    // This is the truncation guard: partial text must not resolve as success.
    expect(() => reduceChatStream([text('half an answer')])).toThrow(
      /ended before completion/,
    );
  });

  it('a stream that IS terminated by done does not throw', () => {
    expect(() => reduceChatStream([text('complete'), done])).not.toThrow();
  });
});
