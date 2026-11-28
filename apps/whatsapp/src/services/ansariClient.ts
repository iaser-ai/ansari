/**
 * The apps/api client: one complete chat answer, and the user's preferences.
 *
 * Python counterparts: `ansari_client_base.py` (the interface), `ansari_client_real.py` and `ansari_client_mock.py`.
 *
 * How an answer arrives: `POST /api/v2/chat/complete` returns one JSON body, `{ messages: string[] }`, once the answer is
 * complete. apps/api owns the thread: it creates, reuses or replaces the user's thread from the `expiryHours` sent with
 * each message, so this client no longer creates or deletes threads.
 *
 * Differences from Python:
 * - `fetch` has no per-read timeout like httpx's, so each call gets one deadline. An answer that uses tools can take a
 *   while, so the chat call has a longer one.
 */
import { z } from 'zod';
import { ApiUnauthorizedError, MessageProcessingError, PreferencesError } from '../errors';
import type { Logger } from '../logger';
import { describeNetworkError, discardBody, type FetchLike, trimTrailingSlashes } from './http';

/** Per-client attribution id sent to apps/api (lowercase, per packages/types attribution). */
export const CLIENT_ID = 'askansari-whatsapp';

/** The preference key, in apps/api's `preferences` table, that holds the user's chat expiry in hours. */
export const CHAT_RETENTION_PREFERENCE = 'whatsapp.chat_retention_hours';

/** Preference reads and writes give up after this long. */
const REQUEST_TIMEOUT_MS = 60_000;
/** An answer can run the model and its tools for a while, so it gets more time than the other calls. */
const CHAT_TIMEOUT_MS = 180_000;

export interface AnsariClient {
  /**
   * Send a message and get the complete answer as the list of messages to send, in order. An empty list means apps/api
   * finished without saying anything.
   * @throws {MessageProcessingError}
   */
  completeChat(token: string, request: { message: string; expiryHours: number }): Promise<string[]>;
  /**
   * Every preference the user has, as key/value strings.
   * @throws {PreferencesError}
   */
  getPreferences(token: string): Promise<Record<string, string>>;
  /**
   * Save one preference.
   * @throws {PreferencesError}
   */
  setPreference(token: string, key: string, value: string): Promise<void>;
  /** Every method also throws `ApiUnauthorizedError` on a 401, which a fresh token can fix. */
}

export interface AnsariClientOptions {
  /** apps/api's base URL, no path. */
  baseUrl: string;
  logger: Logger;
  fetch?: FetchLike;
  /** How long the chat call may take before it is given up on. Only tests change it. */
  chatTimeoutMs?: number;
}

const completeResponseSchema = z.object({ messages: z.array(z.string()) });
const preferencesSchema = z.record(z.string(), z.string());

/** Calls apps/api over HTTP, with the user's JWT as the bearer token on every request. */
export class AnsariClientReal implements AnsariClient {
  readonly #baseUrl: string;
  readonly #logger: Logger;
  readonly #fetch: FetchLike;
  readonly #chatTimeoutMs: number;

  constructor(options: AnsariClientOptions) {
    this.#baseUrl = trimTrailingSlashes(options.baseUrl);
    this.#logger = options.logger;
    this.#fetch = options.fetch ?? fetch;
    this.#chatTimeoutMs = options.chatTimeoutMs ?? CHAT_TIMEOUT_MS;
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
   * One request. A network fault becomes `onNetworkError`'s error, so each method keeps its own error class.
   * A redirect is a failure here (see http.ts), reported with its status like any other.
   */
  async #request(
    method: string,
    path: string,
    token: string,
    what: string,
    timeoutMs: number,
    onNetworkError: (cause: unknown) => Error,
    body?: unknown,
  ): Promise<Response> {
    try {
      return await this.#fetch(`${this.#baseUrl}${path}`, {
        method,
        headers: this.#headers(token),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      this.#logger.error(`Network error ${what}: ${describeNetworkError(error)}`);
      throw onNetworkError(error);
    }
  }

  async completeChat(token: string, request: { message: string; expiryHours: number }): Promise<string[]> {
    const response = await this.#request(
      'POST',
      '/api/v2/chat/complete',
      token,
      'getting the answer',
      this.#chatTimeoutMs,
      (cause) => new MessageProcessingError('Network error during message processing', { cause }),
      { message: request.message, expiryHours: request.expiryHours },
    );
    if (!response.ok) {
      await discardBody(response);
      this.#refuseIfUnauthorized(response.status);
      this.#logger.error(`Error from backend API: HTTP ${response.status}`);
      throw new MessageProcessingError(`Backend returned HTTP ${response.status}`);
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch (error) {
      this.#logger.error('apps/api sent an answer that is not JSON');
      throw new MessageProcessingError('Malformed answer from apps/api', { cause: error });
    }
    const parsed = completeResponseSchema.safeParse(body);
    if (!parsed.success) {
      this.#logger.error('apps/api returned an unexpected answer shape');
      throw new MessageProcessingError('Unexpected answer from apps/api');
    }
    if (parsed.data.messages.length === 0) this.#logger.warn('Received an empty response from the backend');
    return parsed.data.messages;
  }

  async getPreferences(token: string): Promise<Record<string, string>> {
    const response = await this.#request(
      'GET',
      '/api/v2/preferences',
      token,
      'getting preferences',
      REQUEST_TIMEOUT_MS,
      (cause) => new PreferencesError('Network error reading preferences', { cause }),
    );
    if (!response.ok) {
      await discardBody(response);
      this.#refuseIfUnauthorized(response.status);
      this.#logger.error(`HTTP error reading preferences: ${response.status}`);
      throw new PreferencesError(`Failed to read preferences: HTTP ${response.status}`);
    }
    try {
      return preferencesSchema.parse(await response.json());
    } catch (error) {
      this.#logger.error('apps/api returned an unexpected preferences response');
      throw new PreferencesError('Unexpected preferences response', { cause: error });
    }
  }

  async setPreference(token: string, key: string, value: string): Promise<void> {
    const response = await this.#request(
      'PUT',
      '/api/v2/preferences',
      token,
      'saving a preference',
      REQUEST_TIMEOUT_MS,
      (cause) => new PreferencesError('Network error saving a preference', { cause }),
      { [key]: value },
    );
    await discardBody(response);
    this.#refuseIfUnauthorized(response.status);
    if (!response.ok) {
      this.#logger.error(`HTTP error saving a preference: ${response.status}`);
      throw new PreferencesError(`Failed to save preference: HTTP ${response.status}`);
    }
  }
}

/**
 * A stand-in for apps/api that keeps preferences in memory, for local development (`MOCK_ANSARI_CLIENT`).
 * Preferences belong to a token, mirroring apps/api, where the token alone identifies the user. The mock auth client gives
 * each BSUID its own stable token.
 *
 * Python's version slept 1 to 2 seconds per call and could be told to fail at random. Neither is kept: the delay slowed every
 * test, and tests that need a failure throw their own.
 */
export class AnsariClientMock implements AnsariClient {
  readonly #preferences = new Map<string, Map<string, string>>();
  readonly #logger: Logger;

  constructor(options: { logger: Logger }) {
    this.#logger = options.logger;
    this.#logger.info('Initialized AnsariClientMock - using mock backend');
  }

  #store(token: string): Map<string, string> {
    if (!token) throw new PreferencesError('Invalid token');
    let store = this.#preferences.get(token);
    if (!store) {
      store = new Map();
      this.#preferences.set(token, store);
    }
    return store;
  }

  async completeChat(token: string, request: { message: string; expiryHours: number }): Promise<string[]> {
    if (!token) throw new MessageProcessingError('Invalid token');
    const answer = `This is a *mock AI assistant* running in test mode.\n\nYour message: ${[...request.message].slice(0, 100).join('')}`;
    this.#logger.info(`Mock: Answered a message (expiry ${request.expiryHours} h), answer length: ${[...answer].length}`);
    return [answer];
  }

  async getPreferences(token: string): Promise<Record<string, string>> {
    return Object.fromEntries(this.#store(token));
  }

  async setPreference(token: string, key: string, value: string): Promise<void> {
    this.#store(token).set(key, value);
  }
}
