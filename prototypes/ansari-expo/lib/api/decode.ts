import {
  healthSchema,
  messageResponseSchema,
  threadDetailSchema,
  threadDocumentsSchema,
  threadListSchema,
  threadSchema,
} from '@/lib/api/wire-schemas';
import {
  filterThreadsByName,
  joinThreadDocuments,
  mapConversation,
  mapConversationDetail,
  mapConversationList,
} from '@/lib/api/mappers';
import type {
  Conversation,
  ConversationDetail,
  HealthStatus,
} from '@/lib/api/types';

/**
 * The pure validate-then-map pipeline each adapter fetcher runs on a raw
 * response. Kept RN-free and side-effect-free so it can be unit-tested directly:
 * these functions ARE the queryFn/mutationFn body minus the network call, so a
 * test that feeds them the old Replit shapes and asserts they throw is exactly
 * the loud-failure gate react-query relies on (a throwing queryFn ⇒ `isError`).
 */

export function decodeConversationList(
  raw: unknown,
  q?: string,
): Conversation[] {
  // Validate the raw list first (loud failure on shape mismatch), then apply the
  // client-side title-only search over raw `thread_name` BEFORE mapping — so an
  // unnamed thread (null name) is filtered by its real name, not the "New
  // conversation" placeholder the mapper would give it.
  const threads = filterThreadsByName(threadListSchema.parse(raw), q);
  return mapConversationList(threads);
}

export function decodeConversation(raw: unknown): Conversation {
  return mapConversation(threadSchema.parse(raw));
}

/**
 * A thread plus, when available, its `/documents` response (spec 168).
 *
 * The thread keeps the loud-failure gate: a wrong shape throws. The documents
 * do NOT — they are an enhancement, and a sources problem must never make a
 * conversation unreadable (#165: a documents fault once took every thread GET
 * down on staging). `rawDocuments` is `undefined` when the request failed (see
 * `fetchConversation`); a body that fails its schema is logged as an error —
 * the wrong-backend signal — and the thread renders without sources, exactly
 * as an answer with no documents does.
 */
export function decodeConversationDetail(
  raw: unknown,
  rawDocuments?: unknown,
): ConversationDetail {
  const detail = threadDetailSchema.parse(raw);
  if (rawDocuments === undefined) return mapConversationDetail(detail);
  const docs = threadDocumentsSchema.safeParse(rawDocuments);
  if (!docs.success) {
    console.error('Thread documents response did not match its schema:', {
      issues: docs.error.issues.map((i) => ({ path: i.path.join('.'), code: i.code })),
    });
    return mapConversationDetail(detail);
  }
  return mapConversationDetail(detail, joinThreadDocuments(detail, docs.data));
}

/**
 * The thread and its source documents (spec 168), fetched in parallel so an
 * answer, its markers and its source pills arrive together. This is the detail
 * queryFn body with the transport injected (`apiFetch` in the app), so the
 * degrade path is unit-testable. A failed documents request (network, 5xx, or a
 * 404 from an apps/api without spec 168) never fails the conversation: it is
 * logged by status only and the thread renders without sources. The thread
 * request keeps its normal error path.
 */
export async function loadConversationDetail(
  conversationId: string,
  fetchJson: (path: string) => Promise<unknown>,
): Promise<ConversationDetail> {
  const path = `/api/v2/threads/${encodeURIComponent(conversationId)}`;
  const [raw, rawDocuments] = await Promise.all([
    fetchJson(path),
    fetchJson(`${path}/documents`).catch((error: unknown) => {
      console.warn('Thread documents unavailable; showing answers without sources:', {
        status: (error as { status?: number } | null)?.status ?? null,
      });
      return undefined;
    }),
  ]);
  return decodeConversationDetail(raw, rawDocuments);
}

export function decodeHealth(raw: unknown): HealthStatus {
  return { status: healthSchema.parse(raw).status };
}

/**
 * `DELETE /threads/{id}` returns a bare `{ message }`. This is the delete
 * mutationFn body minus the network call: validating the response is the same
 * loud-failure gate the query decoders apply — a wrong-shaped response (e.g. the
 * old Replit API, or an HTML error page decoded to some other object) throws a
 * ZodError, react-query surfaces `isError`, and the list is not wrongly pruned.
 */
export function decodeDeleteResult(raw: unknown): void {
  messageResponseSchema.parse(raw);
}
