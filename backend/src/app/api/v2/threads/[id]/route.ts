import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { z } from 'zod';
import { authenticateRequest, createErrorResponse } from '@/lib/auth/middleware';
import { findThreadById, updateThread, deleteThread, getThreadWithMessages, createMessage, findMessagesByThread } from '@/lib/db/threads';
import { getClientId } from '@/lib/attribution';
import { maybeGenerateThreadName } from '@/lib/ai/thread-naming';
import type { ContentBlock } from '@/db/schema/messages';
import { runFacilitator, type Message } from '@/lib/facilitator/agent';
import {
  startHeartbeat,
  RAW_TEXT_HEARTBEAT,
  RAW_TEXT_HEARTBEAT_INTERVAL_MS,
  RAW_TEXT_HEARTBEAT_INITIAL_DELAY_MS,
} from '@/lib/streaming/heartbeat';

type RouteContext = {
  params: Promise<{ id: string }>;
};

// Format message content for API response
function formatMessageContent(content: ContentBlock[]): string | ContentBlock[] {
  // If there's only one text block, return just the text
  if (content.length === 1 && content[0].type === 'text') {
    return content[0].text;
  }
  // Otherwise return the full array
  return content;
}

// GET /api/v2/threads/[id] - Get thread with messages
export async function GET(request: NextRequest, context: RouteContext) {
  try {
    const authResult = await authenticateRequest(request);
    if ('error' in authResult) {
      return authResult.error;
    }

    const { user } = authResult;
    const { id } = await context.params;

    const result = await getThreadWithMessages(id, user.id);
    if (!result) {
      return createErrorResponse('Thread not found', 404);
    }

    const { thread, messages } = result;

    // Return in Ansari's format (frontend expects thread_name)
    return NextResponse.json({
      thread_id: thread.id,
      thread_name: thread.name,
      source: thread.source,
      created_at: thread.createdAt?.toISOString(),
      updated_at: thread.updatedAt?.toISOString(),
      messages: messages.map((m) => ({
        id: m.id,
        role: m.role,
        content: formatMessageContent(m.content),
        agent_name: m.agentName,
        source: m.source,
        created_at: m.createdAt?.toISOString(),
      })),
    });
  } catch (error) {
    console.error('Get thread error:', error);
    return createErrorResponse('Failed to get thread', 500);
  }
}

const updateThreadSchema = z.object({
  name: z.string().optional(),
});

// PATCH /api/v2/threads/[id] - Update thread (rename)
export async function PATCH(request: NextRequest, context: RouteContext) {
  try {
    const authResult = await authenticateRequest(request);
    if ('error' in authResult) {
      return authResult.error;
    }

    const { user } = authResult;
    const { id } = await context.params;

    const body = await request.json();
    const parseResult = updateThreadSchema.safeParse(body);
    if (!parseResult.success) {
      const errors = parseResult.error.issues.map((i) => i.message);
      return createErrorResponse(errors.join(', '), 422);
    }

    const thread = await updateThread(id, user.id, parseResult.data);
    if (!thread) {
      return createErrorResponse('Thread not found', 404);
    }

    return NextResponse.json({
      id: thread.id,
      name: thread.name,
      source: thread.source,
      created_at: thread.createdAt?.toISOString(),
      updated_at: thread.updatedAt?.toISOString(),
    });
  } catch (error) {
    console.error('Update thread error:', error);
    return createErrorResponse('Failed to update thread', 500);
  }
}

const chatSchema = z.object({
  content: z.string().min(1, 'Content is required'),
  role: z.string().optional(),
});

// POST /api/v2/threads/[id] - Send a message and get streaming response
// (Frontend calls this endpoint, not /threads/[id]/chat)
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

    const { content } = parseResult.data;

    // Per-client attribution (spec 56). Capture the header value BEFORE the
    // stream starts — the assistant message is written inside the async stream
    // closure (seconds later), so we close over `client` here.
    const client = getClientId(request);

    // Store user message
    const userContent: ContentBlock[] = [{ type: 'text', text: content }];
    await createMessage({
      threadId,
      role: 'user',
      content: userContent,
      source: 'web',
      client,
    });

    // Auto-name thread on first message (fire-and-forget)
    void maybeGenerateThreadName(threadId, user.id, content);

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
        let isClosed = false;

        const safeEnqueue = (data: Uint8Array) => {
          if (!isClosed) {
            try {
              controller.enqueue(data);
            } catch {
              // Controller might be closed due to client disconnect
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

        // Pre-first-byte heartbeat (#59): this stream is raw text the client
        // renders verbatim, so the only invisible heartbeat is a leading
        // zero-width space. Cloudflare drops the proxied connection after
        // ~100s without origin bytes, and the silent window lives before the
        // first content byte (thinking + tool rounds) — so heartbeat until
        // the first real text chunk, then stop for good: a ZWSP mid-stream
        // could break ligature joining inside Arabic/Quran text. Heartbeats
        // never touch fullText, so nothing is persisted.
        //
        // The first heartbeat waits 60s (#64): the deployed frontend hides
        // its thinking indicator on the first received byte, so an early
        // ZWSP replaces the indicator with an empty bubble on ordinary
        // turns. Most first tokens arrive well before 60s; longer silences
        // still get bytes flowing with margin under the ~100s edge cutoff.
        const heartbeat = startHeartbeat(
          () => safeEnqueue(encoder.encode(RAW_TEXT_HEARTBEAT)),
          RAW_TEXT_HEARTBEAT_INTERVAL_MS,
          RAW_TEXT_HEARTBEAT_INITIAL_DELAY_MS
        );

        try {
          for await (const event of runFacilitator(messageHistory)) {
            if (isClosed) break;

            switch (event.type) {
              case 'text':
                heartbeat.stop();
                fullText += event.data;
                // Stream raw text back (frontend expects raw text, not SSE events)
                safeEnqueue(encoder.encode(event.data));
                break;

              case 'tool_use':
                // Could optionally send tool info
                break;

              case 'tool_result':
                // Could optionally send tool results
                break;

              case 'done':
                // Backstop (issue #60): an empty final answer must surface as an error,
                // never as a silent close that leaves a user message with no reply.
                if (fullText.trim().length === 0) {
                  console.error('[chat] empty facilitator answer', { threadId });
                  Sentry.captureMessage('chat empty answer', { level: 'error', extra: { threadId } });
                  safeEnqueue(
                    encoder.encode('\n\nError: The model returned an empty answer. Please try again.')
                  );
                  safeClose();
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
                    // Persist token accounting (issue #52). event.usage is summed
                    // across the tool-loop iterations by the facilitator; it is
                    // absent when the stream truncated with no usage chunk (#42),
                    // in which case we leave the columns null rather than crash.
                    inputTokens: event.usage?.promptTokenCount ?? null,
                    outputTokens: event.usage?.candidatesTokenCount ?? null,
                    thinkingTokens: event.usage?.thoughtsTokenCount ?? null,
                    totalTokens: event.usage?.totalTokenCount ?? null,
                  });
                }
                safeClose();
                break;

              case 'error':
                safeEnqueue(encoder.encode(`\n\nError: ${event.data}`));
                safeClose();
                break;
            }
          }

          // Ensure stream is closed even if no 'done' event
          safeClose();
        } catch (error) {
          console.error('Stream error:', error);
          Sentry.captureException(error);
          safeEnqueue(
            encoder.encode(`\n\nError: ${error instanceof Error ? error.message : 'Unknown error'}`)
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

// DELETE /api/v2/threads/[id] - Delete thread
export async function DELETE(request: NextRequest, context: RouteContext) {
  try {
    const authResult = await authenticateRequest(request);
    if ('error' in authResult) {
      return authResult.error;
    }

    const { user } = authResult;
    const { id } = await context.params;

    const deleted = await deleteThread(id, user.id);
    if (!deleted) {
      return createErrorResponse('Thread not found', 404);
    }

    return NextResponse.json({ message: 'Thread deleted successfully' });
  } catch (error) {
    console.error('Delete thread error:', error);
    return createErrorResponse('Failed to delete thread', 500);
  }
}
