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
}

export function createStreamState(): StreamState {
  return { answer: '', done: false };
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
 * Loud failure: a stream that closed without a `done` frame is truncated — its
 * partial text must not be passed off as a complete answer.
 */
export function assertComplete(state: StreamState): void {
  if (!state.done) {
    throw new ChatStreamError('Chat stream ended before completion.');
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
