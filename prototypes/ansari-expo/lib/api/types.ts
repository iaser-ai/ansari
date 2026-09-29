/**
 * The UI-facing types the screens and components already consume. They are the
 * single source of truth from the vendored client's generated schemas, re-exported
 * here so the adapter and the UI agree on one set of shapes. The adapter's job is
 * to MAP apps/api wire shapes (see `wire-schemas.ts`) onto these.
 */
export type {
  HealthStatus,
  Conversation,
  ConversationDetail,
  Message,
  MessageRole,
  CitationSourceType,
  SafetySignal,
  SafetySignalLevel,
  SafetyResource,
  CreateConversationRequest,
  SendMessageRequest,
  MessageExchange,
  SuggestedTopic,
  ListConversationsParams,
} from '@/vendor/api-client-react/generated/api.schemas';

import type { Citation as GeneratedCitation } from '@/vendor/api-client-react/generated/api.schemas';

/**
 * The generated shape, plus what the prototype derives on its own side.
 * The vendored client is reference-only, so additions live here.
 */
export interface Citation extends GeneratedCitation {
  /** A hadith's first (or only) grade, for the pill (issue #194). */
  grade?: string;
  /**
   * Every grade a hadith carries, one entry per grader, empties dropped —
   * present only when there is more than one (issue #194). The pill shows
   * the first and a count; the folio lists them all.
   */
  grades?: string[];
}
