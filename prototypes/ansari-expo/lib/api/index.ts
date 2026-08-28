/**
 * The adapter barrel — a drop-in replacement for `@/vendor/api-client-react`,
 * backed by this repo's `apps/api`. Screens/components import hooks, query-key
 * helpers, and types from here; only their import specifier changes.
 *
 * The vendored `custom-fetch.ts` runtime (base URL + bearer attach) is REUSED,
 * so `setBaseUrl` / `setAuthTokenGetter` keep working exactly as before.
 */
export {
  useListConversations,
  useGetConversation,
  useCreateConversation,
  useDeleteConversation,
  useSendMessage,
  useListSuggestedQuestions,
  useHealthCheck,
  healthCheck,
  getListConversationsQueryKey,
  getGetConversationQueryKey,
  getListSuggestedQuestionsQueryKey,
  getHealthCheckQueryKey,
} from '@/lib/api/hooks';

export {
  setBaseUrl,
  setAuthTokenGetter,
  customFetch,
  ApiError,
  type AuthTokenGetter,
} from '@/vendor/api-client-react/custom-fetch';

export * from '@/lib/api/types';
