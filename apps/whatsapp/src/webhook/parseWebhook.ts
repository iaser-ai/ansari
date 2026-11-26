/**
 * Read what Meta's webhook says: which number it is for, whether it is a delivery receipt or a message, and who wrote it.
 *
 * Python counterpart: `parse_meta_payload` in `legacy/whatsapp/src/ansari_whatsapp/utils/whatsapp_webhook_utils.py`.
 * (Its signature check and response helper belong to the HTTP layer and are ported with it.)
 *
 * A TypeScript type is erased when the program is compiled, so nothing about the type of `body` is checked while the
 * service runs. That is why the parameter is `unknown` ("could be anything; look before you use it") and every step
 * below narrows it with a check, much as Python's `dict.get` calls and `isinstance` checks do.
 *
 * Differences from Python:
 * - It returns a tagged union (`ParsedWebhook`) instead of an 8-tuple of flags. The `kind` field tells the compiler
 *   which other fields exist, so `message.bsuid` only type-checks once `kind === 'message'` has been checked.
 * - It is synchronous (the Python one was `async` but never awaited anything) and takes the settings it needs as an
 *   argument instead of reading them from a global.
 * - Python raised a bare `Exception`, `IndexError` or `ValueError` for malformed bodies. All of those are
 *   `InvalidMetaPayloadError` here; the one case where the user can still be told is `UnexpectedMetaPayloadError`.
 * - Errors and log lines carry the payload with its text masked (`<str len=N>`), never the raw message or numbers.
 * - A `from_user_id` that is not a non-empty string is refused. Python passed any value along and failed later.
 */
import type { Env } from '../config';
import { InvalidMetaPayloadError, UnexpectedMetaPayloadError } from '../errors';
import type { Logger } from '../logger';
import { redactValues } from '../logMasking';
import { pythonList } from '../utils/pythonRepr';

/** What a webhook turned out to be. */
export type ParsedWebhook =
  /** Meant for another business number on the same app; ignore. */
  | { kind: 'other_number' }
  /** A delivery receipt (sent, delivered, read), not a user message; ignore. */
  | { kind: 'status' }
  /** A message from a user. */
  | {
      kind: 'message';
      /** The sender's business-scoped user ID: the only identity this service uses. */
      bsuid: string;
      /** `text`, `image`, ... or `errors` when Meta sent an unsupported type (video note, gif, poll). */
      messageType: string;
      /** Whatever Meta put under that type; `{ body: '...' }` for text, a list for `errors`. */
      messageBody: unknown;
      messageId: string | null;
      /** Unix seconds, or `null` when Meta sent none. */
      messageUnixTime: number | null;
      /** The webhook's `from`, only read when `META_REPLY_BY_PHONE` is on, and used only to address the reply. */
      senderPhone: string | null;
    };

/** What `parseMetaPayload` needs from the settings. `Pick` takes just those two fields of the full `Env` type. */
export type WebhookConfig = Pick<Env, 'META_BUSINESS_PHONE_NUMBER_ID' | 'META_REPLY_BY_PHONE'>;

/**
 * Keys whose string values are safe to log as they are. Everything else is masked: phone numbers, names, text, and ids
 * (a message id is base64 that carries the sender's phone number).
 */
const UNREDACTED_KEYS: ReadonlySet<string> = new Set(['object', 'field', 'messaging_product', 'type', 'timestamp']);

function redactForLogging(value: unknown): string {
  return JSON.stringify(redactValues(value, UNREDACTED_KEYS));
}

/**
 * A type guard: when it returns true, TypeScript treats `value` as a plain object in the code that follows.
 * (Python: `isinstance(value, dict)`.) Arrays and `null` are objects in JavaScript, so they are excluded explicitly.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Does `obj` have its own property `key`? (Python: `key in dict`.) JavaScript's `in` operator also finds inherited
 * names such as `constructor` and `toString`, so a message declaring `"type": "constructor"` would be taken for a
 * message that has a `constructor` field. `Object.hasOwn` looks only at the object's own keys.
 */
function has(obj: object, key: string): boolean {
  return Object.hasOwn(obj, key);
}

function invalidPayload(message: string, logger?: Pick<Logger, 'error'>): InvalidMetaPayloadError {
  logger?.error(message);
  return new InvalidMetaPayloadError(message);
}

/** `entry[0].changes[0].value`, if the envelope is shaped as Meta documents it and the value is not empty. */
function findValue(body: unknown): Record<string, unknown> | undefined {
  if (!isRecord(body) || !body.object) return undefined;

  const entry = body.entry;
  if (!Array.isArray(entry) || entry.length === 0) return undefined;
  const firstEntry: unknown = entry[0];
  if (!isRecord(firstEntry)) return undefined;

  const changes = firstEntry.changes;
  if (!Array.isArray(changes) || changes.length === 0) return undefined;
  const firstChange: unknown = changes[0];
  if (!isRecord(firstChange)) return undefined;

  const value = firstChange.value;
  return isRecord(value) && Object.keys(value).length > 0 ? value : undefined;
}

/**
 * Python's `int(timestamp)` for what Meta sends: a string of digits. A missing or null timestamp is `null`.
 * (Python's `int()` also accepts underscores and non-ASCII digits; Meta sends neither.)
 */
function parseUnixTime(raw: unknown): number | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw === 'number' && Number.isFinite(raw)) return Math.trunc(raw);
  if (typeof raw === 'string' && /^\s*[+-]?\d+\s*$/.test(raw)) return Number.parseInt(raw, 10);
  throw new InvalidMetaPayloadError(`The message timestamp is not an integer (it is ${typeof raw})`);
}

/** A message whose payload lacks `key`: the user can still be told, so the sender is worked out for the reply. */
function missingKey(
  key: string,
  message: Record<string, unknown>,
  value: Record<string, unknown>,
  logger?: Pick<Logger, 'error'>,
): UnexpectedMetaPayloadError {
  logger?.error(`Missing key '${key}' in messages[0]; redacted webhook value: ${redactForLogging(value)}`);

  const contacts = value.contacts;
  const contact = Array.isArray(contacts) && contacts.length > 0 && isRecord(contacts[0]) ? contacts[0] : {};
  const fromMessage = typeof message.from_user_id === 'string' ? message.from_user_id : '';
  const fromContact = typeof contact.user_id === 'string' ? contact.user_id : '';

  return new UnexpectedMetaPayloadError(
    `Missing key '${key}' in messages[0]; keys present: ${pythonList(Object.keys(message).sort())}`,
    fromMessage || fromContact || undefined,
  );
}

/**
 * Parse the JSON body of a webhook request from Meta.
 *
 * @throws {UnexpectedMetaPayloadError} `messages[0]` lacks a key we need; carries who to tell, if known.
 * @throws {InvalidMetaPayloadError} The body is not shaped as Meta documents it.
 */
export function parseMetaPayload(
  body: unknown,
  config: WebhookConfig,
  logger?: Pick<Logger, 'info' | 'error'>,
): ParsedWebhook {
  const value = findValue(body);
  if (value === undefined) {
    throw invalidPayload(
      `Invalid received payload from WhatsApp user and/or problem with Meta's API:\n${redactForLogging(body)}`,
      logger,
    );
  }

  // Metadata is always present in a valid webhook; it says which of our numbers the webhook is for
  if (!has(value, 'metadata')) {
    throw invalidPayload(`Missing metadata in webhook payload from WhatsApp API:\n${redactForLogging(value)}`, logger);
  }
  const metadata = value.metadata;
  if (!isRecord(metadata) || !has(metadata, 'phone_number_id')) {
    throw invalidPayload(
      `Missing phone_number_id in webhook payload metadata:\n${redactForLogging(metadata)}`,
      logger,
    );
  }

  if (metadata.phone_number_id !== config.META_BUSINESS_PHONE_NUMBER_ID.reveal()) {
    return { kind: 'other_number' };
  }

  // A delivery receipt (delivered, read, ...), not a message from a user
  if (has(value, 'statuses')) return { kind: 'status' };

  if (!has(value, 'messages')) {
    throw invalidPayload(`Unsupported message type received from WhatsApp user:\n${redactForLogging(body)}`, logger);
  }
  const messages = value.messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    throw invalidPayload(`The webhook has no message to read:\n${redactForLogging(value)}`, logger);
  }
  const message: unknown = messages[0];
  if (!isRecord(message)) {
    throw invalidPayload(`messages[0] is not an object:\n${redactForLogging(value)}`, logger);
  }

  // `from_user_id` (the BSUID) is always present and is the only identity used.
  // `from` (the phone number) may be missing, and is read only when replies go to the phone (test numbers).
  const messageId = typeof message.id === 'string' ? message.id : null;

  if (!has(message, 'from_user_id')) throw missingKey('from_user_id', message, value, logger);
  const bsuid = message.from_user_id;
  if (typeof bsuid !== 'string' || bsuid === '') {
    throw new UnexpectedMetaPayloadError(
      `Key 'from_user_id' in messages[0] must be a non-empty string; keys present: ${pythonList(Object.keys(message).sort())}`,
      typeof message.from === 'string' && config.META_REPLY_BY_PHONE ? message.from : undefined,
    );
  }

  const senderPhone = config.META_REPLY_BY_PHONE && typeof message.from === 'string' ? message.from : null;
  const messageUnixTime = parseUnixTime(message.timestamp);

  if (!has(message, 'type')) throw missingKey('type', message, value, logger);
  const declaredType = message.type;
  // Python raises TypeError for a list or dict here (it cannot be looked up as a key)
  if (Array.isArray(declaredType) || isRecord(declaredType)) {
    throw invalidPayload(`messages[0].type is not a string:\n${redactForLogging(value)}`, logger);
  }

  // Meta API note: Meta sends an "errors" key when receiving unsupported message types
  // (e.g., video notes, gifs sent from giphy, or polls)
  const messageType = typeof declaredType === 'string' && has(message, declaredType) ? declaredType : 'errors';
  if (!has(message, messageType)) throw missingKey(messageType, message, value, logger);

  logger?.info(`Received a supported whatsapp message (type: ${messageType})`);

  return {
    kind: 'message',
    bsuid,
    messageType,
    messageBody: message[messageType],
    messageId,
    messageUnixTime,
    senderPhone,
  };
}
