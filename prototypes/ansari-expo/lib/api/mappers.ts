import type {
  WireDocument,
  WireThread,
  WireThreadDetail,
  WireThreadDocuments,
  WireMessage,
} from '@/lib/api/wire-schemas';
import type {
  Conversation,
  ConversationDetail,
  Message,
  MessageRole,
} from '@/lib/api/types';
import { SAMPLE_ANSWER_CONTENT, SAMPLE_CITATIONS } from '@/lib/sample-citations';
import { stripUnbackedCitations } from '@/lib/citations';
import { resolveCitations } from '@/lib/document-citations';

/**
 * Map apps/api wire shapes onto the UI types.
 *
 * CITATIONS come from the answer's real source documents, fetched from
 * `GET /threads/{id}/documents` (spec 168) and joined in by `joinThreadDocuments`
 * below: see `lib/document-citations.ts`, which also keeps each of the model's inline `[N]`
 * markers it can tie to one of those documents and drops the rest. An answer
 * with no documents gets `[]`, and its citation-shaped text is stripped. One
 * fallback demo remains: the FIRST assistant answer of a thread about khushu',
 * when it has no real documents, gets the FIXED SAMPLE set and answer text from
 * `lib/sample-citations.ts` (illustrative, not API output). A real answer is
 * never overwritten by the sample.
 *
 * FIELDS apps/api NEVER CARRIES — filled with documented constants, NOT silent
 * defaults hiding a shape mismatch:
 *   - `preview`, `messageCount`  → apps/api's thread summary has neither.
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
 * Client-side History search. apps/api's `GET /threads` ignores query params, so
 * the search box filters the already-loaded list here. Matches the raw
 * `thread_name` ONLY (case-insensitive): the list endpoint returns no message
 * text, so answer content is impossible to search client-side (documented in the
 * README so nobody files "search doesn't find message text" as a bug).
 *
 * Filtering over the raw `thread_name` — NOT the mapped display title — is
 * deliberate: an unnamed thread (`thread_name: null`) maps to "New conversation",
 * and matching that would make every unnamed thread surface for the query "new".
 * A null/absent name matches nothing here and never throws. An empty/whitespace
 * query returns the list unchanged (clearing the box restores everything).
 */
export function filterThreadsByName(
  threads: WireThread[],
  q?: string,
): WireThread[] {
  const needle = q?.trim().toLowerCase();
  if (!needle) return threads;
  return threads.filter((t) =>
    (t.thread_name ?? '').toLowerCase().includes(needle),
  );
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
  documents: WireDocument[] = [],
): Message | null {
  const role = mapRole(msg.role);
  if (!role) return null;
  const text = flattenContent(msg.content);
  const { content, citations } =
    role === 'assistant' && documents.length > 0
      ? resolveCitations(text, documents, msg.id)
      : { content: text, citations: [] };
  return {
    id: msg.id,
    conversationId,
    role,
    content,
    citations,
    safety: null, // null by design — apps/api emits no safety signal
    createdAt: msg.created_at ?? '',
  };
}

/**
 * A thread counts as "about khushu'" when its first user message mentions it
 * (khushu' / khushoo / khushū). Only then do we attach the sample citations, and
 * only to the FIRST assistant answer — the one those sources support, and only
 * when it has no real documents of its own. Follow-ups on unrelated topics must
 * not inherit unrelated Islamic source attributions.
 */
function isKhushuThread(messages: Message[]): boolean {
  const firstUser = messages.find((m) => m.role === 'user');
  if (!firstUser) return false;
  return /khush/i.test(firstUser.content);
}

/**
 * Attach `/documents` entries to thread GET's messages. Keyed by message id, and
 * an entry is used ONLY when its `message_index` (a position in the RAW
 * `messages` array, `tool` rows included) points at that same id, on an
 * assistant message. Anything else — the thread changed between the two
 * requests, an ordering drift, an entry for a user row — attaches nothing:
 * sources on the wrong answer would be worse than none. Logged by id and
 * reason only, never content.
 */
export function joinThreadDocuments(
  detail: WireThreadDetail,
  docs: WireThreadDocuments,
): Map<string, WireDocument[]> {
  const byId = new Map<string, WireDocument[]>();
  for (const entry of docs.messages) {
    const target = detail.messages[entry.message_index];
    const reason =
      target === undefined || target.id !== entry.message_id
        ? 'index_mismatch'
        : target.role !== 'assistant'
          ? 'not_assistant'
          : byId.has(entry.message_id)
            ? 'duplicate'
            : null;
    if (reason) {
      console.warn('Thread documents entry not attached:', {
        messageId: entry.message_id,
        reason,
      });
      continue;
    }
    byId.set(entry.message_id, entry.documents);
  }
  return byId;
}

export function mapConversationDetail(
  detail: WireThreadDetail,
  documentsByMessageId: ReadonlyMap<string, WireDocument[]> = new Map(),
): ConversationDetail {
  const id = detail.thread_id;
  const mapped = detail.messages
    .map((m) => mapMessage(m, id, documentsByMessageId.get(m.id)))
    .filter((m): m is Message => m !== null);
  const firstAnswer = mapped.find((m) => m.role === 'assistant');
  const withSamples =
    isKhushuThread(mapped) && firstAnswer && firstAnswer.citations.length === 0
      ? mapped.map((m) =>
          m === firstAnswer
            ? { ...m, content: SAMPLE_ANSWER_CONTENT, citations: SAMPLE_CITATIONS }
            : m,
        )
      : mapped;
  // An answer with nothing behind its markers is shown without them (see
  // lib/citations.ts). Answers with real documents were already resolved in
  // mapMessage, and the khushu' sample keeps its hand-matched `[N]`s.
  const messages = withSamples.map((m) =>
    m.role === 'assistant' && m.citations.length === 0
      ? { ...m, content: stripUnbackedCitations(m.content) }
      : m,
  );
  return {
    id,
    title: detail.thread_name?.trim() || UNTITLED,
    createdAt: detail.created_at ?? '',
    updatedAt: detail.updated_at ?? detail.created_at ?? '',
    messages,
  };
}
