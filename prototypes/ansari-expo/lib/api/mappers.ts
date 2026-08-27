import type {
  WireThread,
  WireThreadDetail,
  WireMessage,
} from '@/lib/api/wire-schemas';
import type {
  Conversation,
  ConversationDetail,
  Message,
  MessageRole,
} from '@/lib/api/types';

/**
 * Map apps/api wire shapes onto the UI types.
 *
 * FIELDS apps/api NEVER CARRIES — filled with documented constants, NOT silent
 * defaults hiding a shape mismatch:
 *   - `preview`, `messageCount`  → apps/api's thread summary has neither.
 *   - `citations`                → apps/api returns no structured citations, so
 *                                  this is `[]` forever (by design). CitationChip/
 *                                  CitationSheet therefore render nothing.
 *   - `safety`                   → apps/api emits no safety signal, so `null`
 *                                  forever. SafetyCard renders nothing.
 * These are the exact "empty by design" fields called out in the issue/README.
 * The loud-failure guarantee lives in the zod parse UPSTREAM of these mappers:
 * a wrong-shaped response never reaches here — it throws at `.parse()`.
 */

const UNTITLED = 'New conversation';

export function mapConversation(thread: WireThread): Conversation {
  return {
    id: thread.thread_id,
    title: thread.thread_name?.trim() || UNTITLED,
    preview: '', // apps/api has no preview
    messageCount: 0, // apps/api has no message count
    createdAt: thread.created_at ?? '',
    updatedAt: thread.updated_at ?? thread.created_at ?? '',
  };
}

export function mapConversationList(threads: WireThread[]): Conversation[] {
  return threads.map(mapConversation);
}

/**
 * Flatten a message's `content` (string | ContentBlock[]) to a display string by
 * joining the text of every `text` block. Non-text blocks (tool_use/result,
 * document) are not rendered by this UI and are dropped. A bare string passes
 * through. (Genuinely malformed content is already rejected by the zod schema.)
 */
function flattenContent(content: WireMessage['content']): string {
  if (typeof content === 'string') return content;
  return content
    .filter(
      (block): block is { type: 'text'; text: string } => block.type === 'text',
    )
    .map((block) => block.text)
    .join('\n\n');
}

/** apps/api roles are 'user' | 'assistant' | 'tool'; the UI knows only two. */
function mapRole(role: string): MessageRole | null {
  if (role === 'user') return 'user';
  if (role === 'assistant') return 'assistant';
  return null; // 'tool' and anything else: internal, not shown
}

export function mapMessage(
  msg: WireMessage,
  conversationId: string,
): Message | null {
  const role = mapRole(msg.role);
  if (!role) return null;
  return {
    id: msg.id,
    conversationId,
    role,
    content: flattenContent(msg.content),
    citations: [], // empty by design — apps/api returns no citations
    safety: null, // null by design — apps/api emits no safety signal
    createdAt: msg.created_at ?? '',
  };
}

export function mapConversationDetail(
  detail: WireThreadDetail,
): ConversationDetail {
  const id = detail.thread_id;
  const messages = detail.messages
    .map((m) => mapMessage(m, id))
    .filter((m): m is Message => m !== null);
  return {
    id,
    title: detail.thread_name?.trim() || UNTITLED,
    createdAt: detail.created_at ?? '',
    updatedAt: detail.updated_at ?? detail.created_at ?? '',
    messages,
  };
}
