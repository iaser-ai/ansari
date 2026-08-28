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
  Citation,
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
