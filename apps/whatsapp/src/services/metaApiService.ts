/**
 * Sending messages to WhatsApp users through Meta's Cloud API.
 *
 * Python counterparts: `meta_api_service_base.py` (the interface), `meta_api_service_real.py` and
 * `meta_api_service_mock.py`.
 *
 * Differences from Python:
 * - One `MetaApiError` replaces httpx's two exceptions (`HTTPStatusError` for a bad status, `RequestError` for a network
 *   fault); its `status` is Meta's HTTP status, or `undefined` for a network fault. Callers only ever caught `Exception`.
 * - `fetch` has no per-phase timeouts like httpx's `Timeout(20, connect=10)`: each request gets one 20 s deadline.
 * - What Sentry gets is handed in as a function (`reportError`), so this file never imports Sentry.
 */
import type { Secret } from '../config';
import { MetaApiError } from '../errors';
import type { ErrorReporter } from '../errorReporter';
import { noopErrorReporter } from '../errorReporter';
import { getRequestId, type Logger } from '../logger';
import { maskIdentifiers, redactValues } from '../logMasking';
import { pythonList, pythonRepr } from '../utils/pythonRepr';
import { describeNetworkError, discardBody, type FetchLike } from './http';

/** Sending to a user is the answer they are waiting for; Meta can take longer than a few seconds to accept one. */
const REQUEST_TIMEOUT_MS = 20_000;

/** String values of a send payload that describe its shape and name nobody (the rest is masked outside development). */
const SAFE_REQUEST_KEYS: ReadonlySet<string> = new Set(['messaging_product', 'type', 'recipient_type', 'status']);

export interface MetaApiService {
  /**
   * Show the "typing..." indicator for a message the user sent. `recipient` is not sent: Meta ties the indicator to
   * `messageId`.
   *
   * @throws {MetaApiError} if Meta refuses or cannot be reached.
   */
  sendTypingIndicator(recipient: string, messageId: string): Promise<void>;
  /**
   * Send already-split message parts, in order.
   *
   * @throws {MetaApiError} if Meta refuses or cannot be reached; parts after the failed one are not sent.
   */
  sendMessage(recipient: string, messageParts: string[]): Promise<void>;
}

/** A number, but not `true`/`false` (Python's `isinstance(value, int) and not isinstance(value, bool)`). */
function integerOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `String(value or "")` cut to `max` characters. Python's `str[:n]` counts code points. */
function clip(value: unknown, max: number): string {
  if (value === null || value === undefined || value === '' || value === false || value === 0) return '';
  return [...String(value)].slice(0, max).join('');
}

/**
 * The structured part of Meta's error reply, with anything shaped like an identifier masked.
 *
 * Meta documents the error object as `code`, `type`, `error_subcode`, `fbtrace_id`, `message` (the code and its title) and
 * `error_data.details`, but not that none of them can name the recipient, so the two texts are masked.
 * https://developers.facebook.com/documentation/business-messaging/whatsapp/support/error-codes
 */
export async function metaErrorSummary(response: Response): Promise<string> {
  const raw = await response.text().catch(() => '');
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    body = undefined;
  }
  const error = isRecord(body) ? body.error : undefined;
  if (!isRecord(error)) return `no standard error object (${new TextEncoder().encode(raw).length} bytes)`;
  const errorData = isRecord(error.error_data) ? error.error_data : {};

  const fields: Array<[string, unknown]> = [
    ['code', integerOrNull(error.code)],
    ['error_subcode', integerOrNull(error.error_subcode)],
    ['type', maskIdentifiers(clip(error.type, 64))],
    ['fbtrace_id', maskIdentifiers(clip(error.fbtrace_id, 64))],
    ['message', maskIdentifiers(clip(error.message, 300))],
    ['details', maskIdentifiers(clip(errorData.details, 300))],
  ];
  return fields
    .filter(([, value]) => value !== null && value !== '')
    .map(([name, value]) => `${name}=${pythonRepr(value)}`)
    .join(' ');
}

export interface MetaApiOptions {
  /** `https://graph.facebook.com/{version}/{phone-number-id}/messages`, from the settings. */
  apiUrl: string;
  accessToken: Secret;
  /** Decides how much of a rejected request is logged. */
  environment: 'development' | 'staging' | 'production';
  logger: Logger;
  reportError?: ErrorReporter;
  fetch?: FetchLike;
}

/** The real service: calls Meta's Cloud API. */
export class MetaApiServiceReal implements MetaApiService {
  readonly #options: MetaApiOptions;
  readonly #fetch: FetchLike;
  readonly #reportError: ErrorReporter;

  constructor(options: MetaApiOptions) {
    this.#options = options;
    this.#fetch = options.fetch ?? fetch;
    this.#reportError = options.reportError ?? noopErrorReporter;
  }

  #headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.#options.accessToken.reveal()}`, 'Content-Type': 'application/json' };
  }

  /** POST one JSON payload to Meta. Anything but a 2xx raises, after logging what Meta said. */
  async #post(payload: Record<string, unknown>, what: string, endpoint: string): Promise<void> {
    const { logger } = this.#options;
    let response: Response;
    try {
      response = await this.#fetch(this.#options.apiUrl, {
        method: 'POST',
        headers: this.#headers(),
        body: JSON.stringify(payload),
        redirect: 'manual',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      logger.error(`Network error sending ${what} (${describeNetworkError(error)})`);
      throw new MetaApiError(`Network error sending ${what}`, undefined, { cause: error });
    }

    if (response.ok) {
      await discardBody(response);
      return;
    }

    logger.error(`HTTP error sending ${what}: ${response.status}`);
    await this.#logMetaError(response, payload);
    const error = new MetaApiError(`Meta answered HTTP ${response.status} to ${what}`, response.status);
    // Only report 5xx errors (Meta's fault, not ours)
    if (response.status >= 500) {
      this.#reportError(error, {
        errorType: 'meta_api_failure',
        context: { status_code: response.status, endpoint, request_id: getRequestId() },
      });
    }
    throw error;
  }

  /**
   * Log what Meta said, and for a 400 what we sent.
   *
   * Meta's raw body is never logged, only its structured fields with identifiers masked. For a 400 the payload's keys are
   * logged everywhere; their values too, masked on staging and unmasked only on development.
   */
  async #logMetaError(response: Response, sent: Record<string, unknown>): Promise<void> {
    const { logger, environment } = this.#options;
    logger.error(`Meta's reply (${response.status}): ${await metaErrorSummary(response)}`);
    if (response.status !== 400) return;

    let line = `Meta rejected the request (400). URL: ${this.#options.apiUrl} | Payload keys: ${pythonList(Object.keys(sent).sort())}`;
    if (environment !== 'production') {
      const headers = Object.fromEntries(
        Object.entries(this.#headers()).map(([key, value]) => [key, key.toLowerCase() === 'authorization' ? 'Bearer ***' : value]),
      );
      line += ` | Headers: ${pythonRepr(headers)}`;
      line +=
        environment === 'development'
          ? ` | Body: ${JSON.stringify(sent)}`
          : ` | Body with values masked: ${pythonRepr(redactValues(sent, SAFE_REQUEST_KEYS))}`;
    }
    logger.error(line);
  }

  async sendTypingIndicator(recipient: string, messageId: string): Promise<void> {
    const { logger } = this.#options;
    if (!recipient || !messageId) {
      logger.error('Cannot send typing indicator: missing recipient or message id');
      return;
    }
    logger.debug('Sending typing indicator');
    await this.#post(
      { messaging_product: 'whatsapp', status: 'read', message_id: messageId, typing_indicator: { type: 'text' } },
      'typing indicator',
      'send_typing_indicator',
    );
    logger.info('Typing indicator sent successfully');
  }

  /**
   * Per Meta, a phone number goes in `to`, while a BSUID goes in `recipient` (with `to` omitted; if both are sent, `to`
   * takes precedence). Meta's changelog says BSUID sending is supported since July 2026.
   * https://developers.facebook.com/documentation/business-messaging/whatsapp/business-scoped-user-ids#send-message-requests
   */
  async sendMessage(recipient: string, messageParts: string[]): Promise<void> {
    const { logger } = this.#options;
    if (!recipient) {
      logger.error('Cannot send message: No recipient');
      return;
    }
    if (messageParts.length === 0) {
      logger.warn('No message parts to send');
      return;
    }

    logger.debug(`Sending ${messageParts.length} message part(s)`);
    for (const [index, part] of messageParts.entries()) {
      const payload: Record<string, unknown> = { messaging_product: 'whatsapp', type: 'text', text: { body: part } };
      // Digits only is a phone number; anything else is a business-scoped user ID (e.g. US.1349...)
      if (/^[0-9]+$/.test(recipient)) {
        payload.to = recipient;
      } else {
        payload.recipient_type = 'individual';
        payload.recipient = recipient;
      }
      await this.#post(payload, 'message', 'send_message');
      logger.info(`Sent message part ${index + 1}/${messageParts.length}: ${[...part].length} characters`);
    }
    logger.info(`All ${messageParts.length} message part(s) sent successfully`);
  }
}

/** A stand-in for Meta that sends nothing, for local development (`MOCK_META_API`). Records what it was asked to send. */
export class MetaApiServiceMock implements MetaApiService {
  /** Every `sendMessage` call, so a test can assert on who was written to and what. */
  readonly sent: Array<{ recipient: string; messageParts: string[] }> = [];
  readonly #logger: Logger;
  readonly #delayMs: number;

  constructor(options: { logger: Logger; delayMs?: number }) {
    this.#logger = options.logger;
    this.#delayMs = options.delayMs ?? 50;
    this.#logger.info('Initialized MetaApiServiceMock - Meta API calls will be simulated');
  }

  async sendTypingIndicator(_recipient: string, messageId: string): Promise<void> {
    this.#logger.info(`[MOCK META API] Typing indicator simulated (msg_id: ${messageId})`);
    // A minimal network delay
    await new Promise((resolve) => setTimeout(resolve, this.#delayMs));
  }

  async sendMessage(recipient: string, messageParts: string[]): Promise<void> {
    this.#logger.info(`[MOCK META API] Sending ${messageParts.length} message part(s)`);
    this.sent.push({ recipient, messageParts: [...messageParts] });
    for (const [index, part] of messageParts.entries()) {
      this.#logger.info(`[MOCK META API] Part ${index + 1}/${messageParts.length}: ${[...part].length} characters`);
    }
  }
}
