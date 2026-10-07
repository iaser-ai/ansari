import type { Message } from '@/lib/api';

/**
 * Whether the chat screen is waiting on an answer — and, when it is not but
 * the thread ends on a question nobody answered, which question to offer a
 * retry for. Pure, so the one thread shape that used to strand a reader is
 * unit-testable without rendering the screen (`app/chat/[id].tsx`).
 *
 * The waiting line must always be backed by a send. Arriving with `?q=`, it
 * stands in for one only while the auto-send is about to fire (the thread is
 * not loaded yet, or loaded and empty) or after a send this session. A thread
 * that already ends on a persisted, unanswered question — the app closed or
 * the connection dropped mid-send — is never auto-sent, so it gets the
 * failed-send retry instead of a spinner that nothing will ever stop.
 */
export interface AnswerWaitInput {
  /** The home-screen question carried in via the route param, if any. */
  q: string | undefined;
  /** The persisted messages, or `undefined` while the detail query loads. */
  serverMessages: Message[] | undefined;
  /** The role of the last message the screen renders (after reconciliation). */
  lastRole: Message['role'] | undefined;
  /** Whether a send has been made from this screen in this session. */
  sentThisSession: boolean;
  sendPending: boolean;
  sendFailed: boolean;
  threadFailed: boolean;
}

export interface AnswerWait {
  awaitingAnswer: boolean;
  /** A persisted, unanswered question to offer a retry for; else null. */
  unansweredQuestion: string | null;
}

export function answerWait(input: AnswerWaitInput): AnswerWait {
  const {
    q,
    serverMessages,
    lastRole,
    sentThisSession,
    sendPending,
    sendFailed,
    threadFailed,
  } = input;

  const autoSendDue = !serverMessages || serverMessages.length === 0;
  const awaitingAnswer =
    sendPending ||
    (!!q &&
      !sendFailed &&
      !threadFailed &&
      lastRole === 'user' &&
      (sentThisSession || autoSendDue));

  const lastPersisted = serverMessages?.[serverMessages.length - 1];
  const unansweredQuestion =
    q && !sentThisSession && !sendPending && lastPersisted?.role === 'user'
      ? lastPersisted.content
      : null;

  return { awaitingAnswer, unansweredQuestion };
}
