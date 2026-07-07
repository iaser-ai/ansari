import { NextRequest } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { z } from 'zod';
import { authenticateRequest, createErrorResponse } from '@/lib/auth/middleware';
import { findThreadById, createMessage, findMessagesByThread } from '@/lib/db/threads';
import { getClientId } from '@/lib/attribution';
import { maybeGenerateThreadName } from '@/lib/ai/thread-naming';
import { runFacilitator, type Message } from '@/lib/facilitator/agent';
import { startHeartbeat, SSE_HEARTBEAT } from '@/lib/streaming/heartbeat';
import type { ContentBlock } from '@/db/schema/messages';

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

    // Load message history
    const dbMessages = await findMessagesByThread(threadId);
    const messageHistory: Message[] = dbMessages.map((m) => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
    }));

    // Create SSE stream
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        let fullText = '';
        const assistantContent: ContentBlock[] = [];

        // SSE comment heartbeat (#59): the facilitator emits nothing during
        // Gemini thinking phases and tool rounds, and Cloudflare drops the
        // proxied connection after ~100s without origin bytes. Comment lines
        // are ignored by SSE parsers, so this is invisible to clients.
        const heartbeat = startHeartbeat(() => controller.enqueue(encoder.encode(SSE_HEARTBEAT)));

        try {
          for await (const event of runFacilitator(messageHistory)) {
            heartbeat.touch();
            switch (event.type) {
              case 'text':
                fullText += event.data;
                // Send SSE event
                controller.enqueue(
                  encoder.encode(`data: ${JSON.stringify({ type: 'text', content: event.data })}\n\n`)
                );
                break;

              case 'tool_use':
                controller.enqueue(
                  encoder.encode(`data: ${JSON.stringify({ type: 'tool_call', ...JSON.parse(event.data) })}\n\n`)
                );
                break;

              case 'tool_result':
                controller.enqueue(
                  encoder.encode(`data: ${JSON.stringify({ type: 'tool_result', ...JSON.parse(event.data) })}\n\n`)
                );
                break;

              case 'done':
                // Backstop (issue #60): an empty final answer must surface as an error,
                // never as a silent done with no stored assistant message.
                if (fullText.trim().length === 0) {
                  console.error('[chat] empty facilitator answer', { threadId });
                  Sentry.captureMessage('chat empty answer', { level: 'error', extra: { threadId } });
                  controller.enqueue(
                    encoder.encode(
                      `data: ${JSON.stringify({ type: 'error', message: 'The model returned an empty answer. Please try again.' })}\n\n`
                    )
                  );
                  controller.close();
                  break;
                }
                // Store the final assistant message
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
                  });
                }

                controller.enqueue(
                  encoder.encode(`data: ${JSON.stringify({ type: 'done' })}\n\n`)
                );
                controller.close();
                break;

              case 'error':
                controller.enqueue(
                  encoder.encode(`data: ${JSON.stringify({ type: 'error', message: event.data })}\n\n`)
                );
                controller.close();
                break;
            }
          }
        } catch (error) {
          console.error('Stream error:', error);
          Sentry.captureException(error);
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({
                type: 'error',
                message: error instanceof Error ? error.message : 'Unknown error',
              })}\n\n`
            )
          );
          controller.close();
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
