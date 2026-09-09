import { fetch as expoFetch } from 'expo/fetch';
import { SSEParser } from '@/lib/api/sse';
import {
  assertComplete,
  ChatStreamError,
  consume,
  createStreamState,
  type ChatStreamEvent,
} from '@/lib/api/chat-stream';
import { getAccessToken, handleUnauthorized } from '@/lib/api/auth-bridge';

export type { ChatStreamEvent } from '@/lib/api/chat-stream';
export { ChatStreamError } from '@/lib/api/chat-stream';

export interface StreamChatParams {
  baseUrl: string;
  threadId: string;
  message: string;
  /**
   * Per-event callback, fired for every SSE event (`text` deltas, `tool_call` /
   * `tool_result`, `error`, `done`) as it arrives. This is the progress seam the
   * chat screen uses to render the answer incrementally and show a live retrieval
   * trace (see `useSendMessage` / `app/chat/[id].tsx`).
   */
  onEvent?: (event: ChatStreamEvent) => void;
  signal?: AbortSignal;
}

/**
 * Send a chat message and read the SSE stream to completion, reassembling every
 * `text` event into the final answer string.
 *
 * Incremental render: every event is delivered to `onEvent` AS IT ARRIVES, so the
 * chat screen paints each `text` delta immediately instead of waiting for the
 * stream to close. The returned promise still resolves only on `done` (with the
 * fully reassembled answer, used for the mutation's return contract) — but the UI
 * no longer waits on it. See `app/chat/[id].tsx`.
 *
 * Transport: exactly ONE POST is issued. `expo/fetch` returns a streaming
 * `response.body` on native and web, which we read incrementally. If a runtime
 * exposes no streaming body, we consume the RESPONSE ALREADY IN HAND
 * (`response.text()`) — we never re-send the request (a second POST would
 * duplicate the user's message and re-invoke the model). A 401 before the stream
 * opens triggers one refresh + retry.
 */
export async function streamChat(params: StreamChatParams): Promise<string> {
  const token = await getAccessToken();
  try {
    return await runStream(params, token);
  } catch (error) {
    if (error instanceof UnauthorizedStreamError) {
      const refreshed = await handleUnauthorized();
      if (refreshed) return runStream(params, refreshed);
    }
    throw error;
  }
}

class UnauthorizedStreamError extends Error {}

async function runStream(
  params: StreamChatParams,
  token: string | null,
): Promise<string> {
  const url = `${params.baseUrl}/api/v2/threads/${params.threadId}/chat`;
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'text/event-stream',
  };
  if (token) headers.authorization = `Bearer ${token}`;
  const body = JSON.stringify({ message: params.message });

  const response = await expoFetch(url, {
    method: 'POST',
    headers,
    body,
    signal: params.signal,
  });

  if (response.status === 401) throw new UnauthorizedStreamError();
  if (!response.ok) {
    throw new ChatStreamError(`Chat request failed (HTTP ${response.status})`);
  }

  const parser = new SSEParser();
  const state = createStreamState();

  if (!response.body) {
    // No streaming reader in this runtime (rare — expo/fetch exposes a streaming
    // body on native and web). Consume the response WE ALREADY HAVE — do NOT
    // issue a second request. `.text()` buffers the full SSE payload, so on this
    // fallback path alone the events fire in one burst rather than incrementally;
    // the happy path above reads the body reader and renders as tokens arrive.
    consume(parser.push(await response.text()), params.onEvent, state);
    assertComplete(state);
    return state.answer;
  }

  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      consume(parser.push(decoder.decode(value, { stream: true })), params.onEvent, state);
    }
  } finally {
    reader.releaseLock?.();
  }
  // Loud failure: throws if the stream closed without a `done` frame, so partial
  // text is never passed off as a complete answer.
  assertComplete(state);
  return state.answer;
}
