import {
  healthSchema,
  messageResponseSchema,
  threadDetailSchema,
  threadListSchema,
  threadSchema,
} from '@/lib/api/wire-schemas';
import {
  filterThreadsByName,
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

export function decodeConversationDetail(raw: unknown): ConversationDetail {
  return mapConversationDetail(threadDetailSchema.parse(raw));
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
