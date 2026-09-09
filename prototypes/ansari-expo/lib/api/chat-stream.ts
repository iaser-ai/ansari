import { SSEParser } from '@/lib/api/sse';

/**
 * The RN-free core of the chat SSE reader: turn parsed `data:` payloads into
 * events, reassemble the answer text, and enforce the stream's loud-failure
 * rules. `streaming.ts` wires this to the actual transport (expo/fetch / XHR);
 * keeping it here means the failure behaviour is unit-testable under Node.
 */

export type ChatStreamEvent =
  | { type: 'text'; content: string }
  | { type: 'tool_call'; name?: string }
  | { type: 'tool_result'; tool?: string; query?: string; resultCount?: number }
  | { type: 'error'; message: string }
  | { type: 'done' };

/** Raised on any stream-level failure (error frame, malformed frame, truncation). */
export class ChatStreamError extends Error {
  readonly name = 'ChatStreamError';
}

export type ChatEventListener = (event: ChatStreamEvent) => void;

export interface StreamState {
  answer: string;
  done: boolean;
  /** True once a `text` frame carrying non-empty content has arrived. */
  sawText: boolean;
}

export function createStreamState(): StreamState {
  return { answer: '', done: false, sawText: false };
}

/**
 * Fold parsed SSE payloads into `state`. Loud failures:
 *  - a non-JSON payload throws (heartbeat comments are already stripped by
 *    `SSEParser`, so anything here is a real `data:` value that MUST be JSON);
 *  - an `{ type: "error" }` frame throws with its message.
 * A `{ type: "done" }` frame marks the stream complete.
 */
export function consume(
  payloads: string[],
  onEvent: ChatEventListener | undefined,
  state: StreamState,
): void {
  for (const payload of payloads) {
    let event: ChatStreamEvent;
    try {
      event = JSON.parse(payload) as ChatStreamEvent;
    } catch {
      throw new ChatStreamError('Malformed (non-JSON) SSE frame in the chat stream.');
    }
    onEvent?.(event);
    if (event.type === 'text') {
      // Loud failure: a text frame whose content is not a string is malformed;
      // dropping it silently would lose answer text without a trace.
      if (typeof event.content !== 'string') {
        throw new ChatStreamError('Malformed text frame: `content` is not a string.');
      }
      state.answer += event.content;
      if (event.content.length > 0) state.sawText = true;
    } else if (event.type === 'error') {
      const message =
        typeof event.message === 'string' && event.message
          ? event.message
          : 'The assistant reported an error.';
      throw new ChatStreamError(message);
    } else if (event.type === 'done') {
      state.done = true;
    }
    // tool_call / tool_result (and any future non-answer type) are intentionally
    // not folded into the answer text in this first PR.
  }
}

/**
 * Loud failures at stream close:
 *  - a stream that closed without a `done` frame is truncated — its partial text
 *    must not be passed off as a complete answer;
 *  - a stream that reached `done` but never carried any text is an empty answer —
 *    surfacing it as an error keeps the caller from rendering an empty bubble.
 *    (apps/api itself sends `{ type: "error" }` for an empty answer, which the
 *    error-frame path already throws; this is the belt-and-braces guard for a
 *    `done`-without-error-without-text stream.)
 */
export function assertComplete(state: StreamState): void {
  if (!state.done) {
    throw new ChatStreamError('Chat stream ended before completion.');
  }
  if (!state.sawText) {
    throw new ChatStreamError('The assistant returned an empty answer.');
  }
}

/**
 * Convenience reducer over a sequence of raw SSE text chunks: parse, consume,
 * and require completion. Used by tests and any non-streaming caller.
 */
export function reduceChatStream(
  chunks: string[],
  onEvent?: ChatEventListener,
): string {
  const parser = new SSEParser();
  const state = createStreamState();
  for (const chunk of chunks) consume(parser.push(chunk), onEvent, state);
  assertComplete(state);
  return state.answer;
}
