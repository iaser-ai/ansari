import type { Message } from '@/lib/api';

/**
 * The pure core of the chat screen's message reconciliation — extracted so the
 * seams that only misbehave under specific load/stream timing (send-before-
 * detail-load, the done hand-off) are unit-testable without rendering React
 * Native. The screen (`app/chat/[id].tsx`) owns the state; this owns the logic.
 *
 * It answers two questions from one snapshot:
 *  - `landedAnswer`: has THIS turn's answer been persisted yet? (drives the
 *    hand-off from the synthetic streaming bubble to the server's message)
 *  - `messages`: the list to render — server messages, with the home-screen
 *    question reconciled by identity (ECHO_ID) and the in-progress answer shown
 *    as a synthetic assistant bubble while it streams.
 */

// See app/chat/[id].tsx — kept in sync with the screen's constants.
const ECHO_ID = '__asked-question';

export interface ReconcileInput {
  /**
   * The persisted thread's messages, or `undefined` when the detail query has
   * NOT resolved yet. `undefined` (not loaded) and `[]` (loaded, empty) are
   * deliberately distinct — see `sentAtCount`.
   */
  serverMessages: Message[] | undefined;
  /** The home-screen question carried in via the route param, if any. */
  q: string | undefined;
  conversationId: string;
  /** The answer streamed so far this turn; empty when not streaming. */
  streamingText: string;
  /** This turn's synthetic-bubble list key (see STREAM_KEY_PREFIX). */
  streamKey: string;
  /**
   * The persisted message count captured at send — or `null` when NO baseline is
   * known (nothing sent yet, or a send was attempted before the detail query
   * resolved). `null` is NOT `0`: with `0` (a genuinely empty thread) a later
   * assistant message means "this turn's answer landed", but with an unknown
   * baseline we must NOT assume that — a pre-existing assistant answer would
   * otherwise be mistaken for the current one and clear the streamed text.
   */
  sentAtCount: number | null;
}

export interface ReconcileResult {
  messages: Message[];
  /** The persisted message for THIS turn's answer, once it has landed; else null. */
  landedAnswer: Message | null;
}

export function reconcileThread(input: ReconcileInput): ReconcileResult {
  const { serverMessages, q, conversationId, streamingText, streamKey, sentAtCount } =
    input;

  // The in-flight turn's answer has landed once the message count has grown past
  // the baseline captured at send AND the last message is the assistant reply.
  // Refuse to decide without a known baseline (`sentAtCount === null`): otherwise
  // a pre-existing assistant answer, seen before the detail query has resolved,
  // is mistaken for the current turn's and clears the streamed text.
  const landedAnswer =
    sentAtCount !== null &&
    !!serverMessages &&
    serverMessages.length > sentAtCount &&
    serverMessages[serverMessages.length - 1]?.role === 'assistant'
      ? serverMessages[serverMessages.length - 1]
      : null;

  const server = serverMessages ?? [];
  // While streaming, if the refetch has already delivered this turn's answer,
  // hold it back — the synthetic bubble stands in until the atomic hand-off — so
  // the answer never renders twice for a frame.
  const base =
    streamingText && landedAnswer ? server.slice(0, -1) : server.slice();

  let withEcho: Message[];
  if (!q) {
    withEcho = base;
  } else {
    let matched = false;
    const reconciled = base.map((m) => {
      if (!matched && m.role === 'user' && m.content === q) {
        matched = true;
        return { ...m, id: ECHO_ID };
      }
      return m;
    });
    withEcho = matched
      ? reconciled
      : [
          {
            id: ECHO_ID,
            conversationId,
            role: 'user',
            content: q,
            citations: [],
            createdAt: '',
          },
          ...reconciled,
        ];
  }

  // The in-progress answer: a synthetic assistant bubble carrying this turn's
  // key, rendered through AnswerMessage exactly like a persisted one. Present
  // only while text is streaming and before the hand-off; on `done` the persisted
  // message inherits this same key (see keyOverrides) and the synthetic drops.
  if (streamingText) {
    withEcho = [
      ...withEcho,
      {
        id: streamKey,
        conversationId,
        role: 'assistant',
        content: streamingText,
        citations: [],
        safety: null,
        createdAt: '',
      },
    ];
  }

  return { messages: withEcho, landedAnswer };
}
