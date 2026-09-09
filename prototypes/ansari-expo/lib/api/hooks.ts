import {
  useMutation,
  useQuery,
  type QueryKey,
  type UseMutationOptions,
  type UseMutationResult,
  type UseQueryOptions,
  type UseQueryResult,
} from '@tanstack/react-query';
import { apiFetch } from '@/lib/api/http';
import { streamChat, type ChatStreamEvent } from '@/lib/api/streaming';
import { resolveBaseUrl } from '@/lib/api/config';
import {
  decodeConversation,
  decodeConversationDetail,
  decodeConversationList,
  decodeDeleteResult,
  decodeHealth,
} from '@/lib/api/decode';
import { SUGGESTED_TOPICS } from '@/lib/suggested-topics';
import type {
  Conversation,
  ConversationDetail,
  CreateConversationRequest,
  HealthStatus,
  ListConversationsParams,
  MessageExchange,
  SendMessageRequest,
  SuggestedTopic,
} from '@/lib/api/types';

/**
 * Drop-in replacements for the vendored orval hooks, backed by this repo's
 * `apps/api`. Same hook names, query-key helpers, and consumed types as
 * `@/vendor/api-client-react`, so the screens only need to change their import
 * specifier. Every response is zod-validated in the fetchers below (see
 * `wire-schemas.ts`); a shape mismatch throws and react-query surfaces `isError`.
 */

type QueryHookOptions<TData> = {
  query?: Partial<UseQueryOptions<TData, Error, TData, QueryKey>>;
};
type MutationHookOptions<TData, TVariables> = {
  mutation?: UseMutationOptions<TData, Error, TVariables>;
};

// --- Query keys ------------------------------------------------------------

export const getListConversationsQueryKey = (
  params?: ListConversationsParams,
): QueryKey => (params?.q ? ['conversations', { q: params.q }] : ['conversations']);

export const getGetConversationQueryKey = (conversationId: string): QueryKey => [
  'conversation',
  conversationId,
];

export const getListSuggestedQuestionsQueryKey = (): QueryKey => [
  'suggested-questions',
];

export const getHealthCheckQueryKey = (): QueryKey => ['health'];

// --- Conversations (threads) ----------------------------------------------

async function fetchConversations(
  params?: ListConversationsParams,
): Promise<Conversation[]> {
  const raw = await apiFetch<unknown>('/api/v2/threads');
  // apps/api ignores query params, so `decodeConversationList` applies the
  // client-side title-only search (over raw `thread_name`) after validating.
  return decodeConversationList(raw, params?.q);
}

export function useListConversations(
  params?: ListConversationsParams,
  options?: QueryHookOptions<Conversation[]>,
): UseQueryResult<Conversation[], Error> {
  return useQuery({
    queryKey: getListConversationsQueryKey(params),
    queryFn: () => fetchConversations(params),
    ...options?.query,
  });
}

async function fetchConversation(
  conversationId: string,
): Promise<ConversationDetail> {
  const raw = await apiFetch<unknown>(
    `/api/v2/threads/${encodeURIComponent(conversationId)}`,
  );
  return decodeConversationDetail(raw);
}

export function useGetConversation(
  conversationId: string,
  options?: QueryHookOptions<ConversationDetail>,
): UseQueryResult<ConversationDetail, Error> {
  return useQuery({
    queryKey: getGetConversationQueryKey(conversationId),
    queryFn: () => fetchConversation(conversationId),
    ...options?.query,
  });
}

type CreateConversationVariables = { data: CreateConversationRequest };

export function useCreateConversation(
  options?: MutationHookOptions<Conversation, CreateConversationVariables>,
): UseMutationResult<Conversation, Error, CreateConversationVariables> {
  return useMutation({
    mutationFn: async ({ data }) => {
      const raw = await apiFetch<unknown>('/api/v2/threads', {
        method: 'POST',
        body: JSON.stringify({ name: data.title }),
      });
      return decodeConversation(raw);
    },
    ...options?.mutation,
  });
}

type DeleteConversationVariables = { conversationId: string };

export function useDeleteConversation(
  options?: MutationHookOptions<void, DeleteConversationVariables>,
): UseMutationResult<void, Error, DeleteConversationVariables> {
  return useMutation({
    mutationFn: async ({ conversationId }) => {
      const raw = await apiFetch<unknown>(
        `/api/v2/threads/${encodeURIComponent(conversationId)}`,
        { method: 'DELETE' },
      );
      decodeDeleteResult(raw); // throws on a non-`{ message }` shape
    },
    ...options?.mutation,
  });
}

// --- Send message (SSE chat) ----------------------------------------------

type SendMessageVariables = {
  conversationId: string;
  data: SendMessageRequest;
};

type SendMessageOptions = MutationHookOptions<MessageExchange, SendMessageVariables> & {
  /**
   * Called for every SSE event as it arrives (`text` deltas, `tool_call` /
   * `tool_result`, `error`, `done`), so the screen can render the answer
   * incrementally and show a live retrieval trace. This is the progress seam:
   * the mutation still resolves only on `done` and its `MessageExchange` return
   * is still ignored by the screen (it re-reads the persisted thread), but the
   * partial answer no longer waits behind a blocking spinner.
   */
  onEvent?: (event: ChatStreamEvent) => void;
};

export function useSendMessage(
  options?: SendMessageOptions,
): UseMutationResult<MessageExchange, Error, SendMessageVariables> {
  return useMutation({
    mutationFn: async ({ conversationId, data }) => {
      const answer = await streamChat({
        baseUrl: resolveBaseUrl(),
        threadId: conversationId,
        message: data.content,
        onEvent: options?.onEvent,
      });
      // The chat screen ignores this return value (it invalidates the detail
      // query and re-reads the persisted thread), but the type contract is
      // MessageExchange, so synthesise one from what we streamed.
      const now = new Date().toISOString();
      return {
        userMessage: {
          id: `local-user-${now}`,
          conversationId,
          role: 'user',
          content: data.content,
          citations: [],
          safety: null,
          createdAt: now,
        },
        assistantMessage: {
          id: `local-assistant-${now}`,
          conversationId,
          role: 'assistant',
          content: answer,
          citations: [],
          safety: null,
          createdAt: now,
        },
      } satisfies MessageExchange;
    },
    ...options?.mutation,
  });
}

// --- Suggested questions (static) -----------------------------------------

export function useListSuggestedQuestions(
  options?: QueryHookOptions<SuggestedTopic[]>,
): UseQueryResult<SuggestedTopic[], Error> {
  return useQuery({
    queryKey: getListSuggestedQuestionsQueryKey(),
    queryFn: async () => SUGGESTED_TOPICS,
    staleTime: Infinity,
    ...options?.query,
  });
}

// --- Health ----------------------------------------------------------------

export async function healthCheck(): Promise<HealthStatus> {
  const raw = await apiFetch<unknown>('/api/health');
  return decodeHealth(raw);
}

export function useHealthCheck(
  options?: QueryHookOptions<HealthStatus>,
): UseQueryResult<HealthStatus, Error> {
  return useQuery({
    queryKey: getHealthCheckQueryKey(),
    queryFn: healthCheck,
    ...options?.query,
  });
}
