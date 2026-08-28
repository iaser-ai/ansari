import {
  healthSchema,
  threadDetailSchema,
  threadListSchema,
  threadSchema,
} from '@/lib/api/wire-schemas';
import {
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

export function decodeConversationList(raw: unknown): Conversation[] {
  return mapConversationList(threadListSchema.parse(raw));
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
