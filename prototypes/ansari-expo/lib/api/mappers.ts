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
import { SAMPLE_CITATIONS } from '@/lib/sample-citations';

/**
 * Map apps/api wire shapes onto the UI types.
 *
 * FIELDS apps/api NEVER CARRIES — filled with documented constants, NOT silent
 * defaults hiding a shape mismatch:
 *   - `preview`, `messageCount`  → apps/api's thread summary has neither.
 *   - `citations`                → apps/api returns no structured citations. To
 *                                  keep the citation UI demonstrable, assistant
 *                                  messages in a thread about khushu' get a FIXED
 *                                  SAMPLE set (see `lib/sample-citations.ts`);
 *                                  every other message gets `[]`. These samples
 *                                  are not answer-derived — real citations arrive
 *                                  with issue #66.
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

/**
 * A thread counts as "about khushu'" when its first user message mentions it
 * (khushu' / khushoo / khushū). Only then do we attach the sample citations, so
 * they sit under an answer they actually support rather than under every reply.
 */
function isKhushuThread(messages: Message[]): boolean {
  const firstUser = messages.find((m) => m.role === 'user');
  if (!firstUser) return false;
  return /khush/i.test(firstUser.content);
}

export function mapConversationDetail(
  detail: WireThreadDetail,
): ConversationDetail {
  const id = detail.thread_id;
  const mapped = detail.messages
    .map((m) => mapMessage(m, id))
    .filter((m): m is Message => m !== null);
  const messages = isKhushuThread(mapped)
    ? mapped.map((m) =>
        m.role === 'assistant' ? { ...m, citations: SAMPLE_CITATIONS } : m,
      )
    : mapped;
  return {
    id,
    title: detail.thread_name?.trim() || UNTITLED,
    createdAt: detail.created_at ?? '',
    updatedAt: detail.updated_at ?? detail.created_at ?? '',
    messages,
  };
}
