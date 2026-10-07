import { describe, expect, it } from 'vitest';
import { answerWait } from '@/lib/chat-wait';
import type { Message } from '@/lib/api';

function msg(role: Message['role'], content: string): Message {
  return {
    id: `${role}-${content}`,
    conversationId: 'conv1',
    role,
    content,
    citations: [],
    safety: null,
    createdAt: '',
  };
}

const idle = {
  q: 'What is zakat?',
  sentThisSession: false,
  sendPending: false,
  sendFailed: false,
  threadFailed: false,
};

describe('answerWait — unanswered question reopened via ?q= (#247)', () => {
  // The app closed or the connection dropped mid-send: the question was
  // persisted, its answer never was. The auto-send only fires on an empty
  // thread, so nothing is in flight — the waiting line must not show.
  const stranded = [msg('user', 'What is zakat?')];

  it('offers a retry instead of an unbacked waiting line', () => {
    expect(
      answerWait({ ...idle, serverMessages: stranded, lastRole: 'user' }),
    ).toEqual({ awaitingAnswer: false, unansweredQuestion: 'What is zakat?' });
  });

  it('does the same when earlier turns were answered', () => {
    const thread = [
      msg('user', 'What is zakat?'),
      msg('assistant', 'Zakat is…'),
      msg('user', 'Who must pay it?'),
    ];
    expect(
      answerWait({ ...idle, serverMessages: thread, lastRole: 'user' }),
    ).toEqual({ awaitingAnswer: false, unansweredQuestion: 'Who must pay it?' });
  });

  it('waits, without a retry, once the retry is in flight', () => {
    expect(
      answerWait({
        ...idle,
        serverMessages: stranded,
        lastRole: 'user',
        sentThisSession: true,
        sendPending: true,
      }),
    ).toEqual({ awaitingAnswer: true, unansweredQuestion: null });
  });

  it('keeps waiting after the retry succeeds until the answer lands', () => {
    expect(
      answerWait({
        ...idle,
        serverMessages: stranded,
        lastRole: 'user',
        sentThisSession: true,
      }),
    ).toEqual({ awaitingAnswer: true, unansweredQuestion: null });
  });
});

describe('answerWait — normal cases unchanged', () => {
  it('waits for the carried-in question before the thread has loaded', () => {
    expect(
      answerWait({ ...idle, serverMessages: undefined, lastRole: 'user' }),
    ).toEqual({ awaitingAnswer: true, unansweredQuestion: null });
  });

  it('waits on a loaded, empty thread while the auto-send fires', () => {
    expect(
      answerWait({ ...idle, serverMessages: [], lastRole: 'user' }),
    ).toEqual({ awaitingAnswer: true, unansweredQuestion: null });
  });

  it('waits while the auto-sent question is in flight', () => {
    expect(
      answerWait({
        ...idle,
        serverMessages: [],
        lastRole: 'user',
        sentThisSession: true,
        sendPending: true,
      }),
    ).toEqual({ awaitingAnswer: true, unansweredQuestion: null });
  });

  it('waits while a follow-up is in flight, with no ?q=', () => {
    expect(
      answerWait({
        ...idle,
        q: undefined,
        serverMessages: [msg('user', 'a'), msg('assistant', 'b')],
        lastRole: 'user',
        sentThisSession: true,
        sendPending: true,
      }),
    ).toEqual({ awaitingAnswer: true, unansweredQuestion: null });
  });

  it('stops waiting when the send fails (the failed-send UI takes over)', () => {
    expect(
      answerWait({
        ...idle,
        serverMessages: [],
        lastRole: 'user',
        sentThisSession: true,
        sendFailed: true,
      }).awaitingAnswer,
    ).toBe(false);
  });

  it('stops waiting when the thread fails to load', () => {
    expect(
      answerWait({
        ...idle,
        serverMessages: undefined,
        lastRole: 'user',
        threadFailed: true,
      }).awaitingAnswer,
    ).toBe(false);
  });

  it('neither waits nor retries on an answered thread', () => {
    expect(
      answerWait({
        ...idle,
        serverMessages: [msg('user', 'What is zakat?'), msg('assistant', 'Zakat is…')],
        lastRole: 'assistant',
      }),
    ).toEqual({ awaitingAnswer: false, unansweredQuestion: null });
  });

  it('offers no retry without ?q= (no waiting line was ever shown there)', () => {
    expect(
      answerWait({
        ...idle,
        q: undefined,
        serverMessages: [msg('user', 'What is zakat?')],
        lastRole: 'user',
      }),
    ).toEqual({ awaitingAnswer: false, unansweredQuestion: null });
  });
});
