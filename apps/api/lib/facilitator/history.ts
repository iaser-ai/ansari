import type { Content } from '../ai/gemini-client';
import type { Message } from './agent';

/**
 * Convert our message history to Gemini's Content[] format
 *
 * For assistant messages with rawPayload, uses the preserved Gemini Content
 * which includes tool calls and thought signatures. Falls back to text-only
 * for legacy messages without rawPayload.
 */
export function convertToGeminiHistory(messages: Message[]): Content[] {
  const history: Content[] = [];

  for (const msg of messages) {
    if (msg.role === 'user') {
      // Extract text from user messages
      const textContent = msg.content
        .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
        .map((c) => c.text)
        .join('\n');

      if (textContent) {
        history.push({
          role: 'user',
          parts: [{ text: textContent }],
        });
      }
    } else {
      // For assistant messages, prefer rawPayload if available
      // This preserves tool calls, citations, and thought signatures
      if (msg.rawPayload) {
        history.push(msg.rawPayload);
      } else {
        // Fallback for legacy messages without rawPayload
        const textContent = msg.content
          .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
          .map((c) => c.text)
          .join('');

        if (textContent) {
          history.push({
            role: 'model',
            parts: [{ text: textContent }],
          });
        }
      }
    }
  }

  return history;
}
