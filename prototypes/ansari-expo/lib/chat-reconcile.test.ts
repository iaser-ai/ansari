import { describe, expect, it } from 'vitest';
import { reconcileThread } from '@/lib/chat-reconcile';
import type { Message } from '@/lib/api';

const CID = 'conv1';
const STREAM_KEY = '__streaming-answer-1';
const FOLLOWUP_ID = '__followup-question-1';

function msg(role: Message['role'], content: string, id = `${role}-${content}`): Message {
  return { id, conversationId: CID, role, content, citations: [], safety: null, createdAt: '' };
}

const base = {
  q: undefined,
  conversationId: CID,
  streamKey: STREAM_KEY,
  pendingFollowUp: undefined,
  followUpKey: FOLLOWUP_ID,
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

describe('reconcileThread — thread-typed follow-up echo (issue #128)', () => {
  // A follow-up sent from inside the thread — as opposed to the carried-in
  // `q` — must render the instant it's sent, not wait for the post-`done`
  // refetch. Same identity trick as ECHO_ID, distinguished by FOLLOWUP_ID.
  const prior = [msg('user', 'q1', 'u1'), msg('assistant', 'a1', 'a1')];

  it('renders the pending follow-up immediately, before any answer text', () => {
    const { messages, landedFollowUp } = reconcileThread({
      ...base,
      serverMessages: prior,
      streamingText: '',
      sentAtCount: 2,
      pendingFollowUp: 'q2',
    });
    expect(messages.map((m) => m.id)).toEqual(['u1', 'a1', FOLLOWUP_ID]);
    const followUp = messages.find((m) => m.id === FOLLOWUP_ID);
    expect(followUp).toMatchObject({ role: 'user', content: 'q2' });
    // The refetch hasn't delivered the persisted copy yet.
    expect(landedFollowUp).toBeNull();
  });

  it('keeps the pending follow-up above the streaming answer bubble', () => {
    const { messages } = reconcileThread({
      ...base,
      serverMessages: prior,
      streamingText: 'partial',
      sentAtCount: 2,
      pendingFollowUp: 'q2',
    });
    expect(messages.map((m) => m.id)).toEqual([
      'u1',
      'a1',
      FOLLOWUP_ID,
      STREAM_KEY,
    ]);
  });

  it('reconciles the follow-up into its persisted copy once the refetch delivers it', () => {
    // Baseline captured at send (2 messages). The refetch appends this turn's
    // user+assistant → the persisted user row inherits FOLLOWUP_ID, no
    // duplicate, and the assistant is still held back behind the streaming
    // bubble (same "no double-render" rule as landedAnswer).
    const persistedFollowUp = msg('user', 'q2', 'u2');
    const landed = msg('assistant', 'a2', 'a2');
    const after = [...prior, persistedFollowUp, landed];
    const { messages, landedAnswer, landedFollowUp } = reconcileThread({
      ...base,
      serverMessages: after,
      streamingText: 'partial',
      sentAtCount: 2,
      pendingFollowUp: 'q2',
    });
    expect(landedAnswer).toBe(landed);
    expect(landedFollowUp).toBe(persistedFollowUp);
    expect(messages.map((m) => m.id)).toEqual([
      'u1',
      'a1',
      FOLLOWUP_ID,
      STREAM_KEY,
    ]);
  });

  it('does not perturb landedAnswer / the done hand-off', () => {
    // The synthetic follow-up row is added to the OUTPUT list only —
    // landedAnswer is computed from serverMessages/sentAtCount alone, so it
    // must come out identical with and without a pending follow-up.
    const landed = msg('assistant', 'a2', 'a2');
    const after = [...prior, msg('user', 'q2', 'u2'), landed];
    const withFollowUp = reconcileThread({
      ...base,
      serverMessages: after,
      streamingText: 'partial',
      sentAtCount: 2,
      pendingFollowUp: 'q2',
    });
    const withoutFollowUp = reconcileThread({
      ...base,
      serverMessages: after,
      streamingText: 'partial',
      sentAtCount: 2,
    });
    expect(withFollowUp.landedAnswer).toBe(landed);
    expect(withFollowUp.landedAnswer).toBe(withoutFollowUp.landedAnswer);
  });

  it('keeps ECHO_ID and the follow-up key on separate rows when q === pendingFollowUp', () => {
    // The carried-in question and the thread-typed follow-up can be
    // identical text (q never clears once the thread is open). ECHO_ID must
    // stay on the FIRST occurrence; the follow-up must claim the LAST —
    // never the echo row itself.
    const serverEcho = msg('user', 'same', 'server-u1');
    const priorAnswer = msg('assistant', 'a1', 'a1');

    // Pre-refetch: only the carried-in question is on the server.
    const preRefetch = reconcileThread({
      ...base,
      q: 'same',
      serverMessages: [serverEcho, priorAnswer],
      streamingText: 'partial',
      sentAtCount: 2,
      pendingFollowUp: 'same',
    });
    expect(preRefetch.messages.map((m) => m.id)).toEqual([
      '__asked-question',
      'a1',
      FOLLOWUP_ID,
      STREAM_KEY,
    ]);
    expect(preRefetch.landedFollowUp).toBeNull();

    // Post-refetch: the persisted follow-up (second occurrence of "same")
    // is what claims FOLLOWUP_ID, not the echoed first occurrence.
    const persistedFollowUp = msg('user', 'same', 'u2');
    const landed = msg('assistant', 'a2', 'a2');
    const postRefetch = reconcileThread({
      ...base,
      q: 'same',
      serverMessages: [serverEcho, priorAnswer, persistedFollowUp, landed],
      streamingText: 'partial',
      sentAtCount: 2,
      pendingFollowUp: 'same',
    });
    expect(postRefetch.messages.map((m) => m.id)).toEqual([
      '__asked-question',
      'a1',
      FOLLOWUP_ID,
      STREAM_KEY,
    ]);
    expect(postRefetch.landedFollowUp).toBe(persistedFollowUp);
    expect(postRefetch.landedAnswer).toBe(landed);
  });

  it('does not re-key an earlier identical user message when the follow-up repeats old text', () => {
    // Regression (3-way consult, PIR #128): matching `pendingFollowUp` by an
    // unbounded backward content scan claims the OLD row when a reader
    // repeats earlier text (e.g. "tell me more" twice) — no synthetic row
    // gets appended (reproducing #128's exact symptom for that input) and the
    // historical row's key changes out from under it (re-animates as "new").
    // The fix binds the match to `landedFollowUp`'s identity, which is itself
    // scanned from `sentAtCount` forward and so can never reach this old row.
    const priorFollowUp = msg('user', 'tell me more', 'u1');
    const priorAnswer = msg('assistant', 'a1', 'a1');
    const { messages, landedFollowUp } = reconcileThread({
      ...base,
      serverMessages: [priorFollowUp, priorAnswer],
      streamingText: 'partial',
      sentAtCount: 2,
      pendingFollowUp: 'tell me more',
    });
    expect(landedFollowUp).toBeNull();
    // A new synthetic row is appended; the old row keeps its own identity.
    expect(messages.map((m) => m.id)).toEqual([
      'u1',
      'a1',
      FOLLOWUP_ID,
      STREAM_KEY,
    ]);
    expect(messages.find((m) => m.id === 'u1')).toMatchObject({
      content: 'tell me more',
    });
  });
});
