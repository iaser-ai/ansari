import { describe, expect, it } from 'vitest';
import { reconcileThread } from '@/lib/chat-reconcile';
import type { Message } from '@/lib/api';

const CID = 'conv1';
const STREAM_KEY = '__streaming-answer-1';

function msg(role: Message['role'], content: string, id = `${role}-${content}`): Message {
  return { id, conversationId: CID, role, content, citations: [], safety: null, createdAt: '' };
}

const base = {
  q: undefined,
  conversationId: CID,
  streamKey: STREAM_KEY,
};

describe('reconcileThread — send-before-detail-load regression', () => {
  // The defect main caught: open an existing thread whose last message is an
  // assistant answer, send before the detail query resolves. With no baseline
  // (sentAtCount === null) the reconciler MUST NOT treat that pre-existing
  // assistant answer as this turn's — doing so drops it and clears the streamed
  // text, breaking progressive rendering in the manual-composer path.
  const prior = [msg('user', 'q1', 'u1'), msg('assistant', 'a1', 'a1')];

  it('refuses to latch onto a pre-existing answer when the baseline is unknown', () => {
    const { landedAnswer, messages } = reconcileThread({
      ...base,
      serverMessages: prior,
      streamingText: 'streaming so far',
      sentAtCount: null, // detail query hadn't resolved at send time
    });

    // Must NOT mistake the old answer for this turn's.
    expect(landedAnswer).toBeNull();
    // The old answer is kept (not sliced away), and the synthetic streaming
    // bubble is present carrying the partial text — progressive render survives.
    expect(messages.map((m) => m.id)).toEqual(['u1', 'a1', STREAM_KEY]);
    const streamed = messages.find((m) => m.id === STREAM_KEY);
    expect(streamed?.content).toBe('streaming so far');
  });

  it('does hand off once a real baseline is known and the NEW answer lands', () => {
    // Baseline captured at send (2 messages: u1, a1). The refetch then appends
    // this turn's user+assistant → 4 messages, last assistant.
    const landed = msg('assistant', 'a2', 'a2');
    const after = [...prior, msg('user', 'q2', 'u2'), landed];
    const { landedAnswer, messages } = reconcileThread({
      ...base,
      serverMessages: after,
      streamingText: 'streaming so far',
      sentAtCount: 2,
    });
    expect(landedAnswer).toBe(landed);
    // While streaming, the just-landed answer is held back (the synthetic stands
    // in) so it never renders twice.
    expect(messages.map((m) => m.id)).toEqual(['u1', 'a1', 'u2', STREAM_KEY]);
  });

  it('does NOT hand off while the thread is still stale (count not yet grown)', () => {
    // Follow-up mid-stream: server still shows the pre-send thread, whose last
    // message is the PRIOR assistant answer. Count has not grown past baseline.
    const { landedAnswer } = reconcileThread({
      ...base,
      serverMessages: prior,
      streamingText: 'streaming so far',
      sentAtCount: 2,
    });
    expect(landedAnswer).toBeNull();
  });
});

describe('reconcileThread — baseline 0 is distinct from null', () => {
  it('treats a loaded-empty thread (0) as a real baseline and hands off', () => {
    const landed = msg('assistant', 'a1', 'a1');
    const { landedAnswer } = reconcileThread({
      ...base,
      serverMessages: [msg('user', 'q1', 'u1'), landed],
      streamingText: 'partial',
      sentAtCount: 0, // loaded, empty at send — NOT null
    });
    expect(landedAnswer).toBe(landed);
  });
});

describe('reconcileThread — echo + synthetic basics', () => {
  it('reconciles the home-screen question by identity (ECHO_ID)', () => {
    const { messages } = reconcileThread({
      ...base,
      q: 'hello',
      serverMessages: [msg('user', 'hello', 'server-u'), msg('assistant', 'hi', 'server-a')],
      streamingText: '',
      sentAtCount: 0,
    });
    // The server's copy of the question inherits the echo key; nothing duplicated.
    expect(messages.map((m) => m.id)).toEqual(['__asked-question', 'server-a']);
  });

  it('prepends the echo when the server has not yet stored the question', () => {
    const { messages } = reconcileThread({
      ...base,
      q: 'hello',
      serverMessages: [],
      streamingText: '',
      sentAtCount: null,
    });
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ id: '__asked-question', role: 'user', content: 'hello' });
  });

  it('returns server messages unchanged when idle (no q, no stream)', () => {
    const server = [msg('user', 'q1', 'u1'), msg('assistant', 'a1', 'a1')];
    const { messages, landedAnswer } = reconcileThread({
      ...base,
      serverMessages: server,
      streamingText: '',
      sentAtCount: 2,
    });
    expect(messages).toEqual(server);
    expect(landedAnswer).toBeNull();
  });

  it('handles an unresolved detail query (undefined server messages)', () => {
    const { messages, landedAnswer } = reconcileThread({
      ...base,
      serverMessages: undefined,
      streamingText: '',
      sentAtCount: null,
    });
    expect(messages).toEqual([]);
    expect(landedAnswer).toBeNull();
  });
});
