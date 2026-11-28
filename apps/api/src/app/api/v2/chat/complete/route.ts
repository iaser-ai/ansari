import { NextRequest } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { z } from 'zod';
import { createErrorResponse } from '@/lib/error-response';
import { requireUser } from '@/lib/auth/require-user';
import {
  createMessageIfThreadExists,
  getOrCreateThreadWithUserMessage,
  persistOrphanToolCalls,
} from '@/lib/db/threads';
import { getClientId } from '@/lib/attribution';
import { runFacilitator, type Message } from '@/lib/facilitator/agent';
import {
  assessHistory,
  HISTORY_BLOCK_MESSAGE,
  HISTORY_MESSAGE_TOO_LONG_MESSAGE,
  HISTORY_WARNING_MESSAGE,
  incomingMessageTooLong,
} from '@/lib/facilitator/history-limit';
import { toolCallsOrNull } from '@/db/schema/messages';

const chatCompleteSchema = z.object({
  message: z.string().min(1, 'Message is required'),
  expiryHours: z.number().int().min(0).max(24).optional().default(3),
});

const MAX_WHATSAPP_MESSAGES = 10;

const whatsappResponseSchema = z.object({
  messages: z.array(z.string().min(1)).min(1).max(MAX_WHATSAPP_MESSAGES),
});

function errorSummary(error: unknown): { name: string; code?: string | number } {
  if (typeof error !== 'object' || error === null) return { name: typeof error };
  const value = error as { name?: unknown; code?: unknown };
  return {
    name: typeof value.name === 'string' ? value.name : 'Error',
    ...(typeof value.code === 'string' || typeof value.code === 'number' ? { code: value.code } : {}),
  };
}

function logError(message: string, error: unknown): void {
  if (process.env.NODE_ENV === 'development') {
    console.error(message, error);
    return;
  }
  console.error(message, errorSummary(error));
}

function stripJsonFence(text: string): string {
  let cleaned = text.trim();
  if (cleaned.startsWith('```json')) cleaned = cleaned.substring(7);
  else if (cleaned.startsWith('```')) cleaned = cleaned.substring(3);
  if (cleaned.trimEnd().endsWith('```')) cleaned = cleaned.trimEnd().slice(0, -3);
  return cleaned.trim();
}

// POST /api/v2/chat/complete - Non-streaming endpoint for WhatsApp
export async function POST(request: NextRequest) {
  try {
    const authResult = await requireUser(request);
    if ('error' in authResult) {
      return authResult.error;
    }

    const { user } = authResult;

    // Parse request body
    const body = await request.json();
    const parseResult = chatCompleteSchema.safeParse(body);
    if (!parseResult.success) {
      const errors = parseResult.error.issues.map((i) => i.message);
      return createErrorResponse(errors.join(', '), 422);
    }

    const { message, expiryHours } = parseResult.data;

    // Refuse a single huge paste before creating or replacing any thread.
    if (incomingMessageTooLong(message)) {
      return Response.json({ messages: [HISTORY_MESSAGE_TOO_LONG_MESSAGE] });
    }

    // Per-client attribution
    const client = getClientId(request);

    // Select the thread and store the inbound message atomically under a per-user lock.
    const { thread, history: dbMessages } = await getOrCreateThreadWithUserMessage(user.id, 'whatsapp', expiryHours, {
      role: 'user',
      content: [{ type: 'text', text: message }],
      source: 'whatsapp',
      client,
    });
    const threadId = thread.id;

    const messageHistory: Message[] = dbMessages.map((m) => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
      rawPayload: m.rawPayload ?? null,
    }));

    // Thread history limit (issue #400). A blocked thread gets the notice as its answer,
    // without a model call; the notice is stored, as the thread route stores its own.
    const history = assessHistory(messageHistory);
    if (history.verdict === 'block') {
      console.warn('[chat-complete] thread history over block threshold', {
        threadId,
        estimatedTokens: history.estimatedTokens,
      });
      await createMessageIfThreadExists({
        threadId,
        role: 'assistant',
        content: [{ type: 'text', text: HISTORY_BLOCK_MESSAGE }],
        source: 'whatsapp',
        client,
      }, user.id);
      return Response.json({ messages: [HISTORY_BLOCK_MESSAGE] });
    }

    // Run facilitator with WhatsApp-specific prompt
    let fullText = '';

    try {
      for await (const event of runFacilitator(messageHistory, undefined, { source: 'whatsapp' })) {
        switch (event.type) {
          case 'text':
            fullText += event.data;
            break;

          case 'tool_use':
            // Tool calls are handled internally by the facilitator
            // and included in the 'done' event
            break;

          case 'tool_result':
            // Tool results are handled internally by the facilitator
            break;

          case 'done':
            if (fullText.trim().length === 0) {
              console.error('[chat-complete] empty facilitator answer');
              Sentry.captureMessage('chat-complete empty answer', { level: 'error' });
              await persistOrphanToolCalls({
                threadId,
                reason: 'empty_final',
                source: 'whatsapp',
                client,
                toolCalls: event.toolCalls,
                provenance: event.provenance,
              });
              return createErrorResponse('The model returned an empty answer. Please try again.', 500);
            }

            let parsedResponse: unknown;
            try {
              parsedResponse = JSON.parse(stripJsonFence(fullText));
            } catch (parseError) {
              if (event.provenance?.provider === 'inkling') {
                parsedResponse = { messages: [fullText.trim()] };
              } else {
                logError('[chat-complete] failed to parse WhatsApp response', parseError);
                Sentry.captureMessage('chat-complete failed to parse WhatsApp response', {
                  level: 'error',
                  extra: errorSummary(parseError),
                });
                await persistOrphanToolCalls({
                  threadId,
                  reason: 'empty_final',
                  source: 'whatsapp',
                  client,
                  toolCalls: event.toolCalls,
                  provenance: event.provenance,
                });
                return createErrorResponse('Failed to parse AI model response', 500);
              }
            }

            const validation = whatsappResponseSchema.safeParse(parsedResponse);
            if (!validation.success) {
              console.error('[chat-complete] invalid response format', {
                issueCount: validation.error.issues.length,
              });
              Sentry.captureMessage('chat-complete invalid response format', { level: 'error' });
              if (event.provenance?.provider === 'inkling' && fullText.trim()) {
                parsedResponse = { messages: [fullText.trim()] };
              } else {
                await persistOrphanToolCalls({
                  threadId,
                  reason: 'empty_final',
                  source: 'whatsapp',
                  client,
                  toolCalls: event.toolCalls,
                  provenance: event.provenance,
                });
                return createErrorResponse('Invalid response format from AI model', 500);
              }
            }

            const finalValidation = whatsappResponseSchema.safeParse(parsedResponse);
            if (!finalValidation.success) {
              return createErrorResponse('Invalid response format from AI model', 500);
            }

            const answer: string[] =
              history.verdict === 'warn'
                ? [HISTORY_WARNING_MESSAGE, ...finalValidation.data.messages]
                : finalValidation.data.messages;
            const storedText = answer.join('\n\n');
            await createMessageIfThreadExists({
              threadId,
              role: 'assistant',
              content: [{ type: 'text', text: storedText }],
              agentName: 'facilitator',
              source: 'whatsapp',
              client,
              inputTokens: event.usage?.promptTokenCount ?? null,
              outputTokens: event.usage?.candidatesTokenCount ?? null,
              thinkingTokens: event.usage?.thoughtsTokenCount ?? null,
              totalTokens: event.usage?.totalTokenCount ?? null,
              rawPayload: event.rawPayload ?? null,
              toolCalls: toolCallsOrNull(event.toolCalls),
              modelProvider: event.provenance?.provider ?? null,
              modelId: event.provenance?.modelId ?? null,
            }, user.id);

            return Response.json({ messages: answer });

          case 'error':
            logError('[chat-complete] facilitator error', new Error(event.data));
            Sentry.captureMessage('chat-complete facilitator error', {
              level: 'error',
              extra: { name: 'FacilitatorError' },
            });

            // Persist orphan tool calls on error
            await persistOrphanToolCalls({
              threadId,
              reason: 'error',
              source: 'whatsapp',
              client,
              toolCalls: event.toolCalls,
              provenance: event.provenance,
            });

            return createErrorResponse(event.data || 'An error occurred while processing your message', 500);
        }
      }
    } catch (error) {
      logError('[chat-complete] stream error', error);
      Sentry.captureMessage('chat-complete stream error', { level: 'error', extra: errorSummary(error) });
      return createErrorResponse('Failed to process chat message', 500);
    }

    // If we get here, something went wrong
    return createErrorResponse('Unexpected end of stream', 500);
  } catch (error) {
    logError('[chat-complete] error', error);
    Sentry.captureMessage('chat-complete request error', { level: 'error', extra: errorSummary(error) });
    return createErrorResponse('Failed to process chat message', 500);
  }
}