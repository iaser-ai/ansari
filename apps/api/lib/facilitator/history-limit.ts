/**
 * Thread history limits (issue #400).
 *
 * Every turn sends the whole thread to the model, so a thread that grows without
 * bound ends in prompts of a million tokens, 60 s hangs and refusals. Two thresholds
 * (config.threadHistory, in estimated tokens) bound it: from `warnTokens` an answer
 * ends with a notice to start a new conversation soon; from `blockTokens` no model
 * is called and the notice is the answer.
 *
 * The size is an ESTIMATE of the history about to be sent: the UTF-8 bytes of every
 * text part `convertToGeminiHistory` produces, divided by BYTES_PER_TOKEN. It is not
 * `messages.input_tokens`: that column is summed over every model call of a turn
 * (each tool round re-sends the history), so it overstates the thread by a factor
 * that changes from turn to turn, and it is absent on failed turns and old rows.
 * Not counted: the system prompt and tool declarations (about 2,300 tokens, fixed)
 * and thoughtSignature blobs in stored payloads.
 */
import { config } from '../config';
import { convertToGeminiHistory } from './history';
import type { FacilitatorStreamEvent, Message } from './agent';

/**
 * Bytes, not characters: Arabic is two bytes a character and takes more tokens per
 * character than English. The figure rests on issue #399's production threads (4.2
 * and 4.7 MB of text refused at Gemini's 1,048,576-token limit), which is no more
 * precise than "about 4". The thresholds sit at a fifth of that limit, so an
 * estimate a third off still blocks long before the failures it exists to prevent.
 */
export const BYTES_PER_TOKEN = 4;

/** Ends an answer on a thread at or over the warn threshold. */
export const HISTORY_WARNING_MESSAGE =
  'Note: this conversation is getting long. Please start a new conversation soon. Ansari cannot continue a conversation beyond a certain length.';

/** The whole answer on a thread at or over the block threshold. */
export const HISTORY_BLOCK_MESSAGE =
  'This conversation has become too long for Ansari to continue. Please start a new conversation and ask your question there.';

/** The 400 body on the stateless routes, whose callers send the history themselves. */
export const HISTORY_REQUEST_TOO_LONG_MESSAGE =
  'The conversation in this request is too long. Send fewer or shorter messages.';

export type HistoryVerdict = 'ok' | 'warn' | 'block';

export interface HistoryAssessment {
  verdict: HistoryVerdict;
  estimatedTokens: number;
}

/** Estimated tokens of the history `messages` would send, the newest message included. */
export function estimateHistoryTokens(messages: Message[]): number {
  let bytes = 0;
  for (const content of convertToGeminiHistory(messages)) {
    for (const part of content.parts ?? []) {
      if (typeof part.text === 'string') bytes += Buffer.byteLength(part.text, 'utf8');
    }
  }
  return Math.ceil(bytes / BYTES_PER_TOKEN);
}

export function assessHistory(messages: Message[]): HistoryAssessment {
  const estimatedTokens = estimateHistoryTokens(messages);
  const { warnTokens, blockTokens } = config.threadHistory;
  const verdict: HistoryVerdict =
    estimatedTokens >= blockTokens ? 'block' : estimatedTokens >= warnTokens ? 'warn' : 'ok';
  return { verdict, estimatedTokens };
}

/**
 * One turn of a stored thread, with the limits applied. `run` starts the facilitator
 * and is never called on a blocked thread.
 *
 * The notices travel as ordinary `text` events ahead of `done`, so the thread routes
 * stream and store them like any answer. Stored, they survive the web app's re-read
 * of the thread after `done`; streamed only, the block would be replaced there by a
 * retry prompt. The warning follows an answer and is never the whole of one: an
 * empty answer stays empty for the routes' own empty-answer handling.
 */
export async function* limitThreadTurn(
  messages: Message[],
  threadId: string,
  run: () => AsyncGenerator<FacilitatorStreamEvent>
): AsyncGenerator<FacilitatorStreamEvent> {
  const { verdict, estimatedTokens } = assessHistory(messages);
  if (verdict === 'ok') {
    yield* run();
    return;
  }

  console.warn('[history-limit] thread history over a threshold', { threadId, verdict, estimatedTokens });

  if (verdict === 'block') {
    yield { type: 'text', data: HISTORY_BLOCK_MESSAGE };
    yield { type: 'done', data: '' };
    return;
  }

  let answered = false;
  for await (const event of run()) {
    if (event.type === 'text' && event.data.trim().length > 0) answered = true;
    if (event.type === 'done' && answered) {
      yield { type: 'text', data: `\n\n${HISTORY_WARNING_MESSAGE}` };
    }
    yield event;
  }
}
