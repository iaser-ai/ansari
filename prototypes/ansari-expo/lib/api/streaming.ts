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
  /** Optional per-event callback (e.g. for a future live-render follow-up). */
  onEvent?: (event: ChatStreamEvent) => void;
  signal?: AbortSignal;
}

/**
 * Send a chat message and read the SSE stream to completion, reassembling every
 * `text` event into the final answer string.
 *
 * PROTOTYPE LIMITATION — buffer-until-done: this resolves only after the stream
 * closes, so the UI shows a spinner for the whole answer. This is NOT the
 * intended UX; the real app should render tokens incrementally (each `text`
 * event is delivered to `onEvent` as it arrives, ready for that follow-up). A
 * frontend developer must not copy the spinner-until-done behaviour.
 *
 * Transport: `expo/fetch` (streaming `response.body`) is primary and works on
 * native and web; a 401 before the stream opens triggers one refresh + retry.
 * If streaming `response.body` is unavailable, we fall back to XHR `onprogress`.
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
    throw new ChatStreamError(
      `Chat request failed (HTTP ${response.status})`,
    );
  }

  if (!response.body) {
    // Runtime without a streaming body reader — read via XHR fallback.
    return streamChatViaXHR(url, headers, body, params.onEvent, params.signal);
  }

  const parser = new SSEParser();
  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  const state = createStreamState();

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      consume(parser.push(chunk), params.onEvent, state);
    }
  } finally {
    reader.releaseLock?.();
  }
  // Loud failure: throws if the stream closed without a `done` frame, so partial
  // text is never passed off as a complete answer.
  assertComplete(state);
  return state.answer;
}

/**
 * XHR fallback: reads `responseText` as it grows. The platform decodes bytes to
 * a string for us, so no `TextDecoder` is needed; we diff the growing text and
 * feed only the new tail to the parser.
 */
function streamChatViaXHR(
  url: string,
  headers: Record<string, string>,
  body: string,
  onEvent: StreamChatParams['onEvent'],
  signal?: AbortSignal,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const parser = new SSEParser();
    const state = createStreamState();
    let seen = 0;
    let aborted = false;

    xhr.open('POST', url);
    for (const [key, value] of Object.entries(headers)) {
      xhr.setRequestHeader(key, value);
    }

    const drain = () => {
      const text = xhr.responseText;
      if (text.length > seen) {
        const delta = text.slice(seen);
        seen = text.length;
        try {
          consume(parser.push(delta), onEvent, state);
        } catch (error) {
          aborted = true;
          xhr.abort();
          reject(error);
        }
      }
    };

    xhr.onprogress = drain;
    xhr.onload = () => {
      drain();
      if (aborted) return; // already rejected from within drain()
      if (xhr.status === 401) reject(new UnauthorizedStreamError());
      else if (xhr.status < 200 || xhr.status >= 300) {
        reject(new ChatStreamError(`Chat request failed (HTTP ${xhr.status})`));
      } else if (!state.done) {
        reject(new ChatStreamError('Chat stream ended before completion.'));
      } else {
        resolve(state.answer);
      }
    };
    xhr.onerror = () => reject(new ChatStreamError('Network error during chat stream'));
    if (signal) {
      signal.addEventListener('abort', () => xhr.abort(), { once: true });
    }
    xhr.send(body);
  });
}
