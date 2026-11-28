/**
 * The conversation manager: what happens between "Meta delivered a message" and "the user has an answer".
 *
 * Python counterpart: `services/whatsapp_conversation_manager.py`, plus the checks that lived in the webhook route of
 * `app/main.py` (maintenance mode, the staging `!s ` filter, the message-age check, the unsupported-type check).
 *
 * The flow for a text message:
 *
 *   triage()  ->  sign in (apps/auth)  ->  typing indicator  ->  read the user's chat expiry (apps/api)
 *             ->  complete the answer (apps/api)  ->  send each message in order (Meta)
 *
 * apps/api owns the thread and the formatting: the answer arrives as WhatsApp-ready messages, so nothing is reformatted or
 * split here. `/expiry` sends a list the user picks the chat expiry from; the pick arrives as a list reply and is saved.
 *
 * Every refusal along the way is told to the user in plain words, and the ones an operator must act on are also reported
 * (see `ErrorReporter`). The notice texts are copied from Python word for word,
 * because a user may report one by its wording.
 *
 * Differences from Python:
 * - One `ConversationManager` serves every message. Python built a new manager object per webhook and kept the user's token
 *   and typing task on it; here that per-message state lives in a small `Turn` object that is passed along.
 * - `triage()` is a plain function that answers "what should happen to this message?". The HTTP layer (phase 5) turns the
 *   answer into a status code and then calls `dispatch()`. Python mixed the checks and the status codes in one route.
 * - Everything the manager needs (settings, the three clients, the clock) is passed in, not looked up in globals.
 * - A reply that is only whitespace has nothing to send (WhatsApp rejects a blank message), so the user gets the
 *   "couldn't process" notice (spec decision).
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
  PreferencesError,
} from './errors';
import { getRequestId, type Logger } from './logger';
import { CHAT_RETENTION_PREFERENCE, type AnsariClient } from './services/ansariClient';
import type { AuthClient } from './services/authClient';
import type { MetaApiService } from './services/metaApiService';
import { isMessageTooOld } from './utils/time';
import type { ParsedWebhook } from './webhook/parseWebhook';

/** A message from a user, as the webhook parser hands it over. */
export type IncomingMessage = Extract<ParsedWebhook, { kind: 'message' }>;

/** The settings the manager reads. `Pick` takes just these fields of the full `Env` type. */
export type ManagerConfig = Pick<
  Env,
  'WA_MAINTENANCE_MODE' | 'ENVIRONMENT' | 'WHATSAPP_CHAT_RETENTION_HOURS' | 'WHATSAPP_MESSAGE_AGE_THRESHOLD_SECONDS'
>;

/**
 * What should happen to an incoming message. The HTTP layer answers Meta according to this (Python's status codes:
 * `maintenance` 503, `dev_filter` 202, `too_old` 422, `unsupported` 415, `text` 200) and then calls `dispatch`.
 * `expiry_command` and `list_reply` are answered with 200, as `text` is.
 */
export type TriageAction = 'maintenance' | 'dev_filter' | 'too_old' | 'unsupported' | 'text' | 'expiry_command' | 'list_reply';

export const SIGN_IN_FAILED_NOTICE = "Sorry, we couldn't sign you in. Please try again later.";
export const BANNED_NOTICE = "Sorry, we can't answer messages from this account.";
export const MAINTENANCE_NOTICE =
  'Ansari for WhatsApp is down for maintenance, please try again later or visit our website at https://ansari.chat.';
const PROCESSING_FAILED_NOTICE = 'An error occurred while processing your message. Please try again later.';
const UNEXPECTED_FAILURE_NOTICE = 'An unexpected error occurred while processing your message. Please try again later.';
const EMPTY_ANSWER_NOTICE = "Sorry, we couldn't process your message. Please try again later.";
const EXPIRY_SAVE_FAILED_NOTICE = 'An error occurred while saving your chat setting. Please try again later.';
const INVALID_CHOICE_NOTICE = 'Sorry, that option is no longer available. Send /expiry to choose again.';

/** The command that opens the chat-expiry list. Matched after any environment prefix, ignoring case and spaces. */
const EXPIRY_COMMAND = '/expiry';
/** The hours offered by `/expiry`. Meta allows at most 10 rows in a list; apps/api accepts any value from 0 to 24. */
export const EXPIRY_CHOICES_HOURS = [0, 1, 2, 3, 6, 12, 24] as const;

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

/** How a number of hours reads in a sentence: "a new session for every message", "1 hour", "6 hours". */
export function expiryPhrase(hours: number): string {
  if (hours === 0) return 'a new session for every message';
  return hours === 1 ? '1 hour' : `${hours} hours`;
}

/**
 * The text of one row of the `/expiry` list. Meta allows 24 characters for a row title, so the 0-hour row says "each":
 * "New session every message" is 25 characters and Meta would reject the whole list.
 */
function rowTitle(hours: number): string {
  if (hours === 0) return 'New session each message';
  return hours === 1 ? '1 hour' : `${hours} hours`;
}

/**
 * The expiry a stored preference asks for, or `fallback` (the env default) when nothing usable is stored. A stored value is
 * a whole number from 0 to 24; anything else is not trusted.
 */
export function chatRetentionHours(stored: string | undefined, fallback: number): number {
  if (stored === undefined || !/^\d{1,2}$/.test(stored)) return fallback;
  const hours = Number(stored);
  return hours <= 24 ? hours : fallback;
}

/** The row id `/expiry` gives each choice. It ends with the environment, so only the one that sent the list answers it. */
export function expiryRowId(hours: number, environment: ManagerConfig['ENVIRONMENT']): string {
  return `expiry:${hours}:${environment}`;
}

/** The hours in a list reply's row id, when the id is one this environment offered. Anything else is `undefined`. */
export function parseExpiryChoice(id: string, environment: ManagerConfig['ENVIRONMENT']): number | undefined {
  const match = /^expiry:(\d{1,2}):([a-z]+)$/.exec(id);
  if (!match || match[2] !== environment) return undefined;
  const hours = Number(match[1]);
  return (EXPIRY_CHOICES_HOURS as readonly number[]).includes(hours) ? hours : undefined;
}

/** The text of a text message: `{ body: '...' }`, or `undefined` for anything else. */
function textOf(message: Pick<IncomingMessage, 'messageType' | 'messageBody'>): string | undefined {
  if (message.messageType !== 'text') return undefined;
  const body = message.messageBody;
  const text = typeof body === 'object' && body !== null ? (body as { body?: unknown }).body : undefined;
  return typeof text === 'string' ? text : undefined;
}

/**
 * The row id of a list reply (an interactive message the user answered from a list), or `undefined`.
 * https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/messages
 */
function listReplyId(message: Pick<IncomingMessage, 'messageType' | 'messageBody'>): string | undefined {
  if (message.messageType !== 'interactive') return undefined;
  const body = message.messageBody;
  if (typeof body !== 'object' || body === null || (body as { type?: unknown }).type !== 'list_reply') return undefined;
  const reply = (body as { list_reply?: unknown }).list_reply;
  const id = typeof reply === 'object' && reply !== null ? (reply as { id?: unknown }).id : undefined;
  return typeof id === 'string' ? id : undefined;
}

const DEV_PREFIX = '!d ';
const STAGING_PREFIX = '!s ';

/**
 * Which environment answers a message, by its prefix (issue #363): the production number is subscribed to the production,
 * staging and local (zrok) Meta apps, so all three receive every message. Production answers text with neither prefix,
 * staging only `!s `, development only `!d `. Prefixes are exact: lowercase, with the trailing space. A message that
 * is not text has no prefix, so only production answers it, except a list reply, which names its environment in its row id
 * (see `expiryRowId`). `prefixLength` is how much to cut off the front of the text.
 */
export function routeByPrefix(
  environment: ManagerConfig['ENVIRONMENT'],
  message: Pick<IncomingMessage, 'messageType' | 'messageBody'>,
): { answer: boolean; prefixLength: number } {
  const listId = listReplyId(message);
  if (listId !== undefined) return { answer: listId.endsWith(`:${environment}`), prefixLength: 0 };

  const textMessage = textOf(message);

  if (environment === 'production') {
    const isOtherEnvironments = textMessage?.startsWith(DEV_PREFIX) === true || textMessage?.startsWith(STAGING_PREFIX) === true;
    return { answer: !isOtherEnvironments, prefixLength: 0 };
  }

  const ownPrefix = environment === 'staging' ? STAGING_PREFIX : DEV_PREFIX;
  if (textMessage?.startsWith(ownPrefix) !== true) return { answer: false, prefixLength: 0 };
  // A bare prefix is not a question, and apps/api refuses an empty message
  if (textMessage.slice(ownPrefix.length).trim() === '') return { answer: false, prefixLength: 0 };
  return { answer: true, prefixLength: ownPrefix.length };
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
    const route = routeByPrefix(config.ENVIRONMENT, message);
    if (!route.answer) {
      logger.info(`Ignoring a message meant for another environment (ENVIRONMENT=${config.ENVIRONMENT})`);
      return 'dev_filter';
    }

    if (config.WA_MAINTENANCE_MODE) return 'maintenance';

    // Meta redelivers old webhooks after an outage; answering a day-old question is worse than ignoring it
    if (isMessageTooOld(message.messageUnixTime, config.WHATSAPP_MESSAGE_AGE_THRESHOLD_SECONDS, { now: this.#now(), logger })) {
      return 'too_old';
    }

    if (listReplyId(message) !== undefined) return 'list_reply';
    const text = textOf(message);
    if (text !== undefined) {
      return text.slice(route.prefixLength).trim().toLowerCase() === EXPIRY_COMMAND ? 'expiry_command' : 'text';
    }
    return 'unsupported';
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
        await this.#signInThen(turn, async () => {
          await this.#startTyping(turn);
          await this.#handleText(turn);
        });
        return;
      case 'expiry_command':
        await this.#signInThen(turn, () => this.#sendExpiryList(turn));
        return;
      case 'list_reply':
        await this.#signInThen(turn, () => this.#saveExpiryChoice(turn));
        return;
      case 'dev_filter':
      case 'too_old':
        return; // ignored on purpose; Meta was answered with the reason
    }
  }

  /**
   * Send a text to a user as one message. Never throws: a failure is logged (Meta reports it too), because the user has
   * no one left to tell.
   */
  async notify(recipient: string, text: string): Promise<void> {
    await this.#deliver(recipient, [text]);
  }

  async #deliver(recipient: string, parts: string[], failureNotice?: string): Promise<void> {
    const { logger, metaApi } = this.#options;
    if (!recipient) {
      logger.error('Cannot send WhatsApp message: No recipient provided');
      return;
    }
    try {
      await metaApi.sendMessage(recipient, parts);
    } catch (error) {
      logger.error('Error sending WhatsApp message', error);
      if (failureNotice) {
        try {
          await metaApi.sendMessage(recipient, [failureNotice]);
        } catch (noticeError) {
          logger.error('Failed to send WhatsApp delivery failure notice', noticeError);
        }
      }
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

  /**
   * Sign the user in, then run `action`. A sign-in refusal is told to the user and `action` does not run; an unexpected
   * fault inside `action` is logged and told to the user, so nothing escapes `dispatch`.
   */
  async #signInThen(turn: Turn, action: () => Promise<void>): Promise<void> {
    const notice = await this.#authenticate(turn);
    if (notice !== null) {
      await this.notify(turn.replyTo, notice);
      return;
    }
    try {
      await action();
    } catch (error) {
      this.#options.logger.error('Unexpected error handling a message', error);
      await this.notify(turn.replyTo, UNEXPECTED_FAILURE_NOTICE);
    }
  }

  // ---------- calling apps/api ----------

  /**
   * Run one call to apps/api. If apps/api refuses the token (a session can end after its token was signed, e.g. a ban or a
   * deletion), the cached token is dropped, apps/auth is asked once more, and the call is tried once more. A second refusal,
   * or a refused exchange, ends it. A failed call is told to the user with `failureNotice`. Returns `null` when the user has
   * already been told.
   */
  async #callApi<T>(
    turn: Turn,
    run: () => Promise<T>,
    failureNotice: string = PROCESSING_FAILED_NOTICE,
    attempt: 1 | 2 = 1,
  ): Promise<T | null> {
    const { authClient, logger } = this.#options;
    try {
      return await run();
    } catch (error) {
      if (error instanceof ApiUnauthorizedError) {
        if (attempt === 1) {
          authClient.forget(turn.message.bsuid);
          const notice = await this.#authenticate(turn);
          if (notice === null) return this.#callApi(turn, run, failureNotice, 2);
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
        await this.notify(turn.replyTo, failureNotice);
        return null;
      }
      if (error instanceof PreferencesError) {
        logger.error('Failed to read or save a preference', error);
        this.#report(error, 'preferences_failure');
        await this.notify(turn.replyTo, failureNotice);
        return null;
      }
      throw error;
    }
  }

  /** The user's chat expiry: their saved choice, or the env default when they have not chosen one (or the value is unusable). */
  async #expiryHours(token: string): Promise<number> {
    const { ansariClient, config, logger } = this.#options;
    let preferences: Record<string, string>;
    try {
      preferences = await ansariClient.getPreferences(token);
    } catch (error) {
      if (!(error instanceof PreferencesError)) throw error;
      logger.warn('Could not read the chat expiry preference; using the configured default');
      return config.WHATSAPP_CHAT_RETENTION_HOURS;
    }
    const stored = preferences[CHAT_RETENTION_PREFERENCE];
    const hours = chatRetentionHours(stored, config.WHATSAPP_CHAT_RETENTION_HOURS);
    if (stored !== undefined && hours !== Number(stored)) logger.warn('A stored chat expiry is not valid; the default is used');
    return hours;
  }

  // ---------- answering ----------

  /** Process an incoming text message and send the answer to the sender. */
  async #handleText(turn: Turn): Promise<void> {
    const { ansariClient, config, logger } = this.#options;
    if (!turn.message.bsuid || !turn.token) {
      logger.error('Cannot process text message: the user is not authenticated');
      return;
    }

    try {
      // The prefix only routes the message; the answer must not be about it
      const { prefixLength } = routeByPrefix(config.ENVIRONMENT, turn.message);
      const text = (textOf(turn.message) ?? '').slice(prefixLength);
      logger.debug(`Whatsapp user sent a text message (${[...text].length} characters)`);

      const messages = await this.#callApi(turn, async () => {
        const expiryHours = await this.#expiryHours(turn.token);
        return ansariClient.completeChat(turn.token, { message: text, expiryHours });
      });
      if (messages === null) return;
      turn.typing?.stop();

      // The API supplies WhatsApp-formatted message boundaries. WhatsApp rejects blank messages, so drop blank parts.
      const parts = messages.filter((part) => part.trim() !== '');
      if (parts.length === 0) {
        logger.warn('Received an empty response from the backend');
        await this.notify(turn.replyTo, EMPTY_ANSWER_NOTICE);
        return;
      }
      await this.#deliver(turn.replyTo, parts, PROCESSING_FAILED_NOTICE);
    } catch (error) {
      logger.error('Unexpected error processing text message', error);
      await this.notify(turn.replyTo, UNEXPECTED_FAILURE_NOTICE);
    } finally {
      // Every way out of here ends the typing indicator, so none is left running
      turn.typing?.stop();
    }
  }

  // ---------- the /expiry command ----------

  /** Send the list the user picks the chat expiry from, with their current setting in the text. */
  async #sendExpiryList(turn: Turn): Promise<void> {
    const { config, logger, metaApi } = this.#options;
    const current = await this.#callApi(turn, () => this.#expiryHours(turn.token));
    if (current === null) return;
    try {
      await metaApi.sendInteractiveList(turn.replyTo, {
        bodyText: `Your current setting: ${expiryPhrase(current)}. Pick a new one below.`,
        buttonText: 'Choose',
        sectionTitle: 'Chat expiry',
        rows: EXPIRY_CHOICES_HOURS.map((hours) => ({ id: expiryRowId(hours, config.ENVIRONMENT), title: rowTitle(hours) })),
      });
    } catch (error) {
      logger.error('Error sending the chat expiry list', error);
    }
  }

  /** Save the choice from a list reply, then confirm it. A row this environment did not offer gets a short notice. */
  async #saveExpiryChoice(turn: Turn): Promise<void> {
    const { ansariClient, config } = this.#options;
    const id = listReplyId(turn.message);
    const hours = id === undefined ? undefined : parseExpiryChoice(id, config.ENVIRONMENT);
    if (hours === undefined) {
      await this.notify(turn.replyTo, INVALID_CHOICE_NOTICE);
      return;
    }
    const saved = await this.#callApi(
      turn,
      () => ansariClient.setPreference(turn.token, CHAT_RETENTION_PREFERENCE, String(hours)),
      EXPIRY_SAVE_FAILED_NOTICE,
    );
    if (saved === null) return;
    await this.notify(turn.replyTo, `Done. Your chat setting is now ${expiryPhrase(hours)}.`);
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
