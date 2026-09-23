import { NextRequest } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { z } from 'zod';
import { authenticateRequest, createErrorResponse } from '@/lib/auth/middleware';
import { findThreadById, createMessage, findMessagesByThread, persistOrphanToolCalls } from '@/lib/db/threads';
import { getClientId } from '@/lib/attribution';
import { maybeGenerateThreadName } from '@/lib/ai/thread-naming';
import { runFacilitator, type Message } from '@/lib/facilitator/agent';
import { startHeartbeat, SSE_HEARTBEAT } from '@/lib/streaming/heartbeat';
import { toolCallsOrNull, type ContentBlock } from '@/db/schema/messages';

type RouteContext = {
  params: Promise<{ id: string }>;
};

const chatSchema = z.object({
  message: z.string().min(1, 'Message is required'),
});

// POST /api/v2/threads/[id]/chat - Send a message and get streaming response
export async function POST(request: NextRequest, context: RouteContext) {
  try {
    const authResult = await authenticateRequest(request);
    if ('error' in authResult) {
      return authResult.error;
    }

    const { user } = authResult;
    const { id: threadId } = await context.params;

    // Verify thread exists and belongs to user
    const thread = await findThreadById(threadId, user.id);
    if (!thread) {
      return createErrorResponse('Thread not found', 404);
    }

    // Parse request body
    const body = await request.json();
    const parseResult = chatSchema.safeParse(body);
    if (!parseResult.success) {
      const errors = parseResult.error.issues.map((i) => i.message);
      return createErrorResponse(errors.join(', '), 422);
    }

    const { message } = parseResult.data;

    // Per-client attribution (spec 56). Capture before the stream — the
    // assistant message is written inside the async stream closure.
    const client = getClientId(request);

    // Store user message
    const userContent: ContentBlock[] = [{ type: 'text', text: message }];
    await createMessage({
      threadId,
      role: 'user',
      content: userContent,
      source: 'web',
      client,
    });

    // Auto-name thread on first message (fire-and-forget)
    void maybeGenerateThreadName(threadId, user.id, message);

    // Load message history. rawPayload rides along so the facilitator replays the
    // real model turn — tool history and thought signatures — on turn 2+ (issue #70).
    const dbMessages = await findMessagesByThread(threadId);
    const messageHistory: Message[] = dbMessages.map((m) => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
      rawPayload: m.rawPayload ?? null,
    }));

    // Create SSE stream
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        let fullText = '';
        const assistantContent: ContentBlock[] = [];
        let isClosed = false;

        const safeEnqueue = (data: Uint8Array) => {
          if (!isClosed) {
            try {
              controller.enqueue(data);
            } catch {
              isClosed = true;
            }
          }
        };

        const safeClose = () => {
          if (!isClosed) {
            isClosed = true;
            try {
              controller.close();
            } catch {
              // Already closed
            }
          }
        };

        const heartbeat = startHeartbeat(() => safeEnqueue(encoder.encode(SSE_HEARTBEAT)));

        try {
          for await (const event of runFacilitator(messageHistory)) {
            heartbeat.touch();
            switch (event.type) {
              case 'text':
                fullText += event.data;
                safeEnqueue(
                  encoder.encode(`data: ${JSON.stringify({ type: 'text', content: event.data })}\n\n`)
                );
                break;

              case 'tool_use':
                safeEnqueue(
                  encoder.encode(`data: ${JSON.stringify({ type: 'tool_call', ...JSON.parse(event.data) })}\n\n`)
                );
                break;

              case 'tool_result':
                safeEnqueue(
                  encoder.encode(`data: ${JSON.stringify({ type: 'tool_result', ...JSON.parse(event.data) })}\n\n`)
                );
                break;

              case 'done':
                if (fullText.trim().length === 0) {
                  console.error('[chat] empty facilitator answer', { threadId });
                  Sentry.captureMessage('chat empty answer', { level: 'error', extra: { threadId } });
                  safeEnqueue(
                    encoder.encode(
                      `data: ${JSON.stringify({ type: 'error', message: 'The model returned an empty answer. Please try again.' })}\n\n`
                    )
                  );
                  safeClose();
                  // No assistant row for an empty final — the turn's tool records go to
                  // the orphan table (spec 73), after the client is closed out.
                  await persistOrphanToolCalls({
                    threadId,
                    reason: 'empty_final',
                    source: 'web',
                    client,
                    toolCalls: event.toolCalls,
                    provenance: event.provenance,
                  });
                  break;
                }
                if (fullText) {
                  assistantContent.push({ type: 'text', text: fullText });
                }
                if (assistantContent.length > 0) {
                  await createMessage({
                    threadId,
                    role: 'assistant',
                    content: assistantContent,
                    agentName: 'facilitator',
                    source: 'web',
                    client,
                    inputTokens: event.usage?.promptTokenCount ?? null,
                    outputTokens: event.usage?.candidatesTokenCount ?? null,
                    thinkingTokens: event.usage?.thoughtsTokenCount ?? null,
                    totalTokens: event.usage?.totalTokenCount ?? null,
                    // Final model turn for turn-2+ history replay (issue #70).
                    rawPayload: event.rawPayload ?? null,
                    // Tool dispatch records (spec 73); NULL, never [], when no tool ran.
                    toolCalls: toolCallsOrNull(event.toolCalls),
                    // Per-turn model provenance (issue #99); NULL, never '', when absent.
                    modelProvider: event.provenance?.provider ?? null,
                    modelId: event.provenance?.modelId ?? null,
                  });
                }

                safeEnqueue(
                  encoder.encode(`data: ${JSON.stringify({ type: 'done' })}\n\n`)
                );
                safeClose();
                break;

              case 'error':
                safeEnqueue(
                  encoder.encode(`data: ${JSON.stringify({ type: 'error', message: event.data })}\n\n`)
                );
                safeClose();
                // Tool records from a failed turn (spec 73) — after the client is closed out.
                await persistOrphanToolCalls({
                  threadId,
                  reason: 'error',
                  source: 'web',
                  client,
                  toolCalls: event.toolCalls,
                  provenance: event.provenance,
                });
                break;
            }
          }
        } catch (error) {
          console.error('Stream error:', error);
          Sentry.captureException(error);
          safeEnqueue(
            encoder.encode(
              `data: ${JSON.stringify({
                type: 'error',
                message: error instanceof Error ? error.message : 'Unknown error',
              })}\n\n`
            )
          );
          safeClose();
        } finally {
          heartbeat.stop();
        }
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    });
  } catch (error) {
    console.error('Chat error:', error);
    Sentry.captureException(error);
    return createErrorResponse('Failed to process chat message', 500);
  }
}
