/**
 * The conversation manager: what happens between "Meta delivered a message" and "the user has an answer".
 *
 * Python counterpart: `services/whatsapp_conversation_manager.py`, plus the checks that lived in the webhook route of
 * `app/main.py` (maintenance mode, the staging `!d ` filter, the message-age check, the unsupported-type check).
 *
 * The flow for a text message:
 *
 *   triage()  ->  sign in (apps/auth)  ->  typing indicator  ->  find or start the user's thread (apps/api)
 *             ->  ask apps/api  ->  format for WhatsApp  ->  split  ->  send (Meta)
 *
 * Every refusal along the way is told to the user in plain words, and the ones an operator must act on are also reported
 * (see `ErrorReporter`). The notice texts are copied from Python word for word, including the odd ".." in the thread-deletion one,
 * because a user may report one by its wording.
 *
 * Differences from Python:
 * - One `ConversationManager` serves every message. Python built a new manager object per webhook and kept the user's token
 *   and typing task on it; here that per-message state lives in a small `Turn` object that is passed along.
 * - `triage()` is a plain function that answers "what should happen to this message?". The HTTP layer (phase 5) turns the
 *   answer into a status code and then calls `dispatch()`. Python mixed the checks and the status codes in one route.
 * - Everything the manager needs (settings, the three clients, the clock) is passed in, not looked up in globals.
 * - Two Python branches are gone because they cannot happen here: the notice for a thread-creation reply without an id (the
 *   apps/api client already refuses one) and the notice for an answer that formatted to nothing (the formatter never turns
 *   non-empty text into empty text).
 * - A `last_message_time` must carry a time-zone marker (`Z` or `+hh:mm`). JavaScript would read a bare timestamp as local
 *   time without complaint; Python raised an error, so this does too.
 * - A reply that is only whitespace splits into nothing; the user then gets the "couldn't process" notice (spec decision).
 */
import type { Env } from './config';
import type { ErrorReporter } from './errorReporter';
import { noopErrorReporter } from './errorReporter';
import {
  ApiUnauthorizedError,
  AuthBadRequestError,
  AuthKeyRejectedError,
  AuthRateLimitedError,
  AuthTokenError,
  AuthUserBannedError,
  MessageProcessingError,
  ThreadCreationError,
  ThreadDeletionError,
  ThreadInfoError,
} from './errors';
import { formatForWhatsApp } from './formatting/whatsappMessageFormatter';
import { splitMessage } from './formatting/messageSplitter';
import { getRequestId, type Logger } from './logger';
import type { AnsariClient } from './services/ansariClient';
import type { AuthClient } from './services/authClient';
import type { MetaApiService } from './services/metaApiService';
import { pythonSplitWords } from './utils/pythonText';
import { calculateTimePassed, getRetentionTimeSeconds, isMessageTooOld } from './utils/time';
import type { ParsedWebhook } from './webhook/parseWebhook';

/** A message from a user, as the webhook parser hands it over. */
export type IncomingMessage = Extract<ParsedWebhook, { kind: 'message' }>;

/** The settings the manager reads. `Pick` takes just these fields of the full `Env` type. */
export type ManagerConfig = Pick<
  Env,
  'WA_MAINTENANCE_MODE' | 'DEPLOYMENT_TYPE' | 'WHATSAPP_CHAT_RETENTION_HOURS' | 'WHATSAPP_MESSAGE_AGE_THRESHOLD_SECONDS'
>;

/**
 * What should happen to an incoming message. The HTTP layer answers Meta according to this (Python's status codes:
 * `maintenance` 503, `dev_filter` 202, `too_old` 422, `unsupported` 415, `text` 200) and then calls `dispatch`.
 */
export type TriageAction = 'maintenance' | 'dev_filter' | 'too_old' | 'unsupported' | 'text';

export const SIGN_IN_FAILED_NOTICE = "Sorry, we couldn't sign you in. Please try again later.";
export const BANNED_NOTICE = "Sorry, we can't answer messages from this account.";
export const MAINTENANCE_NOTICE =
  'Ansari for WhatsApp is down for maintenance, please try again later or visit our website at https://ansari.chat.';
const PROCESSING_FAILED_NOTICE = 'An error occurred while processing your message. Please try again later.';
const UNEXPECTED_FAILURE_NOTICE = 'An unexpected error occurred while processing your message. Please try again later.';
const EMPTY_ANSWER_NOTICE = "Sorry, we couldn't process your message. Please try again later.";
const THREAD_INFO_FAILED_NOTICE = "Sorry, we're having trouble accessing your chat history. Please try again later.";
const THREAD_DELETE_FAILED_NOTICE =
  'An unexpected error occurred while starting a new chat session.. Please try again later.';
const THREAD_CREATE_FAILED_NOTICE =
  'An unexpected error occurred while creating a new chat session. Please try again later.';

/** "...in about 5 minutes." The wait is rounded up to whole minutes and is never less than one. */
export function rateLimitedNotice(retryAfterSeconds: number): string {
  const minutes = Math.max(1, Math.ceil(retryAfterSeconds / 60));
  return `You are sending messages too quickly. Please try again in about ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}.`;
}

/** The text of a "can't process this type" notice for a message type like `image` (nothing is sent for an empty type). */
export function unsupportedTypeNotice(messageType: string): string {
  const plural = messageType.endsWith('s') ? messageType : `${messageType}s`;
  const named = plural.replaceAll('unsupporteds', 'this media type');
  return `Sorry, I can't process ${named} yet. Please send me a text message.`;
}

/** `Z` or `+hh:mm`, as apps/api sends it. Anything else is refused rather than guessed (see the file header). */
const TIMESTAMP_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;

function parseLastMessageTime(text: string): Date {
  const date = TIMESTAMP_WITH_OFFSET.test(text) ? new Date(text) : new Date(Number.NaN);
  if (Number.isNaN(date.getTime())) throw new TypeError('last message time is not an ISO timestamp with a time zone');
  return date;
}

/** The text of a text message: `{ body: '...' }`. Anything else is a fault in what Meta sent. */
function incomingText(message: IncomingMessage): string {
  const body = message.messageBody;
  const text = typeof body === 'object' && body !== null ? (body as { body?: unknown }).body : undefined;
  if (typeof text !== 'string') throw new TypeError('text message has no body');
  return text;
}

const DEV_PREFIX = '!d ';
const STAGING_PREFIX = '!s ';

/**
 * Which environment answers a message, by its prefix (issue #363): the production number is subscribed to the production,
 * staging and local (zrok) Meta apps, so all three receive every message. Production answers text with neither prefix,
 * staging only `!s `, development only `!d `. Prefixes are exact: lowercase, with the trailing space. A message that
 * is not text has no prefix, so only production answers it. `prefixLength` is how much to cut off the front of the text.
 */
export function routeByPrefix(
  environment: ManagerConfig['DEPLOYMENT_TYPE'],
  message: Pick<IncomingMessage, 'messageType' | 'messageBody'>,
): { answer: boolean; prefixLength: number } {
  const body = message.messageBody;
  const text = typeof body === 'object' && body !== null ? (body as { body?: unknown }).body : undefined;
  const textMessage = message.messageType === 'text' && typeof text === 'string' ? text : undefined;
  const isDev = textMessage?.startsWith(DEV_PREFIX) === true;
  const isStaging = textMessage?.startsWith(STAGING_PREFIX) === true;

  if (environment === 'production') return { answer: !isDev && !isStaging, prefixLength: 0 };
  const mine = environment === 'staging' ? isStaging : isDev;
  return { answer: mine, prefixLength: mine ? DEV_PREFIX.length : 0 };
}

/** Wait `ms`, or until `signal` aborts. Resolves `true` after the full wait and `false` if it was cut short. */
function delay(ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const finish = (completed: boolean) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve(completed);
    };
    const onAbort = () => finish(false);
    const timer = setTimeout(() => finish(true), ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** What the manager keeps while it handles one message. */
interface Turn {
  message: IncomingMessage;
  /** Who replies go to: the sender's phone when `META_REPLY_BY_PHONE` put it there, else the BSUID. */
  replyTo: string;
  /** The user's JWT; empty until sign-in succeeds. */
  token: string;
  typing: TypingIndicator | undefined;
}

export interface ConversationManagerOptions {
  config: ManagerConfig;
  ansariClient: AnsariClient;
  authClient: AuthClient;
  metaApi: MetaApiService;
  logger: Logger;
  reportError?: ErrorReporter;
  /** The clock. Only tests pass it. */
  now?: () => Date;
  /** Pause between typing indicators (Python: 26 s; WhatsApp shows one for about 25 s). Only tests change it. */
  typingIntervalMs?: number;
  /** Stop sending typing indicators after this long (Python: 5 minutes). Only tests change it. */
  typingMaxMs?: number;
}

/**
 * Keeps "typing..." showing while the answer is prepared. WhatsApp hides the indicator after about 25 seconds, so a new one
 * is sent every 26 s, for at most 5 minutes in all, until `stop()` is called.
 */
class TypingIndicator {
  readonly #abort = new AbortController();
  readonly #send: () => Promise<void>;
  readonly #logger: Logger;
  readonly #now: () => Date;
  readonly #intervalMs: number;
  readonly #maxMs: number;
  #startedAt = 0;

  constructor(options: { send: () => Promise<void>; logger: Logger; now: () => Date; intervalMs: number; maxMs: number }) {
    this.#send = options.send;
    this.#logger = options.logger;
    this.#now = options.now;
    this.#intervalMs = options.intervalMs;
    this.#maxMs = options.maxMs;
  }

  /** Send the first indicator now, then keep sending in the background. Returns once the first one is sent. */
  async start(): Promise<void> {
    this.#startedAt = this.#now().getTime();
    await this.#send();
    void this.#loop();
  }

  /** Stop for good. Safe to call more than once. */
  stop(): void {
    this.#abort.abort();
  }

  /** Never throws: it runs un-awaited, so a failure here would otherwise go unseen. */
  async #loop(): Promise<void> {
    try {
      for (;;) {
        this.#logger.debug('Currently in typing indicator loop (i.e., Ansari is taking longer than usual to respond)');
        if (!(await delay(this.#intervalMs, this.#abort.signal))) {
          this.#logger.debug('Typing indicator task cancelled');
          return;
        }
        const elapsedMs = this.#now().getTime() - this.#startedAt;
        if (elapsedMs > this.#maxMs) {
          this.#logger.warn(`Typing indicator loop exceeded maximum duration of ${this.#maxMs / 1000}s. Stopping.`);
          return;
        }
        this.#logger.debug(`Sending follow-up typing indicator after ${(elapsedMs / 1000).toFixed(1)}s`);
        await this.#send();
      }
    } catch (error) {
      this.#logger.error('Error in typing indicator loop', error);
    }
  }
}

export class ConversationManager {
  readonly #options: ConversationManagerOptions;
  readonly #now: () => Date;

  constructor(options: ConversationManagerOptions) {
    this.#options = options;
    this.#now = options.now ?? (() => new Date());
  }

  /**
   * Decide what should happen to a message, without doing it. The order matters: first whether this environment is the one
   * meant to answer (prefix routing), so an environment that ignores a message never sends its own maintenance notice; then
   * the service being down; then age; then the message type.
   */
  triage(message: IncomingMessage): TriageAction {
    const { config, logger } = this.#options;

    // Other environments' messages are ignored here, so nothing about them may be logged: no phone, BSUID or text
    if (!routeByPrefix(config.DEPLOYMENT_TYPE, message).answer) {
      logger.debug('Incoming message is meant for another environment, so will not process it here');
      return 'dev_filter';
    }

    if (config.WA_MAINTENANCE_MODE) return 'maintenance';

    // Meta redelivers old webhooks after an outage; answering a day-old question is worse than ignoring it
    if (isMessageTooOld(message.messageUnixTime, config.WHATSAPP_MESSAGE_AGE_THRESHOLD_SECONDS, { now: this.#now(), logger })) {
      return 'too_old';
    }

    return message.messageType === 'text' ? 'text' : 'unsupported';
  }

  /**
   * Carry out what `triage` decided. Meant to run after Meta has been answered: signing in and asking apps/api can take
   * long enough that Meta would redeliver the message, and nothing dedupes a redelivery. It does not throw: every failure
   * inside is logged and, where it matters, reported and told to the user.
   */
  async dispatch(message: IncomingMessage, action: TriageAction): Promise<void> {
    const turn: Turn = { message, replyTo: message.senderPhone || message.bsuid, token: '', typing: undefined };
    switch (action) {
      case 'maintenance':
        await this.notify(turn.replyTo, MAINTENANCE_NOTICE);
        return;
      case 'unsupported':
        await this.#handleUnsupported(turn);
        return;
      case 'text':
        await this.#signInAndHandleText(turn);
        return;
      case 'dev_filter':
      case 'too_old':
        return; // ignored on purpose; Meta was answered with the reason
    }
  }

  /**
   * Send a text to a user: split it to fit WhatsApp's limit and send the parts in order. Never throws: a failure is logged
   * (Meta reports it too), because the user has no one left to tell.
   */
  async notify(recipient: string, text: string): Promise<void> {
    await this.#deliver(recipient, splitMessage(text));
  }

  async #deliver(recipient: string, parts: string[]): Promise<void> {
    const { logger, metaApi } = this.#options;
    if (!recipient) {
      logger.error('Cannot send WhatsApp message: No recipient provided');
      return;
    }
    try {
      await metaApi.sendMessage(recipient, parts);
    } catch (error) {
      logger.error('Error sending WhatsApp message', error);
    }
  }

  #report(error: unknown, errorType: string): void {
    // Only the request id travels with the event, never a BSUID, phone number, token or any message text
    (this.#options.reportError ?? noopErrorReporter)(error, { errorType, context: { request_id: getRequestId() } });
  }

  // ---------- sign-in ----------

  /**
   * Exchange the sender's BSUID for a JWT with apps/auth, and keep it on the turn. apps/auth creates the account on first
   * use, so there is no separate sign-up. The same BSUID is always the same account; a new BSUID is a new user.
   *
   * Returns `null` on success, otherwise the notice to show the user. Each refusal means something different, so each is
   * handled differently: our own key being refused or our request being malformed are bugs for an operator (reported, with
   * their own tags); a banned or rate-limited user is expected (only logged); anything else is an outage (reported).
   */
  async #authenticate(turn: Turn): Promise<string | null> {
    const { authClient, logger } = this.#options;
    if (!turn.message.bsuid) {
      logger.error('Cannot authenticate user: bsuid is not set');
      return SIGN_IN_FAILED_NOTICE;
    }

    try {
      turn.token = await authClient.getToken(turn.message.bsuid);
    } catch (error) {
      if (error instanceof AuthUserBannedError) return BANNED_NOTICE;
      if (error instanceof AuthRateLimitedError) return rateLimitedNotice(error.retryAfter);
      if (error instanceof AuthKeyRejectedError) {
        this.#report(error, 'auth_key_rejected');
      } else if (error instanceof AuthBadRequestError) {
        this.#report(error, 'auth_bad_request');
      } else if (error instanceof AuthTokenError) {
        logger.error('Failed to get a token for the user', error);
        this.#report(error, 'auth_token_failure');
      } else {
        logger.error(`Unexpected error getting a token for the user: ${error instanceof Error ? error.name : typeof error}`);
        this.#report(error, 'auth_token_failure');
      }
      return SIGN_IN_FAILED_NOTICE;
    }

    logger.debug('Authenticated whatsapp user');
    return null;
  }

  async #signInAndHandleText(turn: Turn): Promise<void> {
    const notice = await this.#authenticate(turn);
    if (notice !== null) {
      await this.notify(turn.replyTo, notice);
      return;
    }

    // Started only for a signed-in user, because #handleText is what stops it
    await this.#startTyping(turn);
    await this.#handleText(turn);
  }

  // ---------- typing indicator ----------

  async #startTyping(turn: Turn): Promise<void> {
    const { logger, metaApi } = this.#options;
    const { bsuid, messageId } = turn.message;
    if (!bsuid || !messageId) {
      logger.error('Cannot start typing indicator loop: missing bsuid or message_id');
      return;
    }
    turn.typing = new TypingIndicator({
      send: async () => {
        try {
          await metaApi.sendTypingIndicator(bsuid, messageId);
        } catch (error) {
          logger.error('Error sending typing indicator', error);
        }
      },
      logger,
      now: this.#now,
      intervalMs: this.#options.typingIntervalMs ?? 26_000,
      maxMs: this.#options.typingMaxMs ?? 300_000,
    });
    await turn.typing.start();
  }

  // ---------- the user's thread ----------

  /**
   * The id of the user's one current thread, replacing it when it has expired. Each user has exactly one thread. When the
   * last message is older than the retention time (3 hours by default) the old thread and its messages are deleted and a
   * new thread starts. Returns `null` when something failed and the user has already been told.
   *
   * Known corner case, deliberately NOT handled (spec 321): if a user's first message after the expiry is followed by a
   * second one before the first has finished deleting and creating, both can see the expired thread and each create a new
   * one, leaving the user with two. A per-user lock was considered and rejected:
   * - two messages back to back from one user are unlikely, and delete-and-create takes well under a second;
   * - the damage is small: the newest thread is always the one used, so replies still work;
   * - it is easy to clean up: a manual sweep deletes all but the newest `whatsapp` thread of each user.
   * A lock around this step would also not stop two answers streaming into one thread at once, which is accepted too.
   */
  async #resolveThread(turn: Turn, firstMessage: string): Promise<string | null> {
    const { ansariClient, config, logger } = this.#options;

    let info;
    try {
      info = await ansariClient.getLastThreadInfo(turn.token);
    } catch (error) {
      if (!(error instanceof ThreadInfoError)) throw error;
      logger.error('Failed to get thread info', error);
      this.#report(error, 'thread_info_failure');
      await this.notify(turn.replyTo, THREAD_INFO_FAILED_NOTICE);
      return null;
    }

    const lastMessageTime = info.lastMessageTime === null ? null : parseLastMessageTime(info.lastMessageTime);
    const passed = calculateTimePassed(lastMessageTime, this.#now());
    logger.debug(`Time passed since user's last whatsapp message: ${passed.forLogging}`);

    if (info.threadId !== null && passed.seconds <= getRetentionTimeSeconds(config.WHATSAPP_CHAT_RETENTION_HOURS)) {
      return info.threadId;
    }

    if (info.threadId !== null) {
      try {
        await ansariClient.deleteThread(turn.token, info.threadId);
        logger.info("Deleted the user's expired thread");
      } catch (error) {
        if (!(error instanceof ThreadDeletionError)) throw error;
        // Keep one thread per user: do not start a second one next to an expired thread we could not delete
        logger.error('Failed to delete the expired thread', error);
        this.#report(error, 'thread_deletion_failure');
        await this.notify(turn.replyTo, THREAD_DELETE_FAILED_NOTICE);
        return null;
      }
    }

    try {
      // The thread's title is the first six words of the message
      const created = await ansariClient.createThread(turn.token, pythonSplitWords(firstMessage).slice(0, 6).join(' '));
      logger.info('Created a new thread for the whatsapp user');
      return created.threadId;
    } catch (error) {
      if (!(error instanceof ThreadCreationError)) throw error;
      logger.error('Failed to create thread', error);
      this.#report(error, 'thread_creation_failure');
      await this.notify(turn.replyTo, THREAD_CREATE_FAILED_NOTICE);
      return null;
    }
  }

  // ---------- answering ----------

  /**
   * Ask apps/api for the answer. Two attempts at most: if apps/api refuses the token (a session can end after its token was
   * signed, e.g. a ban or a deletion), the cached token is dropped, apps/auth is asked once more, and the message is tried
   * once more. A second refusal, or a refused exchange, ends it. Returns `null` when the user has already been told.
   */
  async #answer(turn: Turn, text: string, attempt: 1 | 2): Promise<string | null> {
    const { ansariClient, authClient, logger } = this.#options;
    try {
      const threadId = await this.#resolveThread(turn, text);
      if (threadId === null) return null;
      return await ansariClient.processMessage(turn.token, threadId, text);
    } catch (error) {
      if (error instanceof ApiUnauthorizedError) {
        if (attempt === 1) {
          authClient.forget(turn.message.bsuid);
          const notice = await this.#authenticate(turn);
          if (notice === null) return this.#answer(turn, text, 2);
          // A user who sent one message must not be told they are sending too quickly, which is what a 429 on this
          // second exchange would otherwise say
          await this.notify(turn.replyTo, notice === BANNED_NOTICE ? BANNED_NOTICE : SIGN_IN_FAILED_NOTICE);
        } else {
          logger.error('apps/api refused a freshly exchanged token; giving up');
          this.#report(error, 'api_unauthorized_after_reexchange');
          await this.notify(turn.replyTo, PROCESSING_FAILED_NOTICE);
        }
        return null;
      }
      if (error instanceof MessageProcessingError) {
        logger.error('Failed to process message', error);
        this.#report(error, 'message_processing_failure');
        await this.notify(turn.replyTo, PROCESSING_FAILED_NOTICE);
        return null;
      }
      throw error;
    }
  }

  /** Process an incoming text message and send the answer to the sender. */
  async #handleText(turn: Turn): Promise<void> {
    const { logger } = this.#options;
    if (!turn.message.bsuid || !turn.token) {
      logger.error('Cannot process text message: the user is not authenticated');
      return;
    }

    try {
      // The prefix only routes the message; the answer must not be about it
      const { prefixLength } = routeByPrefix(this.#options.config.DEPLOYMENT_TYPE, turn.message);
      const text = incomingText(turn.message).slice(prefixLength);
      logger.debug(`Whatsapp user sent a text message (${[...text].length} characters)`);

      const answer = await this.#answer(turn, text, 1);
      if (answer === null) return;
      turn.typing?.stop();

      if (answer === '') {
        logger.warn('Received an empty response from the backend');
        await this.notify(turn.replyTo, EMPTY_ANSWER_NOTICE);
        return;
      }

      // Convert conventional markdown syntax to WhatsApp's markdown syntax
      logger.debug(`Response received for markdown conversion (${[...answer].length} characters)`);
      // An answer of only whitespace has nothing to send (WhatsApp rejects a blank message): same notice as an empty one
      const parts = splitMessage(formatForWhatsApp(answer));
      if (parts.length === 0) {
        logger.warn('Response had no text to send after splitting');
        await this.notify(turn.replyTo, EMPTY_ANSWER_NOTICE);
        return;
      }
      await this.#deliver(turn.replyTo, parts);
    } catch (error) {
      logger.error('Unexpected error processing text message', error);
      await this.notify(turn.replyTo, UNEXPECTED_FAILURE_NOTICE);
    } finally {
      // Every way out of here ends the typing indicator, so none is left running
      turn.typing?.stop();
    }
  }

  /** Tell the sender that this kind of message (image, audio, ...) is not understood yet. Needs no sign-in. */
  async #handleUnsupported(turn: Turn): Promise<void> {
    const { messageType, bsuid } = turn.message;
    if (!bsuid || !messageType) {
      this.#options.logger.error('Cannot process unsupported message: missing bsuid or incoming_msg_type');
      return;
    }
    await this.notify(turn.replyTo, unsupportedTypeNotice(messageType));
  }
}
