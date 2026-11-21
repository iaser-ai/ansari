/**
 * Time helpers: elapsed-time text for logs, the conversation expiry, and the stale-message check.
 *
 * Python counterpart: `legacy/whatsapp/src/ansari_whatsapp/utils/time_utils.py`.
 *
 * Differences from Python, all deliberate:
 * - The clock and the settings are arguments, not globals. Python read `get_settings()` and `datetime.now()` inside
 *   each function, so its tests had to patch both; here a test passes the instant and the threshold it wants.
 * - `Date` replaces `datetime`. A JavaScript `Date` is a count of milliseconds since 1970-01-01 UTC, so there is no
 *   time zone to get wrong (Python needed `timezone.utc` everywhere).
 */
import type { Logger } from '../logger';

/**
 * Format a number the way Python's `f"{value:.1f}"` does. JavaScript's `toFixed(1)` differs in two ways:
 * - A value exactly halfway between two outputs rounds to the even digit in Python (0.25 -> "0.2", 0.75 -> "0.8") but
 *   always up in JavaScript (0.25 -> "0.3"). With one decimal this happens exactly when the value is an odd multiple
 *   of 0.25, which is exact in binary, so it can be detected without rounding error.
 * - Infinity prints as "inf" (Python) rather than "Infinity".
 */
function formatOneDecimal(value: number): string {
  if (Number.isNaN(value)) return 'nan';
  if (!Number.isFinite(value)) return value > 0 ? 'inf' : '-inf';
  const sign = value < 0 || Object.is(value, -0) ? '-' : '';
  const magnitude = Math.abs(value);
  const quarters = magnitude * 4;
  if (Number.isInteger(quarters) && quarters % 2 === 1) {
    const tenths = Math.floor(magnitude * 10);
    return sign + ((tenths % 2 === 0 ? tenths : tenths + 1) / 10).toFixed(1);
  }
  return sign + magnitude.toFixed(1);
}

/** Format a time delta in seconds as text, e.g. "5.2 seconds", "3.1 minutes", "2.5 hours", "1.2 days". */
export function formatTimeDelta(seconds: number): string {
  if (seconds < 60) return `${formatOneDecimal(seconds)} seconds`;
  if (seconds < 3600) return `${formatOneDecimal(seconds / 60)} minutes`;
  if (seconds < 86400) return `${formatOneDecimal(seconds / 3600)} hours`;
  return `${formatOneDecimal(seconds / 86400)} days`;
}

/**
 * Time since the last message, in seconds, and a compact form for logging ("5.2sec", "3.1mins", "2.5hours", "1.2days").
 *
 * No previous message gives `Infinity` seconds (Python: `float("inf")`), which is longer than any retention time, so the
 * conversation starts a new thread. Its logging text is "infdays", as in Python.
 *
 * @param lastMessageTime When the user last wrote, or `null` if they never did.
 * @param now The current time; only tests pass it.
 */
export function calculateTimePassed(
  lastMessageTime: Date | null,
  now: Date = new Date(),
): { seconds: number; forLogging: string } {
  const seconds = lastMessageTime === null ? Infinity : (now.getTime() - lastMessageTime.getTime()) / 1000;

  let forLogging: string;
  if (seconds < 60) forLogging = `${formatOneDecimal(seconds)}sec`;
  else if (seconds < 3600) forLogging = `${formatOneDecimal(seconds / 60)}mins`;
  else if (seconds < 86400) forLogging = `${formatOneDecimal(seconds / 3600)}hours`;
  else forLogging = `${formatOneDecimal(seconds / 86400)}days`;

  return { seconds, forLogging };
}

/** The chat retention time in seconds, from `WHATSAPP_CHAT_RETENTION_HOURS`. After this much silence a new thread starts. */
export function getRetentionTimeSeconds(retentionHours: number): number {
  return retentionHours * 60 * 60;
}

/**
 * The range of unix seconds Python's `datetime.fromtimestamp(..., tz=utc)` accepts on Linux (where Railway runs): the
 * years 1 to 9999. Beyond it Python raises `ValueError`, which `is_message_too_old` catches and answers "not too old".
 */
const MIN_PYTHON_UNIX_TIME = -62135596800;
const MAX_PYTHON_UNIX_TIME = 253402300799;

/**
 * Is an incoming message older than the allowed threshold?
 *
 * Uses the message's own timestamp (unix seconds, as Meta sends it) rather than the arrival time.
 *
 * When the age cannot be worked out, the message is treated as NOT too old and gets answered:
 * - no timestamp at all, including `0` (Python's `if not message_unix_time` treats epoch zero as missing too);
 * - a timestamp that is not a finite number, or lies outside the years 1 to 9999.
 *
 * @param messageUnixTime Seconds since 1970-01-01 UTC, from Meta's `timestamp` field.
 * @param thresholdSeconds `WHATSAPP_MESSAGE_AGE_THRESHOLD_SECONDS`.
 * @param options.now The current time; only tests pass it.
 * @param options.logger Receives the same debug and error lines as the Python service.
 */
export function isMessageTooOld(
  messageUnixTime: number | null | undefined,
  thresholdSeconds: number,
  options: { now?: Date; logger?: Pick<Logger, 'debug' | 'error'> } = {},
): boolean {
  const { now = new Date(), logger } = options;

  // Not `!messageUnixTime`: NaN is falsy in JavaScript but truthy in Python, and belongs in the unusable-timestamp branch
  if (messageUnixTime === null || messageUnixTime === undefined || messageUnixTime === 0) {
    logger?.debug('No timestamp available, cannot determine message age');
    return false;
  }

  if (
    !Number.isFinite(messageUnixTime) ||
    messageUnixTime < MIN_PYTHON_UNIX_TIME ||
    messageUnixTime > MAX_PYTHON_UNIX_TIME
  ) {
    logger?.error(`Error parsing message timestamp: ${messageUnixTime} is not a usable unix time`);
    return false;
  }

  const ageSeconds = now.getTime() / 1000 - messageUnixTime;
  logger?.debug(`Message age: ${formatTimeDelta(ageSeconds)}`);
  return ageSeconds > thresholdSeconds;
}
