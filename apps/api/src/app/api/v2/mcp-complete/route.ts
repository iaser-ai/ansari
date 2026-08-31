import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { z } from 'zod';
import { runFacilitator, type Message, type FacilitatorStreamEvent } from '@/lib/facilitator/agent';
import type { ContentBlock, ToolCallRecord } from '@/db/schema/messages';
import { db } from '@/lib/db/index';
import { getOrCreateSystemUser } from '@/lib/db/users';
import { createThread, createMessage, persistOrphanToolCalls } from '@/lib/db/threads';
import { getClientId } from '@/lib/attribution';
import { checkRateLimit, getClientIp } from '@/lib/rate-limit';

const CONCISE_INSTRUCTION =
  'Please provide a concise and brief answer. References are not required unless specifically asked for. Focus on delivering key information clearly and succinctly.';

const ATTRIBUTION =
  '\n\n---\n**This information came from [ansari.chat](https://ansari.chat). Full references and citations are available upon request.**';

// Cached system user ID to avoid repeated DB lookups
let cachedSystemUserId: string | null = null;

async function getSystemUserId(): Promise<string> {
  if (cachedSystemUserId) return cachedSystemUserId;

  // Resolve by durable system_key, never by email (spec 4): a pre-registered
  // look-alike (system_key NULL) can never receive this endpoint's data.
  const user = await getOrCreateSystemUser('ai-skill');
  cachedSystemUserId = user.id;
  return cachedSystemUserId;
}

const messageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().min(1, 'Content must not be empty').max(4000, 'Content must be at most 4000 characters'),
});

const postBodySchema = z.object({
  messages: z
    .array(messageSchema)
    .min(1, 'At least one message is required')
    .max(20, 'At most 20 messages allowed'),
});

function createErrorResponse(message: string, status: number, headers?: Record<string, string>): NextResponse {
  return NextResponse.json({ error: message }, { status, headers });
}

// 120/min instead of the default 30 (#87): browsing AIs consuming the
// published prompt share egress IPs, so per-IP volume is many users deep.
const RATE_LIMIT_PER_MINUTE = 120;

function applyRateLimit(request: NextRequest): NextResponse | null {
  const ip = getClientIp(request);
  const { allowed, retryAfter } = checkRateLimit(ip, RATE_LIMIT_PER_MINUTE);
  if (!allowed) {
    return createErrorResponse('Rate limit exceeded', 429, {
      'Retry-After': String(retryAfter),
    });
  }
  return null;
}

/**
 * Convert input messages to the facilitator's Message[] format,
 * prepending the concise instruction to the first user message's content.
 */
function prepareMessages(inputMessages: Array<{ role: 'user' | 'assistant'; content: string }>): Message[] {
  const messages: Message[] = [];
  let firstUserFound = false;

  for (const msg of inputMessages) {
    const contentBlocks: ContentBlock[] = [];

    if (msg.role === 'user' && !firstUserFound) {
      // Prepend concise instruction to the first user message
      contentBlocks.push({ type: 'text', text: CONCISE_INSTRUCTION + '\n\n' + msg.content });
      firstUserFound = true;
    } else {
      contentBlocks.push({ type: 'text', text: msg.content });
    }

    messages.push({ role: msg.role, content: contentBlocks });
  }

  return messages;
}

/**
 * Run the facilitator and collect the full response text along with the
 * accumulated token usage and tool records from the terminal event.
 *
 * A facilitator `error` is RETURNED (not thrown) so its tool records survive
 * to be persisted (spec 73); the caller re-raises it, keeping the 500 contract.
 */
async function collectFacilitatorResponse(
  messages: Message[]
): Promise<{
  text: string;
  usage?: NonNullable<FacilitatorStreamEvent['usage']>;
  toolCalls?: ToolCallRecord[];
  error?: string;
}> {
  let fullText = '';
  let usage: FacilitatorStreamEvent['usage'];
  let toolCalls: ToolCallRecord[] | undefined;

  for await (const event of runFacilitator(messages)) {
    switch (event.type) {
      case 'text':
        fullText += event.data;
        break;
      case 'error':
        return { text: fullText, usage, toolCalls: event.toolCalls, error: event.data };
      case 'done':
        usage = event.usage;
        toolCalls = event.toolCalls;
        break;
    }
  }

  return { text: fullText, usage, toolCalls };
}

/**
 * Core handler shared by GET and POST.
 */
async function handleMcpComplete(
  inputMessages: Array<{ role: 'user' | 'assistant'; content: string }>,
  client: string | null
): Promise<NextResponse> {
  console.log(`[ai-skill] mcp-complete request: ${inputMessages.length} message(s)`);
  Sentry.setTag('source', 'ai-skill');

  const messages = prepareMessages(inputMessages);

  // Log to DB: create system user, thread, and user messages. `source` stays
  // 'ai-skill' (product surface); `client` is the per-request X-Ansari-Client
  // attribution (spec 56), NULL when the header is absent.
  const systemUserId = await getSystemUserId();

  // Thread + inbound messages persist atomically (issue #20): a failed message
  // insert rolls back the thread instead of orphaning it. Scoped to this
  // pre-facilitator persistence only — never held across the facilitator call.
  const thread = await db.transaction(async (tx) => {
    const created = await createThread({ userId: systemUserId, source: 'ai-skill', client }, tx);
    for (const msg of inputMessages) {
      await createMessage(
        {
          threadId: created.id,
          role: msg.role,
          content: [{ type: 'text', text: msg.content }],
          source: 'ai-skill',
          client,
        },
        tx
      );
    }
    return created;
  });

  // Run facilitator to completion
  const {
    text: responseText,
    usage,
    toolCalls,
    error: facilitatorError,
  } = await collectFacilitatorResponse(messages);

  if (facilitatorError !== undefined) {
    // Tool records from a failed turn (spec 73), then the same throw as before so
    // the route's catch still answers 500 with the facilitator's message.
    await persistOrphanToolCalls({
      threadId: thread.id,
      reason: 'error',
      source: 'ai-skill',
      client,
      toolCalls,
    });
    throw new Error(facilitatorError);
  }

  // Backstop (issue #60): never ship an empty 200. If the facilitator completed with no
  // visible text (its own retry exhausted, or any future empty mode), return an explicit
  // 502 so the client's retry logic acts on a real signal instead of receiving a
  // contentless attribution footer. No assistant row persisted, no PII logged — only
  // the turn's tool records, to the orphan table (spec 73).
  if (responseText.trim().length === 0) {
    console.error('[ai-skill] mcp-complete: empty facilitator answer', { threadId: thread.id });
    Sentry.captureMessage('mcp-complete empty answer', {
      level: 'error',
      extra: { threadId: thread.id },
    });
    await persistOrphanToolCalls({
      threadId: thread.id,
      reason: 'empty_final',
      source: 'ai-skill',
      client,
      toolCalls,
    });
    return createErrorResponse('The model returned an empty answer. Please retry.', 502);
  }

  const fullResponse = responseText + ATTRIBUTION;

  // Log assistant response to DB
  await createMessage({
    threadId: thread.id,
    role: 'assistant',
    content: [{ type: 'text', text: fullResponse }],
    agentName: 'facilitator',
    source: 'ai-skill',
    client,
    inputTokens: usage?.promptTokenCount ?? null,
    outputTokens: usage?.candidatesTokenCount ?? null,
    thinkingTokens: usage?.thoughtsTokenCount ?? null,
    totalTokens: usage?.totalTokenCount ?? null,
    // Tool dispatch records (spec 73); NULL, never [], when no tool ran.
    toolCalls: toolCalls ?? null,
  });

  return new NextResponse(fullResponse, {
    status: 200,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
}

// POST /api/v2/mcp-complete
export async function POST(request: NextRequest): Promise<NextResponse> {
  const rateLimitResponse = applyRateLimit(request);
  if (rateLimitResponse) return rateLimitResponse;

  try {
    const body = await request.json();
    const parseResult = postBodySchema.safeParse(body);
    if (!parseResult.success) {
      const errors = parseResult.error.issues.map((i) => i.message).join(', ');
      return createErrorResponse(errors, 400);
    }

    return await handleMcpComplete(parseResult.data.messages, getClientId(request));
  } catch (error) {
    console.error('[ai-skill] mcp-complete POST error:', error);
    Sentry.captureException(error);
    const message = error instanceof Error ? error.message : 'Internal server error';
    return createErrorResponse(message, 500);
  }
}

// GET /api/v2/mcp-complete?q=URL_ENCODED_QUESTION
export async function GET(request: NextRequest): Promise<NextResponse> {
  const rateLimitResponse = applyRateLimit(request);
  if (rateLimitResponse) return rateLimitResponse;

  try {
    const q = request.nextUrl.searchParams.get('q');
    if (!q || q.trim().length === 0) {
      return createErrorResponse('Query parameter "q" is required', 400);
    }
    if (q.length > 2000) {
      return createErrorResponse('Query parameter "q" must be at most 2000 characters', 400);
    }

    return await handleMcpComplete([{ role: 'user', content: q.trim() }], getClientId(request));
  } catch (error) {
    console.error('[ai-skill] mcp-complete GET error:', error);
    Sentry.captureException(error);
    const message = error instanceof Error ? error.message : 'Internal server error';
    return createErrorResponse(message, 500);
  }
}
