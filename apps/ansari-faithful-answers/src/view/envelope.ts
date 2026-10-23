// The app's one answer envelope `{version, question, answer}`: the tool's `structuredContent`. Its
// validation is here; how a whole delivered result is read (a failed call, a host that delivers only
// text, a malformed envelope) is `tool-result.ts`, which uses this validation. Pure and DOM-free, so Node
// tests can import it. The answer is passed through unchanged.

/** Version of the app's answer envelope `{version, question, answer}`; equal to the route's and the MCP tool's. */
export const ANSWER_ENVELOPE_VERSION = '0.1.0';

/**
 * Largest answer the card accepts, in UTF-16 code units (JavaScript `String.length`). This is a
 * different unit from the demo route's bound, which counts UTF-8 bytes (256 KiB = 262,144 bytes).
 * Every string of at most 262,144 UTF-8 bytes has at most 262,144 UTF-16 code units, so no answer
 * the route returns can exceed this bound. A longer answer (for example one sent to the MCP view)
 * is refused by the card with a visible message; it is never clipped.
 */
export const CARD_MAX_UTF16_UNITS = 262_144;

export type AnswerEnvelope = {readonly question: string; readonly answer: string};

/** Validates the app's envelope. Anything else is refused; nothing is repaired or guessed. */
export function readAnswerEnvelope(value: unknown): AnswerEnvelope | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const fields = value as {answer?: unknown; question?: unknown; version?: unknown};
  if (fields.version !== ANSWER_ENVELOPE_VERSION || typeof fields.question !== 'string') return undefined;
  if (typeof fields.answer !== 'string' || fields.answer.length === 0) return undefined;
  return {question: fields.question, answer: fields.answer};
}
