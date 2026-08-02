/**
 * OpenAI-compatible /v1/chat/completions adapter (Spec 19).
 *
 * Built so external evaluation harnesses — primarily the IslamicMMLU
 * leaderboard — can drive the real Ansari facilitator (Gemini 3.x +
 * Islamic tools) through a standard OpenAI request/response shape.
 *
 * Two model ids are served (issue #74): 'ansari-facilitator' (Gemini
 * primary, the original pipeline) and 'ansari-facilitator-inkling'
 * (identical pipeline with thinkingmachines/Inkling as primary for the
 * whole request — never silently falling back to Gemini). Unknown ids
 * are rejected with 400.
 *
 * What is preserved: the request body matches the public OpenAI Chat
 * Completions schema (model/messages/temperature/max_tokens/seed), and
 * the response envelope matches `chat.completion` with a populated
 * `usage` object. What is NOT preserved: streaming, tool/function
 * calling on the OpenAI side, top_p/penalties (the facilitator hard-
 * codes its own generation settings).
 */
import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import {
  runFacilitator,
  type Message,
  type FacilitatorStreamEvent,
} from '@/lib/facilitator/agent';
import { createThread, createMessage } from '@/lib/db/threads';
import { getOrCreateSystemUser } from '@/lib/db/users';
import { getClientId } from '@/lib/attribution';
import { isInklingConfigured } from '@/lib/ai/inkling-client';
import type { ContentBlock } from '@/db/schema/messages';
import { config } from '@/lib/config';

const SOURCE_TAG = 'leaderboard';

// Served model ids (issue #74 scope amendment). Both run the identical full
// Ansari pipeline (facilitator + Islamic tools + prod prompt rules); they
// differ ONLY in the primary model for the whole request. Unknown ids fail
// fast with 400 — a typo must never silently fall back to Gemini, or the
// resulting leaderboard submission would misattribute the answers.
const GEMINI_MODEL_ID = 'ansari-facilitator';
const INKLING_MODEL_ID = 'ansari-facilitator-inkling';

// Triggers letter-answer mode: either the harness asked for a tiny
// completion, or the prompt looks like a multiple-choice question.
const LETTER_ANSWER_MAX_TOKENS = 16;
const MCQ_PATTERN = /\n\s*[ABCD][).]\s/;

const LETTER_ANSWER_DIRECTIVE =
  '\n\nReply with only the single letter (A, B, C, or D) of the correct answer — no explanation, no markdown, no citations.';

// OpenAI request body — accept the fields the leaderboard form sets and
// ignore the rest. `messages` is the only required field that affects
// behavior; everything else is metadata or a hint for letter-answer mode.
const messageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant']),
  content: z.string().min(1).max(8000),
});

const requestSchema = z.object({
  model: z.string().optional(),
  messages: z.array(messageSchema).min(1).max(40),
  temperature: z.number().min(0).max(2).optional(),
  top_p: z.number().min(0).max(1).optional(),
  max_tokens: z.number().int().min(1).max(32768).optional(),
  seed: z.number().int().optional(),
  stream: z.boolean().optional(),
});

type OpenAIRequest = z.infer<typeof requestSchema>;

function openAIError(
  message: string,
  status: number,
  type: string,
  code: string,
  headers?: Record<string, string>
): NextResponse {
  return NextResponse.json(
    { error: { message, type, code } },
    { status, headers }
  );
}

/**
 * Authenticate via Authorization: Bearer <LEADERBOARD_API_KEY>.
 *
 * Returns null on success or an error response on failure. Treats an
 * unconfigured server (no env var) as 503 — clearer signal than 401
 * when the operator forgot to set the key.
 */
function authorize(request: NextRequest): NextResponse | null {
  const expected = config.leaderboard.apiKey;
  if (!expected) {
    return openAIError(
      'Leaderboard API not configured on this server.',
      503,
      'server_error',
      'not_configured'
    );
  }

  const header = request.headers.get('authorization') ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match || match[1].trim() !== expected) {
    return openAIError(
      'Invalid or missing API key.',
      401,
      'invalid_request_error',
      'invalid_api_key'
    );
  }

  return null;
}

let cachedSystemUserId: string | null = null;

async function getSystemUserId(): Promise<string> {
  if (cachedSystemUserId) return cachedSystemUserId;

  // Resolve by durable system_key, never by email (spec 4).
  const user = await getOrCreateSystemUser('leaderboard');
  cachedSystemUserId = user.id;
  return cachedSystemUserId;
}

/**
 * Decide whether to switch into letter-answer mode and rewrite the
 * messages accordingly. The directive is appended to the *last* user
 * message so it overrides anything from earlier system messages.
 */
function applyLetterAnswerMode(
  messages: OpenAIRequest['messages'],
  maxTokens: number | undefined
): { messages: OpenAIRequest['messages']; letterAnswerMode: boolean } {
  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  if (!lastUser) {
    return { messages, letterAnswerMode: false };
  }

  const looksLikeMCQ = MCQ_PATTERN.test(lastUser.content);
  const tinyOutput = maxTokens !== undefined && maxTokens <= LETTER_ANSWER_MAX_TOKENS;
  if (!looksLikeMCQ && !tinyOutput) {
    return { messages, letterAnswerMode: false };
  }

  const rewritten = messages.map((m) =>
    m === lastUser ? { ...m, content: m.content + LETTER_ANSWER_DIRECTIVE } : m
  );
  return { messages: rewritten, letterAnswerMode: true };
}

/**
 * Convert the OpenAI message array into the facilitator's Message[].
 *
 * System messages are concatenated into a prepend on the first user
 * message. We deliberately don't replace the facilitator's own system
 * prompt — Ansari's Islamic-Q&A guardrails are not optional.
 */
function toFacilitatorMessages(messages: OpenAIRequest['messages']): Message[] {
  const systemPrepend = messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n\n');

  const result: Message[] = [];
  let firstUserSeen = false;

  for (const m of messages) {
    if (m.role === 'system') continue;
    let text = m.content;
    if (m.role === 'user' && !firstUserSeen && systemPrepend) {
      text = systemPrepend + '\n\n' + text;
      firstUserSeen = true;
    } else if (m.role === 'user') {
      firstUserSeen = true;
    }
    const content: ContentBlock[] = [{ type: 'text', text }];
    result.push({ role: m.role as 'user' | 'assistant', content });
  }
  return result;
}

/**
 * Run the facilitator to completion and aggregate text + usage.
 */
async function collectResponse(
  messages: Message[],
  provider: 'gemini' | 'inkling'
): Promise<{ text: string; usage?: NonNullable<FacilitatorStreamEvent['usage']> }> {
  let fullText = '';
  let usage: FacilitatorStreamEvent['usage'];

  for await (const event of runFacilitator(messages, undefined, { provider })) {
    if (event.type === 'text') {
      fullText += event.data;
    } else if (event.type === 'error') {
      throw new Error(event.data);
    } else if (event.type === 'done') {
      usage = event.usage;
    }
  }

  return { text: fullText, usage };
}

/**
 * Pull out the model's intended letter answer. Models often ignore the
 * "no preamble" instruction and emit `Answer: B` or `The answer is C.`,
 * so we look for the first STANDALONE letter A/B/C/D (word boundaries
 * on both sides), which skips the "A" in "Answer" but catches the real
 * choice. Falls back to the trimmed original if nothing matches.
 */
function extractLetter(text: string): string {
  const match = /\b([ABCD])\b/.exec(text.toUpperCase());
  return match ? match[1] : text.trim();
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const authError = authorize(request);
  if (authError) return authError;

  // Authenticated callers bypass the IP rate limiter (the leaderboard
  // sequentially fires 10k+ requests; the IP limit would 429 them).
  // Unauthenticated calls never reach this point — `authorize` returns
  // 401 first — but keep this in the auth-bypass shape so future callers
  // with optional auth Just Work.

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return openAIError(
      'Request body must be valid JSON.',
      400,
      'invalid_request_error',
      'invalid_json'
    );
  }

  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) {
    return openAIError(
      parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '),
      400,
      'invalid_request_error',
      'invalid_body'
    );
  }

  const req = parsed.data;

  if (req.stream) {
    return openAIError(
      'Streaming is not supported on this endpoint.',
      400,
      'invalid_request_error',
      'streaming_unsupported'
    );
  }

  // Model routing (issue #74): omitted model → the original Gemini-backed
  // pipeline; the two served ids select the primary provider for the whole
  // request; anything else is an explicit 400 (see MODEL_ID comment above).
  const requestedModel = req.model ?? GEMINI_MODEL_ID;
  if (requestedModel !== GEMINI_MODEL_ID && requestedModel !== INKLING_MODEL_ID) {
    return openAIError(
      `Unknown model '${requestedModel}'. Available models: ${GEMINI_MODEL_ID}, ${INKLING_MODEL_ID}.`,
      400,
      'invalid_request_error',
      'model_not_found'
    );
  }
  const provider = requestedModel === INKLING_MODEL_ID ? ('inkling' as const) : ('gemini' as const);
  if (provider === 'inkling' && !isInklingConfigured()) {
    return openAIError(
      `Model '${INKLING_MODEL_ID}' is not configured on this server (TINKER_API_KEY unset).`,
      503,
      'server_error',
      'inkling_not_configured'
    );
  }

  const { messages: rewritten, letterAnswerMode } = applyLetterAnswerMode(
    req.messages,
    req.max_tokens
  );

  Sentry.setTag('source', SOURCE_TAG);
  Sentry.setTag('letter_answer_mode', String(letterAnswerMode));
  Sentry.setTag('leaderboard_model', requestedModel);

  // Per-request client attribution from X-Ansari-Client (spec 56). `source`
  // stays SOURCE_TAG ('leaderboard'); `client` is the orthogonal axis, NULL
  // when the header is absent.
  const client = getClientId(request);

  const facilitatorMessages = toFacilitatorMessages(rewritten);

  // Log to DB so we can observe leaderboard traffic in admin stats.
  // Failure to log is non-fatal — the caller still gets their answer.
  let threadId: string | undefined;
  try {
    const systemUserId = await getSystemUserId();
    const thread = await createThread({ userId: systemUserId, source: SOURCE_TAG, client });
    threadId = thread.id;
    for (const m of req.messages) {
      if (m.role === 'system') continue;
      await createMessage({
        threadId: thread.id,
        role: m.role,
        content: [{ type: 'text', text: m.content }],
        source: SOURCE_TAG,
        client,
      });
    }
  } catch (err) {
    console.error('[leaderboard] failed to log inbound messages:', err);
    Sentry.captureException(err);
  }

  let result: { text: string; usage?: NonNullable<FacilitatorStreamEvent['usage']> };
  try {
    result = await collectResponse(facilitatorMessages, provider);
  } catch (err) {
    console.error('[leaderboard] facilitator error:', err);
    Sentry.captureException(err);
    return openAIError(
      err instanceof Error ? err.message : 'Internal facilitator error.',
      500,
      'server_error',
      'facilitator_failed'
    );
  }

  const responseText = letterAnswerMode ? extractLetter(result.text) : result.text;

  if (threadId) {
    try {
      await createMessage({
        threadId,
        role: 'assistant',
        content: [{ type: 'text', text: responseText }],
        agentName: 'facilitator',
        source: SOURCE_TAG,
        client,
        inputTokens: result.usage?.promptTokenCount ?? null,
        outputTokens: result.usage?.candidatesTokenCount ?? null,
        thinkingTokens: result.usage?.thoughtsTokenCount ?? null,
        totalTokens: result.usage?.totalTokenCount ?? null,
      });
    } catch (err) {
      console.error('[leaderboard] failed to log assistant message:', err);
      Sentry.captureException(err);
    }
  }

  const usage = result.usage;
  const responseBody = {
    id: `chatcmpl-${randomUUID()}`,
    object: 'chat.completion' as const,
    created: Math.floor(Date.now() / 1000),
    // Per OpenAI spec, `model` in the response is the id of the model
    // that actually served the request. With strict id validation above,
    // the validated requested id IS the serving id (issue #74).
    model: requestedModel,
    choices: [
      {
        index: 0,
        message: { role: 'assistant' as const, content: responseText },
        finish_reason: 'stop' as const,
      },
    ],
    usage: usage
      ? {
          prompt_tokens: usage.promptTokenCount,
          completion_tokens: usage.candidatesTokenCount,
          total_tokens: usage.totalTokenCount,
          completion_tokens_details: {
            reasoning_tokens: usage.thoughtsTokenCount,
          },
        }
      : undefined,
  };

  return NextResponse.json(responseBody, { status: 200 });
}

// Health check: GET responds with a tiny JSON body so the leaderboard
// can verify the route exists before doing any auth-sensitive call.
export async function GET(): Promise<NextResponse> {
  return NextResponse.json(
    {
      object: 'endpoint',
      name: 'ansari-facilitator',
      models: [GEMINI_MODEL_ID, INKLING_MODEL_ID],
      healthy: true,
    },
    { status: 200 }
  );
}
