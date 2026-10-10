import * as Sentry from '@sentry/nextjs';
import { callGemini } from './gemini-client';
import { findMessagesByThread, updateThread } from '../db/threads';

// Cap in characters, not words: layout is character-bound and word counts are
// meaningless for unspaced scripts. 60 chars comfortably fits the 5-8 words the prompt asks for.
export const MAX_THREAD_NAME_LENGTH = 60;
// A response this many times the cap (or one spanning lines) is an answer, not a title.
const IMPLAUSIBLE_TITLE_FACTOR = 3;

/** Truncate to `max` characters on a word boundary, ending with an ellipsis. */
export function truncateTitle(text: string, max: number = MAX_THREAD_NAME_LENGTH): string {
  const chars = Array.from(text.replace(/\s+/g, ' ').trim());
  if (chars.length <= max) {
    return chars.join('');
  }
  const head = chars.slice(0, max - 1).join('');
  const lastSpace = head.lastIndexOf(' ');
  const cut = lastSpace > 0 ? head.slice(0, lastSpace) : head;
  return `${cut.replace(/[\s.,;:!?-]+$/, '')}…`;
}

/**
 * Turn a raw naming response into a storable title. A response that is clearly not a title
 * (multi-line, or far longer than requested) is replaced by a truncation of the user's question.
 */
export function toThreadTitle(rawResponse: string, userMessage: string): string {
  const cleaned = rawResponse.replace(/^["']+|["']+$/g, '').trim();
  const implausible =
    /[\r\n]/.test(cleaned) ||
    Array.from(cleaned).length > MAX_THREAD_NAME_LENGTH * IMPLAUSIBLE_TITLE_FACTOR;
  return truncateTitle(implausible ? userMessage : cleaned);
}

/**
 * If this is the first message in a thread, generate a short title and update the thread name.
 * Designed to be called with `void` prefix (fire-and-forget). Never throws.
 *
 * Call this AFTER createMessage() — it checks if exactly 1 message exists (the one just stored).
 */
export async function maybeGenerateThreadName(
  threadId: string,
  userId: string,
  userMessage: string,
): Promise<void> {
  try {
    const messages = await findMessagesByThread(threadId);
    if (messages.length !== 1) {
      return;
    }

    const prompt = `Summarize this question as a short chat title (5-8 words, no quotes): ${userMessage}`;
    const response = await callGemini(prompt);

    const title = toThreadTitle(response.text, userMessage);
    if (title) {
      await updateThread(threadId, userId, { name: title });
    }
  } catch (error) {
    console.error(`[thread-naming] Failed to auto-name thread ${threadId}:`, error);
    Sentry.captureException(error);
  }
}
