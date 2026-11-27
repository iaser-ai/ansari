import { NextRequest } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { z } from 'zod';
import { createErrorResponse } from '@/lib/error-response';
import { requireUser } from '@/lib/auth/require-user';
import { createMessage, findMessagesByThread, persistOrphanToolCalls, getOrCreateThread } from '@/lib/db/threads';
import { getClientId } from '@/lib/attribution';
import { runFacilitator, type Message } from '@/lib/facilitator/agent';
import {
  assessHistory,
  HISTORY_BLOCK_MESSAGE,
  HISTORY_MESSAGE_TOO_LONG_MESSAGE,
  HISTORY_WARNING_MESSAGE,
  incomingMessageTooLong,
} from '@/lib/facilitator/history-limit';
import { toolCallsOrNull, type ContentBlock } from '@/db/schema/messages';

const chatCompleteSchema = z.object({
  message: z.string().min(1, 'Message is required'),
  expiryHours: z.number().min(0).max(24).optional().default(3),
});

const whatsappResponseSchema = z.object({
  messages: z.array(z.string().min(1)).min(1),
});

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

    // Per-client attribution
    const client = getClientId(request);

    // Get or create thread based on user-configurable expiry
    const thread = await getOrCreateThread(user.id, 'whatsapp', expiryHours);
    const threadId = thread.id;

    // A message over the block threshold on its own is answered at once and NOT stored
    // (issue #400): stored, it would block this thread for good.
    if (incomingMessageTooLong(message, threadId)) {
      return Response.json({ messages: [HISTORY_MESSAGE_TOO_LONG_MESSAGE] });
    }

    // Store user message (createMessage also updates thread's updatedAt)
    const userContent: ContentBlock[] = [{ type: 'text', text: message }];
    await createMessage({
      threadId,
      role: 'user',
      content: userContent,
      source: 'whatsapp',
      client,
    });

    // Load message history
    const dbMessages = await findMessagesByThread(threadId);
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
      await createMessage({
        threadId,
        role: 'assistant',
        content: [{ type: 'text', text: HISTORY_BLOCK_MESSAGE }],
        source: 'whatsapp',
        client,
      });
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
              return createErrorResponse('The model returned an empty answer. Please try again.', 500);
            }

            // Parse and validate the model response before adding it to thread history.
            // Keep accepting code fences for compatibility with older model responses.
            let cleanedText: string;
            let parsedResponse: unknown;
            try {
              cleanedText = fullText.trim();
              if (cleanedText.startsWith('```json')) {
                cleanedText = cleanedText.substring(7); // Remove ```json
              } else if (cleanedText.startsWith('```')) {
                cleanedText = cleanedText.substring(3); // Remove ```
              }
              if (cleanedText.endsWith('```')) {
                cleanedText = cleanedText.substring(0, cleanedText.length - 3);
              }
              cleanedText = cleanedText.trim();

              parsedResponse = JSON.parse(cleanedText);
            } catch (parseError) {
              const e = parseError as { name?: string; message?: string };
              console.error('[chat-complete] failed to parse WhatsApp response', {
                name: e?.name,
                message: e?.message,
              });
              Sentry.captureException(parseError);
              return createErrorResponse('Failed to parse AI model response', 500);
            }

            const validation = whatsappResponseSchema.safeParse(parsedResponse);
            if (!validation.success) {
              console.error('[chat-complete] invalid response format', {
                issueCount: validation.error.issues.length,
              });
              Sentry.captureMessage('chat-complete invalid response format', { level: 'error' });
              return createErrorResponse('Invalid response format from AI model', 500);
            }

            // A warn-level answer stores the warning ahead of the validated response, as the
            // thread route does. Persistence still precedes the HTTP return, not Meta delivery.
            const storedText = history.verdict === 'warn' ? `${HISTORY_WARNING_MESSAGE}\n\n${fullText}` : fullText;
            await createMessage({
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
            });

            // On a warn-level thread the notice leads the answer as its own message.
            const answer: string[] =
              history.verdict === 'warn'
                ? [HISTORY_WARNING_MESSAGE, ...validation.data.messages]
                : validation.data.messages;
            return Response.json({ messages: answer });

          case 'error':
            console.error('[chat-complete] facilitator error:', event.data);
            Sentry.captureMessage('chat-complete facilitator error', {
              level: 'error',
              extra: { error: event.data },
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
      console.error('[chat-complete] stream error:', error);
      Sentry.captureException(error);
      return createErrorResponse('Failed to process chat message', 500);
    }

    // If we get here, something went wrong
    return createErrorResponse('Unexpected end of stream', 500);
  } catch (error) {
    console.error('[chat-complete] error:', error);
    Sentry.captureException(error);
    return createErrorResponse('Failed to process chat message', 500);
  }
}