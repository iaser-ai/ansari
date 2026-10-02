/**
 * The UI-facing types the screens and components already consume. They are the
 * single source of truth from the vendored client's generated schemas, re-exported
 * here so the adapter and the UI agree on one set of shapes. The adapter's job is
 * to MAP apps/api wire shapes (see `wire-schemas.ts`) onto these.
 */
export type {
  HealthStatus,
  Conversation,
  MessageRole,
  CitationSourceType,
  SafetySignal,
  SafetySignalLevel,
  SafetyResource,
  CreateConversationRequest,
  SuggestedTopic,
  ListConversationsParams,
} from '@/vendor/api-client-react/generated/api.schemas';

import type {
  Citation as GeneratedCitation,
  ConversationDetail as GeneratedConversationDetail,
  Message as GeneratedMessage,
  MessageExchange as GeneratedMessageExchange,
  SendMessageRequest as GeneratedSendMessageRequest,
} from '@/vendor/api-client-react/generated/api.schemas';

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

/**
 * An image attached to a question (spec 211). Images are never stored by
 * apps/api, so a persisted message only says one was there (`mediaType`). A
 * question asked in this session also carries the picked image's local `uri`,
 * which is what lets its own bubble show a thumbnail until the screen is left.
 */
export interface Attachment {
  mediaType: string;
  uri?: string;
}

/** The generated message, plus the images a question carried (spec 211). */
export interface Message extends GeneratedMessage {
  attachments?: Attachment[];
}

export interface ConversationDetail extends Omit<GeneratedConversationDetail, 'messages'> {
  messages: Message[];
}

export interface MessageExchange extends GeneratedMessageExchange {
  userMessage: Message;
  assistantMessage: Message;
}

/** One image as `POST /threads/{id}/chat` takes it (spec 211). */
export interface ImageInput {
  media_type: 'image/png' | 'image/jpeg' | 'image/webp';
  /** Base64, no `data:` prefix. */
  data: string;
}

/**
 * A question to send. `content` may be empty when `images` is not — the
 * generated `@minLength 1` predates attachments.
 */
export interface SendMessageRequest extends GeneratedSendMessageRequest {
  images?: ImageInput[];
}
