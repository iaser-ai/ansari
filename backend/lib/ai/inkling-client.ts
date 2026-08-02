/**
 * Minimal OpenAI-compatible client for thinkingmachines/Inkling (issue #74).
 *
 * Inkling is the facilitator's off-Vertex backup (#74/#79): the FINAL rung of
 * the empty-final retry ladder, and the one-shot rescue for terminal Gemini
 * errors. It runs on Tinker infrastructure entirely separate from Vertex, so it
 * can still answer when both Gemini capacity pools are degraded at once (the
 * dual-pool 429/hang waves). It is never used on the primary path.
 *
 * The stream surface deliberately mirrors streamGemini — GeminiStreamEvent in,
 * GeminiResponse (with a Gemini-format Content rawPayload) out — so the
 * facilitator loop consumes either client interchangeably and conversation
 * history stays in one format.
 *
 * Load-bearing integration facts (BATIK eval, codev/experiments/batik-benchmarks/inkling/):
 * - max_tokens MUST sit in the 8–16K window: the visible answer lands in
 *   `content` only after a hidden pass streamed as `reasoning_content`; a small
 *   cap yields null content.
 * - `reasoning_content` arrives separately from `content` and must NEVER reach
 *   the user-visible stream or persisted messages — it is dropped here and is
 *   excluded from both `text` and `rawPayload`.
 * - temperature 0 is the evaluated configuration (100/100 BATIK, 0 malformed
 *   tool calls, 0 empty finals).
 */
import * as Sentry from '@sentry/nextjs';
import { config } from '../config';
import type {
  Content,
  GeminiResponse,
  GeminiStreamEvent,
  GeminiToolCall,
  GeminiUsageMetadata,
} from './gemini-client';
import type { GeminiTool } from '../tools/types';

export const INKLING_MODEL = 'thinkingmachines/Inkling';
const INKLING_API_URL =
  'https://tinker.thinkingmachines.dev/services/tinker-prod/oai/api/v1/chat/completions';
// See header: must be 8–16K so the hidden reasoning pass cannot starve the
// visible answer. Matches the evaluated BATIK configuration.
const INKLING_MAX_TOKENS = 8192;
const INKLING_TEMPERATURE = 0;
// Backstop when the caller passes no timeoutMs (the facilitator always does).
const DEFAULT_TIMEOUT_MS = 180_000;

export interface InklingCallOptions {
  systemPrompt?: string;
  history?: Content[];
  tools?: GeminiTool[];
  timeoutMs?: number;
}

let warnedUnconfigured = false;

/**
 * True when Inkling can run. An unset TINKER_API_KEY is the one supported
 * "disabled" state (issues #74/#79): the ladder rung and the terminal-error
 * rescue are both skipped cleanly and the absence is logged once per process,
 * not per request.
 */
export function isInklingConfigured(): boolean {
  const configured = !!config.inkling.apiKey;
  if (!configured && !warnedUnconfigured) {
    warnedUnconfigured = true;
    console.warn(
      '[inkling] TINKER_API_KEY not set — Inkling fallback rung and error rescue disabled'
    );
  }
  return configured;
}

type OpenAiToolCall = {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
};

type OpenAiMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: OpenAiToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

/**
 * Convert Gemini-format Content history to OpenAI messages. Gemini carries no
 * tool-call ids, so ids are synthesized in call order and functionResponse
 * parts are matched FIFO — the facilitator appends responses in the order the
 * calls were issued, so positional matching is exact. Thought parts never
 * cross: they belong to another provider and must not leak.
 *
 * Robustness for our own tool-round histories (issue #81): the model turn's
 * `functionCall` can be missing from the stored `rawPayload` — gemini-client
 * keeps only the last streamed chunk's parts as rawPayload ("last chunk wins",
 * gemini-client.ts), so a gemini-3.6-flash turn that emits a trailing content
 * chunk after the functionCall chunk drops the call from history even though
 * the tool ran. That would leave a `functionResponse` with no preceding
 * `functionCall` and, before this fix, threw — crashing the Inkling rung on
 * exactly the multi-round requests it exists to rescue. Since the response
 * still carries the tool `name`, we synthesize the authoritative assistant
 * tool_call from it rather than throwing. Fail-fast is kept only for a response
 * with no name at all (genuinely unusable, not a history our loop built).
 */
function toOpenAiMessages(
  history: Content[],
  systemPrompt?: string,
  message?: string
): OpenAiMessage[] {
  const messages: OpenAiMessage[] = [];
  if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
  let callSeq = 0;
  let synthesizedCallCount = 0;
  const pendingCallIds: string[] = [];
  for (const content of history) {
    const parts = content.parts ?? [];
    if (content.role === 'model') {
      const text = parts.map((p) => (p.text && !p.thought ? p.text : '')).join('');
      const toolCalls: OpenAiToolCall[] = [];
      for (const p of parts) {
        if (!p.functionCall?.name) continue;
        const id = `call_${callSeq++}`;
        pendingCallIds.push(id);
        toolCalls.push({
          id,
          type: 'function',
          function: {
            name: p.functionCall.name,
            arguments: JSON.stringify(p.functionCall.args ?? {}),
          },
        });
      }
      if (text || toolCalls.length > 0) {
        messages.push({
          role: 'assistant',
          content: text || null,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        });
      }
    } else {
      for (const p of parts) {
        if (!p.functionResponse) continue;
        let id = pendingCallIds.shift();
        if (!id) {
          // The functionCall was dropped from the model turn's rawPayload
          // (issue #81). The response still names the tool, so reconstruct the
          // assistant tool_call turn instead of crashing. Args are unknown
          // (they lived on the lost functionCall) — an empty object is enough,
          // since Inkling only reads the conversation, it never re-executes.
          const name = p.functionResponse.name;
          if (!name) {
            throw new Error('[inkling] functionResponse in history without a preceding functionCall');
          }
          id = `call_${callSeq++}`;
          synthesizedCallCount++;
          messages.push({
            role: 'assistant',
            content: null,
            tool_calls: [{ id, type: 'function', function: { name, arguments: '{}' } }],
          });
        }
        messages.push({
          role: 'tool',
          tool_call_id: id,
          content: JSON.stringify(p.functionResponse.response ?? {}),
        });
      }
      const text = parts
        .map((p) => p.text ?? '')
        .filter((t) => t.length > 0)
        .join('\n');
      if (text) messages.push({ role: 'user', content: text });
    }
  }
  if (message) messages.push({ role: 'user', content: message });
  if (synthesizedCallCount > 0) {
    // No PII: counters only. Flags histories where a functionCall was dropped
    // upstream and the converter recovered instead of throwing (issue #81).
    Sentry.addBreadcrumb({
      category: 'inkling',
      level: 'warning',
      message: 'synthesized assistant tool_call for orphaned functionResponse (issue #81)',
      data: { synthesizedCallCount },
    });
  }
  return messages;
}

interface SchemaLike {
  type?: string;
  properties?: Record<string, SchemaLike>;
  items?: SchemaLike;
  [key: string]: unknown;
}

/** Gemini Schema uses uppercase type enums (OBJECT/STRING); JSON Schema wants lowercase. */
function toJsonSchema(schema: SchemaLike): SchemaLike {
  const out: SchemaLike = { ...schema };
  if (typeof out.type === 'string') out.type = out.type.toLowerCase();
  if (out.properties) {
    out.properties = Object.fromEntries(
      Object.entries(out.properties).map(([key, value]) => [key, toJsonSchema(value)])
    );
  }
  if (out.items) out.items = toJsonSchema(out.items);
  return out;
}

function toOpenAiTools(tools: GeminiTool[]): Array<Record<string, unknown>> {
  return tools
    .flatMap((t) => t.functionDeclarations ?? [])
    .map((fn) => ({
      type: 'function',
      function: {
        name: fn.name,
        description: fn.description,
        parameters: toJsonSchema((fn.parameters ?? { type: 'object', properties: {} }) as SchemaLike),
      },
    }));
}

/** Map OpenAI finish_reason onto the Gemini vocabulary the ladder classifies on. */
function mapFinishReason(reason: string | null | undefined): string | undefined {
  if (!reason) return undefined;
  switch (reason) {
    case 'stop':
    case 'tool_calls':
      return 'STOP';
    case 'length':
      return 'MAX_TOKENS';
    case 'content_filter':
      return 'SAFETY';
    default:
      return reason.toUpperCase();
  }
}

interface InklingStreamChunk {
  choices?: Array<{
    delta?: {
      content?: string | null;
      reasoning_content?: string | null;
      tool_calls?: Array<{ index?: number; function?: { name?: string; arguments?: string } }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    completion_tokens_details?: { reasoning_tokens?: number };
  } | null;
}

/** Extract the payload of a single SSE line, or null if it is not a `data:` line. */
function ssePayload(line: string): string | null {
  const trimmed = line.replace(/\r$/, '');
  if (!trimmed.startsWith('data:')) return null;
  const payload = trimmed.slice(5).trim();
  return payload || null;
}

/**
 * Yield the payload of each `data:` SSE line; stops at [DONE]. Sets `marker.sawDone` true iff
 * the terminal `[DONE]` marker was seen, so the caller can distinguish a server-declared
 * completion from a mid-stream connection cut (issue #2).
 *
 * On EOF, any final line NOT terminated by a newline is still processed — an OpenAI-compat
 * server can send its last `data:` chunk (which may carry the finish_reason or `[DONE]`)
 * without a trailing newline, and dropping it would both lose that chunk and misreport an
 * otherwise-complete stream as truncated.
 */
async function* sseData(
  body: ReadableStream<Uint8Array>,
  marker: { sawDone: boolean },
): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffered = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
      let newline: number;
      while ((newline = buffered.indexOf('\n')) !== -1) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        const payload = ssePayload(line);
        if (payload === '[DONE]') {
          marker.sawDone = true;
          return;
        }
        if (payload) yield payload;
      }
    }
    // Flush a trailing line with no terminating newline (issue #2).
    buffered += decoder.decode();
    if (buffered.length > 0) {
      const payload = ssePayload(buffered);
      if (payload === '[DONE]') {
        marker.sawDone = true;
        return;
      }
      if (payload) yield payload;
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Stream a chat completion from Inkling, yielding the same event vocabulary as
 * streamGemini. Single attempt, fail fast: this client IS the last rung — there
 * is nothing to fail over to, so any error surfaces immediately and loudly.
 */
export async function* streamInkling(
  message: string,
  options: InklingCallOptions = {}
): AsyncGenerator<GeminiStreamEvent> {
  const apiKey = config.inkling.apiKey;
  if (!apiKey) {
    throw new Error('[inkling] TINKER_API_KEY is not set — cannot call Inkling');
  }

  const body: Record<string, unknown> = {
    model: INKLING_MODEL,
    max_tokens: INKLING_MAX_TOKENS,
    temperature: INKLING_TEMPERATURE,
    stream: true,
    // OpenAI-compat streams omit the final usage chunk unless asked (#77);
    // without it token accounting persists zeros for Inkling-served requests.
    stream_options: { include_usage: true },
    messages: toOpenAiMessages(options.history ?? [], options.systemPrompt, message),
  };
  if (options.tools && options.tools.length > 0) {
    body.tools = toOpenAiTools(options.tools);
  }

  const startTime = Date.now();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error(`Inkling call timed out after ${timeoutMs / 1000}s`)),
    timeoutMs
  );

  try {
    const res = await fetch(INKLING_API_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok || !res.body) {
      const detail = res.body ? (await res.text().catch(() => '')).slice(0, 500) : 'no response body';
      throw new Error(`[inkling] HTTP ${res.status}: ${detail}`);
    }

    let text = '';
    let finishReason: string | undefined;
    let usage: GeminiUsageMetadata | undefined;
    // Streamed tool calls arrive as fragments keyed by index; arguments concatenate.
    const partialToolCalls = new Map<number, { name: string; args: string }>();

    // Distinguish a server-declared completion from a mid-stream connection cut (issue #2):
    // a legitimate stream ends with the `[DONE]` marker (sets marker.sawDone) and/or a
    // finish_reason. A raw EOF after partial text yields neither.
    const marker = { sawDone: false };

    for await (const payload of sseData(res.body, marker)) {
      let chunk: InklingStreamChunk;
      try {
        chunk = JSON.parse(payload) as InklingStreamChunk;
      } catch {
        throw new Error('[inkling] malformed SSE JSON chunk');
      }
      const choice = chunk.choices?.[0];
      // choice.delta.reasoning_content is the hidden pass — intentionally dropped.
      if (typeof choice?.delta?.content === 'string' && choice.delta.content.length > 0) {
        text += choice.delta.content;
        yield { type: 'text', data: choice.delta.content };
      }
      for (const tc of choice?.delta?.tool_calls ?? []) {
        const index = tc.index ?? 0;
        const entry = partialToolCalls.get(index) ?? { name: '', args: '' };
        if (tc.function?.name) entry.name = tc.function.name;
        if (tc.function?.arguments) entry.args += tc.function.arguments;
        partialToolCalls.set(index, entry);
      }
      if (choice?.finish_reason) finishReason = mapFinishReason(choice.finish_reason);
      if (chunk.usage) {
        usage = {
          promptTokenCount: chunk.usage.prompt_tokens ?? 0,
          candidatesTokenCount: chunk.usage.completion_tokens ?? 0,
          thoughtsTokenCount: chunk.usage.completion_tokens_details?.reasoning_tokens ?? 0,
          totalTokenCount: chunk.usage.total_tokens ?? 0,
        };
      }
    }

    // The stream must PROVE it completed (issue #2): the terminal `[DONE]` marker or a
    // finish_reason. Neither means the HTTP body ended mid-answer — a connection cut after
    // partial text. The Gemini path detects truncation explicitly; this last rung, which has
    // nothing to fail over to, must too — surfacing a distinct truncation error rather than
    // shipping an incomplete answer marked complete.
    if (!marker.sawDone && finishReason === undefined) {
      throw new Error(
        `[inkling] stream ended before completion ([DONE] or finish_reason) — truncated after ${text.length} chars`,
      );
    }

    const toolCalls: GeminiToolCall[] = [];
    for (const [index, entry] of [...partialToolCalls.entries()].sort((a, b) => a[0] - b[0])) {
      if (!entry.name) {
        throw new Error(`[inkling] streamed tool call ${index} is missing a function name`);
      }
      let args: Record<string, unknown>;
      try {
        args = entry.args ? (JSON.parse(entry.args) as Record<string, unknown>) : {};
      } catch {
        throw new Error(`[inkling] tool call ${entry.name} arrived with malformed JSON arguments`);
      }
      toolCalls.push({ name: entry.name, args });
      yield { type: 'tool_call', data: { name: entry.name, args } };
    }

    // rawPayload in Gemini Content format so facilitator history stays uniform.
    // reasoning_content is deliberately excluded — it must never be persisted.
    const responseParts: NonNullable<Content['parts']> = [];
    if (text) responseParts.push({ text });
    for (const tc of toolCalls) responseParts.push({ functionCall: { name: tc.name, args: tc.args } });

    const response: GeminiResponse = {
      text,
      toolCalls,
      rawPayload: { role: 'model', parts: responseParts },
      hasThinking: false,
      usage,
      durationMs: Date.now() - startTime,
      finishReason,
    };
    yield { type: 'done', response };
  } finally {
    clearTimeout(timer);
  }
}
