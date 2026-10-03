import type { Attachment, Message } from '@/lib/api';

/**
 * The pure core of the chat screen's message reconciliation — extracted so the
 * seams that only misbehave under specific load/stream timing (send-before-
 * detail-load, the done hand-off) are unit-testable without rendering React
 * Native. The screen (`app/chat/[id].tsx`) owns the state; this owns the logic.
 *
 * It answers two questions from one snapshot:
 *  - `landedAnswer` / `landedFollowUp`: has THIS turn's answer / follow-up
 *    question been persisted yet? (drives the hand-off from a synthetic row
 *    to the server's message)
 *  - `messages`: the list to render — server messages, with the home-screen
 *    question reconciled by identity (ECHO_ID), a thread-typed follow-up
 *    reconciled the same way (`followUpKey`), and the in-progress answer
 *    shown as a synthetic assistant bubble while it streams.
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
  /**
   * The images the carried-in question was asked with (spec 211), as local
   * thumbnails. A question may be images alone, so these make an opening
   * question even when `q` is empty.
   */
  openingAttachments?: Attachment[];
  conversationId: string;
  /** The answer streamed so far this turn; empty when not streaming. */
  streamingText: string;
  /**
   * How much of `streamingText` the synthetic bubble shows — a paced prefix of
   * it (hooks/useRevealedText.ts). Defaults to all of it. Only what is shown
   * is paced: whether a turn is in flight, and so whether a landed answer is
   * held back, is decided by `streamingText`, so an answer that lands before
   * the reveal's first tick is never drawn whole for a frame.
   */
  revealedText?: string;
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
  /**
   * The text of a follow-up sent from inside this thread — i.e. NOT the
   * carried-in `q` — while the screen still hasn't reconciled it against the
   * server's copy. Cleared by the caller once `landedFollowUp` is used to
   * durably remap the row's key, so it need not stay set past the hand-off.
   */
  pendingFollowUp: string | undefined;
  /** The images `pendingFollowUp` was asked with (spec 211); may stand alone. */
  pendingFollowUpAttachments?: Attachment[];
  /** This turn's synthetic-row list key for `pendingFollowUp` (see FOLLOWUP_KEY_PREFIX). */
  followUpKey: string;
}

export interface ReconcileResult {
  messages: Message[];
  /** The persisted message for THIS turn's answer, once it has landed; else null. */
  landedAnswer: Message | null;
  /** The persisted message for THIS turn's follow-up question, once it has landed; else null. */
  landedFollowUp: Message | null;
}

export function reconcileThread(input: ReconcileInput): ReconcileResult {
  const {
    serverMessages,
    q,
    openingAttachments = [],
    conversationId,
    streamingText,
    revealedText = streamingText,
    streamKey,
    sentAtCount,
    pendingFollowUp,
    pendingFollowUpAttachments = [],
    followUpKey,
  } = input;

  // A question is words, images, or both (spec 211). While a question asked
  // here is on screen it keeps its own thumbnails, even once the server's copy
  // — which only knows that an image was there — has taken its place.
  const opening = !!q || openingAttachments.length > 0;
  const followUp =
    pendingFollowUp !== undefined &&
    (pendingFollowUp.length > 0 || pendingFollowUpAttachments.length > 0);
  const withLocal = (m: Message, attachments: Attachment[]): Message =>
    attachments.length > 0 ? { ...m, attachments } : m;

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

  // The persisted copy of THIS turn's follow-up question, once the refetch
  // has delivered it. Scanned forward from the baseline captured at send, so
  // it can never be confused with an identical carried-in `q` sitting at
  // index 0 — that row belongs to ECHO_ID, not this turn's follow-up.
  const landedFollowUp =
    followUp && serverMessages
      ? (serverMessages
          .slice(sentAtCount ?? 0)
          .find((m) => m.role === 'user' && m.content === pendingFollowUp) ??
        null)
      : null;

  const server = serverMessages ?? [];
  // While streaming, if the refetch has already delivered this turn's answer,
  // hold it back — the synthetic bubble stands in until the atomic hand-off — so
  // the answer never renders twice for a frame.
  const base =
    streamingText && landedAnswer ? server.slice(0, -1) : server.slice();

  let withEcho: Message[];
  if (!opening) {
    withEcho = base;
  } else {
    const text = q ?? '';
    let matched = false;
    const reconciled = base.map((m) => {
      if (!matched && m.role === 'user' && m.content === text) {
        matched = true;
        return withLocal({ ...m, id: ECHO_ID }, openingAttachments);
      }
      return m;
    });
    withEcho = matched
      ? reconciled
      : [
          withLocal(
            {
              id: ECHO_ID,
              conversationId,
              role: 'user',
              content: text,
              citations: [],
              createdAt: '',
            },
            openingAttachments,
          ),
          ...reconciled,
        ];
  }

  // A thread-typed follow-up: the same identity trick as ECHO_ID, but bound to
  // the persisted copy THIS turn actually produced (`landedFollowUp`), never
  // matched by scanning the whole list for equal content. An unbounded scan
  // would claim an EARLIER, unrelated user message with the same text (e.g. a
  // repeated "tell me more") — suppressing the synthetic row (reproducing
  // #128's exact symptom for that input) and re-keying a historical row it
  // doesn't own (which then reads as new content and re-animates). This is
  // safe precisely because `landedFollowUp` is itself scanned from
  // `sentAtCount` forward, so it can never point at a row older than this
  // turn — matching on its identity inherits that bound.
  if (followUp) {
    const matchIndex = landedFollowUp
      ? withEcho.findIndex((m) => m.id === landedFollowUp.id)
      : -1;
    withEcho =
      matchIndex === -1
        ? [
            ...withEcho,
            withLocal(
              {
                id: followUpKey,
                conversationId,
                role: 'user',
                content: pendingFollowUp ?? '',
                citations: [],
                createdAt: '',
              },
              pendingFollowUpAttachments,
            ),
          ]
        : withEcho.map((m, i) =>
            i === matchIndex
              ? withLocal({ ...m, id: followUpKey }, pendingFollowUpAttachments)
              : m,
          );
  }

  // The in-progress answer: a synthetic assistant bubble carrying this turn's
  // key, rendered through AnswerMessage exactly like a persisted one. Present
  // only while text is streaming and before the hand-off; on `done` the persisted
  // message inherits this same key (see keyOverrides) and the synthetic drops.
  if (streamingText && revealedText) {
    withEcho = [
      ...withEcho,
      {
        id: streamKey,
        conversationId,
        role: 'assistant',
        content: revealedText,
        citations: [],
        safety: null,
        createdAt: '',
      },
    ];
  }

  return { messages: withEcho, landedAnswer, landedFollowUp };
}
