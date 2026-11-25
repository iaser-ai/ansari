/**
 * The apps/api client: threads and the streamed chat answer.
 *
 * Python counterparts: `ansari_client_base.py` (the interface), `ansari_client_real.py` and `ansari_client_mock.py`.
 *
 * How a chat answer arrives: `POST /api/v2/threads/{id}/chat` is a Server-Sent Events stream, the same route the web app
 * uses. Lines starting with `:` are keep-alives; each `data:` line is a JSON event: `text` (a piece of the answer),
 * `tool_call` / `tool_result` (ignored), `error`, and a final `done`. A stream with an `error` event, or one that ends
 * without `done`, is a failure, so a half answer is never passed on as complete. (HTTP status is 200 even for those, because
 * the status line is sent before the answer starts.)
 *
 * Differences from Python:
 * - `fetch` does not follow Python's rule "a timeout applies to each wait". The chat call uses an idle timer that restarts on
 *   every chunk (see `IdleTimeout`), which is what httpx's 60 s read timeout meant for a stream.
 * - A body is read with `readLines` over a `ReadableStream`, because `fetch` hands over bytes, not lines.
 */
import { z } from 'zod';
import {
  ApiUnauthorizedError,
  MessageProcessingError,
  ThreadCreationError,
  ThreadDeletionError,
  ThreadInfoError,
} from '../errors';
import type { Logger } from '../logger';
import { describeNetworkError, discardBody, IdleTimeout, readLines, trimTrailingSlashes, type FetchLike } from './http';

/** Per-client attribution id sent to apps/api (lowercase, per packages/types attribution). */
export const CLIENT_ID = 'askansari-whatsapp';

/** Ordinary calls (threads) give up after this long without an answer. */
const REQUEST_TIMEOUT_MS = 60_000;
/** The chat stream gives up after this long without a single byte (apps/api sends `: ping` lines to stay under it). */
const CHAT_IDLE_TIMEOUT_MS = 60_000;

export interface ThreadInfo {
  /** `null` when the user has no thread yet. */
  threadId: string | null;
  /** ISO timestamp of the thread's last activity; `null` when there is no thread. */
  lastMessageTime: string | null;
}

export interface AnsariClient {
  /**
   * Create a thread for the user this JWT belongs to.
   * @throws {ThreadCreationError}
   */
  createThread(token: string, title: string): Promise<{ threadId: string }>;
  /**
   * Delete a thread and, with it, all of its messages. A thread that is already gone is not an error.
   * @throws {ThreadDeletionError}
   */
  deleteThread(token: string, threadId: string): Promise<void>;
  /**
   * The user's most recently active thread, or nulls if they have none.
   * @throws {ThreadInfoError}
   */
  getLastThreadInfo(token: string): Promise<ThreadInfo>;
  /**
   * Send a message and collect the complete answer (WhatsApp cannot stream, so the whole stream is read first).
   * An empty string means apps/api finished without saying anything.
   * @throws {MessageProcessingError}
   */
  processMessage(token: string, threadId: string, message: string): Promise<string>;
  /** Every method also throws `ApiUnauthorizedError` on a 401, which a fresh token can fix. */
}

export interface AnsariClientOptions {
  /** apps/api's base URL, no path. */
  baseUrl: string;
  logger: Logger;
  fetch?: FetchLike;
  /** How long the chat stream may stay silent before it is given up on. Only tests change it. */
  chatIdleTimeoutMs?: number;
}

/** One entry of `GET /api/v2/threads`: only the fields this client reads. */
const threadListSchema = z.array(
  z.looseObject({ thread_id: z.unknown().optional(), source: z.unknown().optional(), updated_at: z.unknown().optional() }),
);

/** Calls apps/api over HTTP, with the user's JWT as the bearer token on every request. */
export class AnsariClientReal implements AnsariClient {
  readonly #baseUrl: string;
  readonly #logger: Logger;
  readonly #fetch: FetchLike;
  readonly #chatIdleTimeoutMs: number;

  constructor(options: AnsariClientOptions) {
    this.#baseUrl = trimTrailingSlashes(options.baseUrl);
    this.#logger = options.logger;
    this.#fetch = options.fetch ?? fetch;
    this.#chatIdleTimeoutMs = options.chatIdleTimeoutMs ?? CHAT_IDLE_TIMEOUT_MS;
  }

  #headers(token: string): Record<string, string> {
    return { Authorization: `Bearer ${token}`, 'X-Ansari-Client': CLIENT_ID, 'Content-Type': 'application/json' };
  }

  /** apps/api refused the token itself, which a fresh token can fix; any other status is a different fault. */
  #refuseIfUnauthorized(status: number): void {
    if (status === 401) {
      this.#logger.warn("apps/api refused the user's token (HTTP 401)");
      throw new ApiUnauthorizedError("apps/api refused the user's token");
    }
  }

  /**
   * One ordinary request. A network fault becomes `onNetworkError`'s error, so each method keeps its own error class.
   * A redirect is a failure here (see http.ts), reported with its status like any other.
   */
  async #request(
    method: string,
    path: string,
    token: string,
    what: string,
    onNetworkError: (cause: unknown) => Error,
    body?: unknown,
  ): Promise<Response> {
    try {
      return await this.#fetch(`${this.#baseUrl}${path}`, {
        method,
        headers: this.#headers(token),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: 'manual',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      this.#logger.error(`Network error ${what}: ${describeNetworkError(error)}`);
      throw onNetworkError(error);
    }
  }

  async createThread(token: string, title: string): Promise<{ threadId: string }> {
    const response = await this.#request(
      'POST',
      '/api/v2/threads',
      token,
      'creating thread',
      (cause) => new ThreadCreationError('Network error during thread creation', { cause }),
      { name: title, source: 'whatsapp' },
    );
    if (response.status === 401) await discardBody(response);
    this.#refuseIfUnauthorized(response.status);
    if (!response.ok) {
      await discardBody(response);
      this.#logger.error(`HTTP error creating thread: ${response.status}`);
      throw new ThreadCreationError(`Failed to create thread: HTTP ${response.status}`);
    }
    try {
      const body: unknown = await response.json();
      const threadId = typeof body === 'object' && body !== null ? (body as { thread_id?: unknown }).thread_id : undefined;
      if (typeof threadId !== 'string' || threadId === '') throw new TypeError('no thread_id');
      return { threadId };
    } catch (error) {
      this.#logger.error('apps/api returned an unexpected thread-creation response');
      throw new ThreadCreationError('Unexpected thread-creation response', { cause: error });
    }
  }

  async deleteThread(token: string, threadId: string): Promise<void> {
    const response = await this.#request(
      'DELETE',
      `/api/v2/threads/${encodeURIComponent(threadId)}`,
      token,
      'deleting thread',
      (cause) => new ThreadDeletionError('Network error during thread deletion', { cause }),
    );
    await discardBody(response);
    // The thread is already gone, which is the outcome we wanted
    if (response.status === 404) return;
    this.#refuseIfUnauthorized(response.status);
    if (!response.ok) {
      this.#logger.error(`HTTP error deleting thread: ${response.status}`);
      throw new ThreadDeletionError(`Failed to delete thread: HTTP ${response.status}`);
    }
  }

  /**
   * apps/api lists a user's threads newest-first by `updated_at`, which it bumps on every message. Only threads this
   * service created (`source` is `whatsapp`) count, so an expired one is never mistaken for, or deleted in place of, a
   * thread from another client.
   */
  async getLastThreadInfo(token: string): Promise<ThreadInfo> {
    const response = await this.#request(
      'GET',
      '/api/v2/threads',
      token,
      'getting last thread info',
      (cause) => new ThreadInfoError('Network error during thread info retrieval', { cause }),
    );
    if (response.status === 401) await discardBody(response);
    this.#refuseIfUnauthorized(response.status);
    if (!response.ok) {
      await discardBody(response);
      this.#logger.error(`HTTP error getting last thread info: ${response.status}`);
      throw new ThreadInfoError(`Failed to get last thread info: HTTP ${response.status}`);
    }
    try {
      const threads = threadListSchema.parse(await response.json()).filter((thread) => thread.source === 'whatsapp');
      const latest = threads[0];
      if (!latest) return { threadId: null, lastMessageTime: null };
      if (typeof latest.thread_id !== 'string' || typeof latest.updated_at !== 'string') throw new TypeError('bad thread');
      return { threadId: latest.thread_id, lastMessageTime: latest.updated_at };
    } catch (error) {
      this.#logger.error('apps/api returned an unexpected thread-list response');
      throw new ThreadInfoError('Unexpected thread-list response', { cause: error });
    }
  }

  async processMessage(token: string, threadId: string, message: string): Promise<string> {
    const idle = new IdleTimeout(this.#chatIdleTimeoutMs);
    try {
      let response: Response;
      try {
        response = await this.#fetch(`${this.#baseUrl}/api/v2/threads/${encodeURIComponent(threadId)}/chat`, {
          method: 'POST',
          headers: this.#headers(token),
          body: JSON.stringify({ message }),
          redirect: 'manual',
          signal: idle.signal,
        });
      } catch (error) {
        throw this.#streamFailure(error, idle);
      }

      if (response.status === 401) await discardBody(response);
      this.#refuseIfUnauthorized(response.status);
      if (response.status !== 200 || !response.body) {
        await discardBody(response);
        this.#logger.error(`Error from backend API: HTTP ${response.status}`);
        throw new MessageProcessingError(`Backend returned HTTP ${response.status}`);
      }

      // Accumulate the answer from the `text` events
      let fullResponse = '';
      let done = false;
      try {
        for await (const line of readLines(response.body, () => idle.reset())) {
          if (!line.startsWith('data:')) continue; // keep-alive comments and blank separator lines
          let event: unknown;
          try {
            event = JSON.parse(line.slice('data:'.length));
          } catch (error) {
            this.#logger.error('apps/api sent a chat event that is not JSON');
            throw new MessageProcessingError('Malformed chat event', { cause: error });
          }
          const type = typeof event === 'object' && event !== null ? (event as { type?: unknown }).type : undefined;
          if (type === 'text') {
            const content = (event as { content?: unknown }).content;
            fullResponse += typeof content === 'string' ? content : '';
          } else if (type === 'error') {
            // The message is apps/api's own text, never user content, so it is safe to log
            this.#logger.error(`apps/api reported a chat error: ${String((event as { message?: unknown }).message)}`);
            throw new MessageProcessingError('apps/api reported an error while answering');
          } else if (type === 'done') {
            done = true;
          }
        }
      } catch (error) {
        if (error instanceof MessageProcessingError) throw error;
        throw this.#streamFailure(error, idle);
      }

      if (!done) {
        this.#logger.error('The chat stream from apps/api ended before it was complete');
        throw new MessageProcessingError('Chat stream ended before completion');
      }
      if (fullResponse === '') {
        this.#logger.warn('Received empty response from backend');
        return '';
      }
      return fullResponse;
    } finally {
      idle.stop();
    }
  }

  /** Turn a `fetch` or stream fault into a `MessageProcessingError` without leaking a URL or body. */
  #streamFailure(error: unknown, idle: IdleTimeout): MessageProcessingError {
    if (idle.timedOut) {
      this.#logger.error('Timeout processing message: no data from apps/api');
      return new MessageProcessingError('Request timed out while processing message', { cause: error });
    }
    this.#logger.error(`Network error processing message: ${describeNetworkError(error)}`);
    return new MessageProcessingError('Network error during message processing', { cause: error });
  }
}

/**
 * A stand-in for apps/api that keeps threads in memory, for local development (`MOCK_ANSARI_CLIENT`).
 * Threads belong to a token, mirroring apps/api, where the token alone identifies the user. The mock auth client gives
 * each BSUID its own stable token.
 *
 * Python's version slept 1 to 2 seconds per call and could be told to fail at random. Neither is kept: the delay slowed every
 * test, and tests that need a failure throw their own.
 */
export class AnsariClientMock implements AnsariClient {
  readonly #threads = new Map<string, { user: string; title: string; messages: Array<{ role: string; content: string }>; updatedAt: string }>();
  #counter = 0;
  readonly #logger: Logger;
  readonly #now: () => Date;

  constructor(options: { logger: Logger; now?: () => Date }) {
    this.#logger = options.logger;
    this.#now = options.now ?? (() => new Date());
    this.#logger.info('Initialized AnsariClientMock - using mock backend');
  }

  #user(token: string, error: new (message: string) => Error): string {
    if (!token) throw new error('Invalid token');
    return token;
  }

  async createThread(token: string, title: string): Promise<{ threadId: string }> {
    const user = this.#user(token, ThreadCreationError);
    this.#counter += 1;
    const threadId = `mock_thread_${this.#counter}`;
    this.#threads.set(threadId, { user, title, messages: [], updatedAt: this.#now().toISOString() });
    this.#logger.info(`Mock: Created thread ${threadId}`);
    return { threadId };
  }

  async deleteThread(token: string, threadId: string): Promise<void> {
    const user = this.#user(token, ThreadDeletionError);
    const thread = this.#threads.get(threadId);
    if (!thread) return;
    if (thread.user !== user) throw new ThreadDeletionError('Thread access denied');
    this.#threads.delete(threadId);
    this.#logger.info(`Mock: Deleted thread ${threadId}`);
  }

  async getLastThreadInfo(token: string): Promise<ThreadInfo> {
    const user = this.#user(token, ThreadInfoError);
    const mine = [...this.#threads].filter(([, thread]) => thread.user === user);
    if (mine.length === 0) {
      this.#logger.debug('Mock: No threads found for user');
      return { threadId: null, lastMessageTime: null };
    }
    const [threadId, latest] = mine.reduce((best, entry) => (entry[1].updatedAt > best[1].updatedAt ? entry : best));
    return { threadId, lastMessageTime: latest.updatedAt };
  }

  async processMessage(token: string, threadId: string, message: string): Promise<string> {
    const user = this.#user(token, MessageProcessingError);
    const thread = this.#threads.get(threadId);
    if (!thread) {
      this.#logger.error(`Mock: Thread ${threadId} not found for message processing`);
      throw new MessageProcessingError('Thread not found');
    }
    if (thread.user !== user) {
      this.#logger.error(`Mock: Thread ${threadId} does not belong to this user`);
      throw new MessageProcessingError('Thread access denied');
    }
    thread.messages.push({ role: 'user', content: message });
    const response = `This is a *mock AI assistant* running in test mode.\n\nYour message: ${[...message].slice(0, 100).join('')}`;
    thread.messages.push({ role: 'assistant', content: response });
    thread.updatedAt = this.#now().toISOString();
    this.#logger.info(`Mock: Processed message for thread ${threadId}, response length: ${[...response].length}`);
    return response;
  }
}
