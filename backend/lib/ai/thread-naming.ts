import * as Sentry from '@sentry/nextjs';
import { callGemini } from './gemini-client';
import { findMessagesByThread, updateThread } from '../db/threads';

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

    const cleaned = response.text.replace(/^["']+|["']+$/g, '').trim();
    if (cleaned) {
      await updateThread(threadId, userId, { name: cleaned });
    }
  } catch (error) {
    console.error(`[thread-naming] Failed to auto-name thread ${threadId}:`, error);
    Sentry.captureException(error);
  }
}
