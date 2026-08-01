/**
 * Gemini Client for Ansari Facilitator (Spec 0004)
 *
 * Migrated to @google/genai SDK (Issue #21):
 * - Uses GoogleGenAI client (replaces deprecated @google/generative-ai)
 * - Default thinking enabled at HIGH level (Gemini 3.x)
 * - Preserves streaming, timeout handling, and thought signature support
 *
 * Public API preserved: callGemini, callGeminiStreaming, streamGemini,
 * continueWithToolResult, buildHistoryFromMessages, GeminiResponse,
 * GeminiCallOptions, GeminiStreamEvent, GeminiToolCall, GeminiUsageMetadata.
 */
import * as Sentry from '@sentry/nextjs';
import {
  GoogleGenAI,
  ThinkingLevel,
  type Chat,
  type Content,
  type GenerateContentConfig,
  type GenerateContentResponse,
  type Part,
  type Tool,
} from '@google/genai';
import { config } from '../config';
import { TOOL_CONTINUATION_DIRECTIVE } from './prompts/facilitator';

// Re-export types needed by consumers
export type { Content, Part, Tool } from '@google/genai';

// Timeouts
const GEMINI_TIMEOUT_MS = 3 * 60 * 1000; // 3 minutes overall
const CHUNK_TIMEOUT_MS = 60 * 1000; // 60 seconds between chunks

// Output-size cap (issue #51). Gemini decoding can degenerate into a verbatim
// repeated-sentence loop WITHIN a single generation (prod: 272K-char / ~400s
// responses), which no tool-iteration count cap can touch. This server-side cap
// bounds the worst case; on Gemini 3 thinking models the model's thoughts also
// count against it, so it is sized with >20x headroom over the largest observed
// legitimate answer (~1.1K output tokens) plus ThinkingLevel.LOW thought budgets.
// Coordinated with issue #60: a MAX_TOKENS finish with EMPTY visible text would
// mean thinking ate this cap — a config bug #60's empty-completion handling
// surfaces loudly, so do not shrink this without revisiting that sizing.
const MAX_OUTPUT_TOKENS = 32_768;

// Runtime repetition guard (issue #51). The cap above bounds the damage; this
// detects the degeneration early and cuts the stream within a few KB instead of
// tens of seconds later at the token cap. Once accumulated visible text passes
// REPETITION_MIN_CHARS, every REPETITION_CHECK_EVERY_CHARS new chars we test
// whether the trailing REPETITION_WINDOW_CHARS are fully periodic with at least
// REPETITION_MIN_REPEATS repeats (smallest period via KMP failure function).
// A 4K-char verbatim-periodic tail never occurs in legitimate answers — the
// largest real web answer observed in prod is ~4.5K chars TOTAL, below the
// check floor — while the prod loops (~100-char sentence periods) trip it
// within ~1 KB of degenerate output.
const REPETITION_MIN_CHARS = 8_192;
const REPETITION_CHECK_EVERY_CHARS = 1_024;
const REPETITION_WINDOW_CHARS = 4_096;
const REPETITION_MIN_REPEATS = 3;

/**
 * True when the tail of `text` is a degenerate repetition loop: the trailing
 * window is fully periodic (every char equals the char one period earlier)
 * with at least REPETITION_MIN_REPEATS repeats of the period. Alignment-free:
 * the tail may end mid-way through a repeat. O(window) per call.
 */
function hasDegenerateRepetitionTail(text: string): boolean {
  if (text.length < REPETITION_MIN_CHARS) return false;
  const tail = text.slice(-REPETITION_WINDOW_CHARS);
  const n = tail.length;
  // KMP failure function; the smallest period of tail is n - fail[n - 1].
  const fail = new Int32Array(n);
  for (let i = 1; i < n; i++) {
    let j = fail[i - 1];
    while (j > 0 && tail[i] !== tail[j]) j = fail[j - 1];
    if (tail[i] === tail[j]) j++;
    fail[i] = j;
  }
  const period = n - fail[n - 1];
  return period <= Math.floor(n / REPETITION_MIN_REPEATS);
}

/**
 * Initialize Gemini client.
 *
 * Uses Vertex AI when GOOGLE_CLOUD_PROJECT is configured (preferred):
 * credentials come from GOOGLE_APPLICATION_CREDENTIALS_JSON (inline, for Railway)
 * or GOOGLE_APPLICATION_CREDENTIALS (file path, for local dev). If neither is set,
 * the SDK falls back to Application Default Credentials.
 *
 * Otherwise uses the public Gemini API with GEMINI_API_KEY.
 */
function buildClient(): GoogleGenAI {
  const { useVertex, apiKey, vertex } = config.gemini;

  if (useVertex) {
    const { project, location, credentialsJson, credentialsPath } = vertex;

    if (credentialsJson) {
      let parsed: { client_email?: string; private_key?: string };
      try {
        parsed = JSON.parse(credentialsJson);
      } catch (err) {
        throw new Error(
          `GOOGLE_APPLICATION_CREDENTIALS_JSON is not valid JSON: ${(err as Error).message}`
        );
      }
      if (!parsed.client_email || !parsed.private_key) {
        throw new Error(
          'GOOGLE_APPLICATION_CREDENTIALS_JSON is missing client_email or private_key'
        );
      }
      return new GoogleGenAI({
        vertexai: true,
        project,
        location,
        googleAuthOptions: {
          credentials: {
            client_email: parsed.client_email,
            private_key: parsed.private_key,
          },
        },
      });
    }

    if (credentialsPath) {
      return new GoogleGenAI({
        vertexai: true,
        project,
        location,
        googleAuthOptions: { keyFile: credentialsPath },
      });
    }

    // Fall back to Application Default Credentials (gcloud auth, GCE metadata, etc.)
    return new GoogleGenAI({ vertexai: true, project, location });
  }

  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is required but not configured');
  }
  return new GoogleGenAI({ apiKey });
}

// Cache the client across calls. Building it per-call re-runs Vertex OAuth and
// makes the @google/genai SDK re-emit its "credentials take precedence" notice
// on every request — the source of the log flood. Built once here and reused.
let cachedClient: GoogleGenAI | null = null;

function getClient(): GoogleGenAI {
  return (cachedClient ??= buildClient());
}

/**
 * Build the GenerateContentConfig used at every call site.
 * Centralized so the thinking + system + tools settings stay consistent.
 */
function buildConfig(options: GeminiCallOptions): GenerateContentConfig {
  return {
    systemInstruction: options.systemPrompt,
    tools: options.tools,
    // Bounds runaway decoding loops (issue #51). Thinking-inclusive on Gemini 3;
    // sized with large headroom — see MAX_OUTPUT_TOKENS above.
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    thinkingConfig: {
      thinkingLevel: ThinkingLevel.LOW,
      includeThoughts: false,
    },
  };
}

/**
 * Extracted tool call from Gemini response
 */
export interface GeminiToolCall {
  name: string;
  args: Record<string, unknown>;
}

/**
 * Token usage metadata from Gemini API
 *
 * thoughtsTokenCount is separate from candidatesTokenCount: with thinking
 * enabled, reasoning tokens are billed but don't appear in the visible
 * output. totalTokenCount may exceed prompt + candidates + thoughts when
 * the model adds tool-use prompt tokens we don't track separately here.
 */
export interface GeminiUsageMetadata {
  promptTokenCount: number;
  candidatesTokenCount: number;
  thoughtsTokenCount: number;
  totalTokenCount: number;
}

/**
 * Response from Gemini with raw payload preserved
 */
export interface GeminiResponse {
  /** Visible text content for display */
  text: string;
  /** Tool calls made by the model */
  toolCalls: GeminiToolCall[];
  /** Raw API response for storage - includes thought signatures */
  rawPayload: Content;
  /** Whether this response contains thinking parts */
  hasThinking: boolean;
  /** Token usage metadata */
  usage?: GeminiUsageMetadata;
  /** Duration in milliseconds */
  durationMs?: number;
  /**
   * Final finishReason the provider reported (e.g. 'STOP', 'MAX_TOKENS', 'SAFETY'),
   * normalized to exclude FINISH_REASON_UNSPECIFIED. Lets callers tell a deliberate
   * empty completion apart from a blocked or capped one (issue #60). Only set on the
   * streaming path; undefined for parseResponse (non-streaming callGemini).
   */
  finishReason?: string;
}

/**
 * Options for Gemini call
 */
export interface GeminiCallOptions {
  /** System instruction/prompt */
  systemPrompt?: string;
  /** Conversation history */
  history?: Content[];
  /** Enable tool usage */
  tools?: Tool[];
  /**
   * Optional per-call overall timeout in ms (issue #49). The effective deadline is
   * `min(GEMINI_TIMEOUT_MS, timeoutMs)`, so a caller (e.g. the facilitator's request
   * budget) can bound a single Gemini call more tightly than the 3-minute default.
   * When set, `streamGemini` also wires an `AbortController` into the request so the
   * underlying stream is cancelled when the deadline elapses. Omit for default behavior.
   */
  timeoutMs?: number;
  /**
   * Optional per-call model override (issue #70). Replaces config.gemini.model as the
   * PRIMARY model for this call — the retry/fallback plumbing then composes around it
   * unchanged, so overriding to config.gemini.fallbackModel automatically disables the
   * 429 fast-failover (fallback === primary for that call). No longer used by the
   * facilitator's empty-final ladder (#79 escalates to Inkling instead of a second
   * Vertex pool); kept for future per-call routing. Omit for the configured default.
   */
  model?: string;
  /** Streaming callback for text chunks */
  onTextChunk?: (text: string) => void | Promise<void>;
  /** Callback for thinking parts (for logging, not display) */
  onThinkingPart?: (thought: string) => void | Promise<void>;
}

/**
 * Stream event types for real-time streaming
 */
export type GeminiStreamEvent =
  | { type: 'text'; data: string }
  | { type: 'tool_call'; data: GeminiToolCall }
  | { type: 'thinking'; data: string }
  | { type: 'done'; response: GeminiResponse }
  | { type: 'error'; error: Error };

/**
 * Wrap a promise with a timeout
 */
function withTimeout<T>(promise: Promise<T>, ms: number, operation: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${operation} timed out after ${ms / 1000}s`)), ms)
    ),
  ]);
}

// Retry config for transient Vertex/Gemini failures. On Vertex on-demand
// (Dynamic Shared Quota), 429 RESOURCE_EXHAUSTED means the shared capacity pool
// is momentarily congested, not that a fixed project quota was exhausted — these
// clear within seconds. We also retry 503 UNAVAILABLE, 500 INTERNAL, and
// transient network failures. We do NOT retry 4xx like 400 INVALID_ARGUMENT
// (e.g. an expired API key) because retrying cannot help.
const MAX_RETRIES = 3; // up to 4 attempts total
const RETRY_BASE_DELAY_MS = 500; // backoff schedule: 0.5s, 1s, 2s (~3.5s total before fallback)
const RETRY_MAX_DELAY_MS = 8000;

// Bounded retries for the fallback model on a 429 (issue #44). The fallback is the
// last resort — there is no further model to fail over to — so we let a transient
// 429 in its (separate) capacity pool clear with a couple of backoff retries, but
// keep it strictly bounded so a fully-congested path returns a clean error rather
// than hanging. Only 429s are retried here; other errors surface on the first
// fallback attempt, preserving the issue #41 single-attempt truncation behavior.
const FALLBACK_MAX_RETRIES = 2; // up to 3 fallback attempts on 429

// How much visible text to buffer before streaming it live to the caller (issue
// #41). A silent Vertex truncation emits only a tiny fragment (usually "}") with
// no finishReason, so holding back the first few tokens lets us discard-and-retry
// it invisibly. A real answer crosses this threshold (or ends with a finishReason)
// within a token or two, so streaming stays near-real-time. Kept small to add at
// most a couple of tokens of latency before the first visible byte.
const STREAM_GATE_CHARS = 32;

// The wire value Vertex sends for "no real finish reason"; treated as absent.
const FINISH_REASON_UNSPECIFIED = 'FINISH_REASON_UNSPECIFIED';

/**
 * Thrown when a Gemini stream closes silently mid-response (issue #41): the SDK
 * iterator simply ends — no thrown error, no usageMetadata, no finishReason —
 * after emitting only a stray fragment. This is the Vertex Dynamic-Shared-Quota
 * "silent close" variant that Fix #37's error-based retry could not see. It is
 * retryable: because the fragment was buffered and never delivered, re-running
 * the call from clean accumulators can never duplicate output.
 */
export class TruncatedStreamError extends Error {
  constructor(fragment: string) {
    const preview = fragment.length > 40 ? `${fragment.slice(0, 40)}…` : fragment;
    super(
      `Gemini stream closed with no finishReason after emitting ${fragment.length} char(s)` +
        (fragment.length > 0 ? `: ${JSON.stringify(preview)}` : ' (empty)')
    );
    this.name = 'TruncatedStreamError';
  }
}

function isRetryableError(error: unknown): boolean {
  if (error instanceof TruncatedStreamError) return true;
  const err = error as { status?: number | string; code?: number; message?: string };
  const numericStatus =
    typeof err?.status === 'number' ? err.status : typeof err?.code === 'number' ? err.code : undefined;
  if (numericStatus === 429 || numericStatus === 500 || numericStatus === 503) return true;
  const msg = err?.message ?? String(error);
  return /RESOURCE_EXHAUSTED|UNAVAILABLE|\bINTERNAL\b|"code":\s*(429|500|503)|fetch failed|\bterminated\b/i.test(
    msg
  );
}

/**
 * Narrow predicate for a 429 / RESOURCE_EXHAUSTED specifically (issue #44).
 *
 * A 429 on Vertex Dynamic Shared Quota means the targeted model's shared-capacity
 * pool is exhausted *right now* — retrying the SAME model just burns latency. The
 * fallback model draws on a separate pool, so the fast path to a real answer is to
 * fail over immediately rather than backoff-retry the primary. This is deliberately
 * a strict subset of isRetryableError: other transient classes (500/503/network/
 * TruncatedStreamError) are NOT 429s and keep the existing primary-retry behavior.
 */
function isResourceExhausted(error: unknown): boolean {
  if (error instanceof TruncatedStreamError) return false;
  const err = error as { status?: number | string; code?: number; message?: string };
  const numericStatus =
    typeof err?.status === 'number' ? err.status : typeof err?.code === 'number' ? err.code : undefined;
  if (numericStatus === 429) return true;
  const msg = err?.message ?? String(error);
  return /RESOURCE_EXHAUSTED|"code":\s*429/i.test(msg);
}

/** Exponential backoff with jitter for retry attempt `attemptNum` (0-based). */
function backoffDelayMs(attemptNum: number): number {
  const base = Math.min(RETRY_MAX_DELAY_MS, RETRY_BASE_DELAY_MS * 2 ** attemptNum);
  return base + Math.floor(Math.random() * 0.3 * base);
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run a Gemini establishment call with retry + model fallback.
 *
 * Tries the primary model (config.gemini.model) up to MAX_RETRIES+1 times with
 * exponential backoff on transient errors. If every primary attempt fails with a
 * retryable error, makes one final attempt against the fallback model
 * (config.gemini.fallbackModel), which draws on a separate Vertex capacity pool
 * and so can succeed when the primary is congested.
 *
 * `operation` receives the model id to target, and wraps request establishment
 * (before any tokens stream), so retrying or falling back never duplicates output.
 */
async function withRetry<T>(
  operation: (model: string) => Promise<T>,
  label: string,
  // Per-call primary override (issue #70); see GeminiCallOptions.model.
  primaryOverride?: string
): Promise<T> {
  const primary = primaryOverride ?? config.gemini.model;
  const fallback = config.gemini.fallbackModel;
  let lastError: unknown;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await operation(primary);
    } catch (error) {
      lastError = error;
      if (!isRetryableError(error)) {
        throw error;
      }
      if (attempt < MAX_RETRIES) {
        const backoff = Math.min(RETRY_MAX_DELAY_MS, RETRY_BASE_DELAY_MS * 2 ** attempt);
        const delay = backoff + Math.floor(Math.random() * 0.3 * backoff);
        console.warn(
          `[gemini] ${label}: transient error on ${primary} (attempt ${attempt + 1}/${MAX_RETRIES + 1}), retrying in ${delay}ms — ${
            (error as Error)?.message?.slice(0, 140) ?? error
          }`
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  // Primary exhausted on transient errors — last resort: try the fallback model.
  if (fallback && fallback !== primary) {
    console.warn(
      `[gemini] ${label}: ${primary} exhausted after ${MAX_RETRIES + 1} attempts, falling back to ${fallback}`
    );
    try {
      return await operation(fallback);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

/**
 * Establish a streaming Gemini call and consume it, with retry + model fallback
 * that also covers mid-stream failures — but ONLY before the first token reaches
 * the caller (issue #37).
 *
 * This retries the primary on transient errors (503/500/network/TruncatedStreamError)
 * with exponential backoff and, once the primary is exhausted, falls over to the
 * fallback model. The retried unit is the whole establish→consume cycle (not just
 * establishment): Vertex on Dynamic Shared Quota can accept the request and then 429
 * *during* the first chunk pull, so wrapping only establishment let that mid-stream
 * 429 escape retry/fallback and surface to the user (issue #37).
 *
 * A 429 / RESOURCE_EXHAUSTED is special-cased (issue #44): when one occurs before any
 * token has reached the caller, we DON'T backoff-retry the primary — its shared pool
 * is exhausted now, so we fail over to the fallback model's separate pool immediately.
 * The fallback then gets a bounded retry on a 429 (never unbounded — a fully-congested
 * path returns a clean error, never hangs). Other transient classes keep the existing
 * primary backoff-retry behavior unchanged.
 *
 * `emit` forwards each event to the caller and returns whether it actually
 * reached the caller. The first delivered event locks the stream: any error
 * after that is rethrown as-is and never retried, because retrying would
 * duplicate already-delivered output. We key the lock on real delivery (not on
 * merely seeing a part) so that, e.g., a thought or tool_call that a callback
 * consumer never surfaces does not lock out a still-safe retry — matching the
 * issue's "before any token reaches the caller". Because we only retry while
 * nothing has been delivered, each attempt starts from clean accumulators — no
 * partial output can leak across a retry.
 */
async function streamWithRetry(
  startTime: number,
  label: string,
  openStream: (model: string) => ReturnType<Chat['sendMessageStream']>,
  emit: (event: GeminiStreamEvent) => boolean | Promise<boolean>,
  // Per-call primary override (issue #70); see GeminiCallOptions.model.
  primaryOverride?: string
): Promise<GeminiResponse> {
  const primary = primaryOverride ?? config.gemini.model;
  const fallback = config.gemini.fallbackModel;
  // The fallback only buys us anything when it's a DIFFERENT model — it draws on a
  // separate Vertex capacity pool. GEMINI_FALLBACK_MODEL defaults to the same value
  // as GEMINI_MODEL (lib/config.ts), so this is commonly false; the 429 fast-failover
  // (issue #44) is gated on it so a no-distinct-fallback config keeps the bounded
  // primary retries instead of failing after a single attempt.
  const hasDistinctFallback = !!fallback && fallback !== primary;
  let emitted = false;
  let lastError: unknown;

  // Forward an event and lock retry only if it actually reached the caller.
  const deliver = async (event: GeminiStreamEvent): Promise<void> => {
    if (await emit(event)) emitted = true;
  };

  const attempt = async (model: string): Promise<GeminiResponse> => {
    const stream = await openStream(model);

    let fullText = '';
    const allParts: Part[] = [];
    const toolCalls: GeminiToolCall[] = [];
    let hasThinking = false;
    let lastActivityTime = Date.now();
    let finalContent: Content | undefined;
    let finalUsage: GeminiUsageMetadata | undefined;
    let sawFinishReason = false;
    let finishReason: string | undefined;

    // Gated buffering (issue #41). A Vertex Dynamic-Shared-Quota capacity cut can
    // arrive as a SILENT mid-stream close: the iterator just ends — no thrown
    // error, no usageMetadata, no finishReason — after the model emitted only a
    // stray fragment (usually "}"). To recover invisibly we must not hand that
    // fragment to the caller (doing so locks retry and persists a "}"). So every
    // event is held in `pending` until the stream proves non-degenerate, then
    // flushed in order and streamed live. The gate opens as soon as ANY of:
    //   - a real finishReason arrives — every deliberate stop (STOP/MAX_TOKENS/
    //     SAFETY/RECITATION/…) sets one, so those are delivered and never retried;
    //   - the model makes a tool call (a real, non-degenerate action);
    //   - buffered visible text passes STREAM_GATE_CHARS (a real answer in flight;
    //     the small buffer keeps streaming near-real-time for the normal case).
    // Flushing replays the buffered events unchanged and in order, so the bytes a
    // client sees are identical to today — only the first few are momentarily held.
    const pending: GeminiStreamEvent[] = [];
    let gateOpen = false;

    // Repetition guard state (issue #51): next fullText length at which to run
    // the periodic-tail check, and whether the guard cut this stream early.
    let nextRepetitionCheckAt = REPETITION_MIN_CHARS;
    let repetitionCut = false;

    const openGate = async (): Promise<void> => {
      if (gateOpen) return;
      gateOpen = true;
      for (const event of pending) await deliver(event);
      pending.length = 0;
    };

    const emitOrBuffer = async (event: GeminiStreamEvent): Promise<void> => {
      if (gateOpen) {
        await deliver(event);
      } else {
        pending.push(event);
      }
    };

    for await (const chunk of stream) {
      const now = Date.now();
      if (now - lastActivityTime > CHUNK_TIMEOUT_MS) {
        throw new Error(`No response from Gemini for ${CHUNK_TIMEOUT_MS / 1000}s - possible hang`);
      }
      lastActivityTime = now;

      const candidate = chunk.candidates?.[0];
      if (candidate?.finishReason && String(candidate.finishReason) !== FINISH_REASON_UNSPECIFIED) {
        sawFinishReason = true;
        finishReason = String(candidate.finishReason);
      }
      if (candidate?.content?.parts) {
        for (const part of candidate.content.parts) {
          allParts.push(part);

          if (part.text && !part.thought) {
            fullText += part.text;
            await emitOrBuffer({ type: 'text', data: part.text });

            // Repetition guard (issue #51): once past the floor, periodically test
            // the tail for a degenerate verbatim loop and cut the stream early.
            if (fullText.length >= nextRepetitionCheckAt) {
              nextRepetitionCheckAt = fullText.length + REPETITION_CHECK_EVERY_CHARS;
              if (hasDegenerateRepetitionTail(fullText)) {
                repetitionCut = true;
                break;
              }
            }
          }

          if (part.thought === true && part.text) {
            hasThinking = true;
            await emitOrBuffer({ type: 'thinking', data: part.text });
          }

          if (part.thoughtSignature) {
            hasThinking = true;
          }

          if (part.functionCall) {
            const toolCall: GeminiToolCall = {
              name: part.functionCall.name ?? '',
              args: (part.functionCall.args as Record<string, unknown>) ?? {},
            };
            toolCalls.push(toolCall);
            await emitOrBuffer({ type: 'tool_call', data: toolCall });
          }
        }
        // Last chunk wins for the final content + usage snapshot
        finalContent = candidate.content;
      }

      const u = toUsage(chunk);
      if (u) finalUsage = u;

      // Open the gate the moment the response proves it is not a degenerate
      // fragment, then stream everything buffered so far (and the rest) live.
      if (!gateOpen && (sawFinishReason || toolCalls.length > 0 || fullText.length >= STREAM_GATE_CHARS)) {
        await openGate();
      }

      // Repetition cut (issue #51): stop pulling chunks. Exiting the for-await
      // closes the SDK iterator (and, on the streamGemini path, the finally-block
      // AbortController cancels the request). This is a NORMAL completion, not an
      // error: text already reached the caller, so throwing would either trip the
      // retry path or surface a spurious failure after a mostly-delivered answer.
      if (repetitionCut) break;
    }

    if (repetitionCut) {
      // fullText length is not PII; never log the text itself.
      const summary = { label, chars: fullText.length, toolCalls: toolCalls.length };
      console.warn('[gemini] repetition loop detected — stream cut early (issue #51)', summary);
      Sentry.addBreadcrumb({
        category: 'gemini',
        level: 'warning',
        message: 'repetition loop detected — stream cut early (issue #51)',
        data: summary,
      });
    }

    // Stream ended without ever proving non-degenerate: a silent mid-stream
    // truncation — no finishReason, only a stray fragment. Nothing reached the
    // caller, so throw a retryable error and let the loop/fallback recover.
    if (!gateOpen) {
      throw new TruncatedStreamError(fullText);
    }

    return {
      text: fullText,
      toolCalls,
      rawPayload: streamRawPayload(finalContent, allParts),
      hasThinking,
      usage: finalUsage,
      durationMs: Date.now() - startTime,
      finishReason,
    };
  };

  for (let attemptNum = 0; attemptNum <= MAX_RETRIES; attemptNum++) {
    try {
      return await attempt(primary);
    } catch (error) {
      lastError = error;
      // Once any output has reached the caller, surface the error as-is —
      // retrying would duplicate already-delivered tokens.
      if (emitted || !isRetryableError(error)) throw error;
      // Fast-failover on 429 (issue #44): a RESOURCE_EXHAUSTED means the primary's
      // shared-capacity pool is exhausted now, so backoff-retrying the same model is
      // wasted latency — IF a distinct fallback (separate pool) is available, skip
      // the remaining primary retries and fail over to it immediately. With no
      // distinct fallback there is nowhere faster to go, so we fall through to the
      // bounded primary backoff-retries (a shared-quota 429 typically clears in
      // seconds), preserving the pre-#44 behavior for that config.
      if (isResourceExhausted(error) && hasDistinctFallback) {
        console.warn(
          `[gemini] ${label}: 429 on ${primary} before first token — skipping primary retries, failing over to ${fallback}`
        );
        break;
      }
      if (attemptNum < MAX_RETRIES) {
        const delay = backoffDelayMs(attemptNum);
        console.warn(
          `[gemini] ${label}: transient error before first token on ${primary} (attempt ${attemptNum + 1}/${MAX_RETRIES + 1}), retrying in ${delay}ms — ${
            (error as Error)?.message?.slice(0, 140) ?? error
          }`
        );
        await sleep(delay);
      }
    }
  }

  // Primary exhausted (or fast-failed on a 429) with nothing emitted yet — last
  // resort: the fallback model's separate capacity pool. It gets a BOUNDED retry on
  // a 429 so a momentary blip in its own pool can clear, but never more than
  // FALLBACK_MAX_RETRIES so a fully-congested path returns a clean error instead of
  // hanging (issue #44). Non-429 errors surface on the first fallback attempt,
  // preserving the issue #41 single-attempt truncation/fallback behavior.
  if (!emitted && hasDistinctFallback) {
    console.warn(`[gemini] ${label}: falling back to ${fallback}`);
    for (let attemptNum = 0; attemptNum <= FALLBACK_MAX_RETRIES; attemptNum++) {
      try {
        return await attempt(fallback);
      } catch (error) {
        lastError = error;
        if (emitted || !isRetryableError(error)) throw error;
        // Only a 429 is worth retrying on the fallback; anything else surfaces now.
        if (!isResourceExhausted(error) || attemptNum >= FALLBACK_MAX_RETRIES) throw error;
        const delay = backoffDelayMs(attemptNum);
        console.warn(
          `[gemini] ${label}: 429 on fallback ${fallback} (attempt ${attemptNum + 1}/${FALLBACK_MAX_RETRIES + 1}), retrying in ${delay}ms`
        );
        await sleep(delay);
      }
    }
  }
  throw lastError;
}

/**
 * Extract text content from parts, filtering out thinking parts for display
 */
function extractDisplayText(parts: Part[]): string {
  const textParts: string[] = [];

  for (const part of parts) {
    // Standard text parts (non-thought)
    if (part.text && !part.thought) {
      textParts.push(part.text);
    }
    // Skip thinking parts — they're in rawPayload for signature preservation
  }

  return textParts.join('');
}

/**
 * Extract tool calls from parts
 */
function extractToolCalls(parts: Part[]): GeminiToolCall[] {
  const toolCalls: GeminiToolCall[] = [];

  for (const part of parts) {
    if (part.functionCall) {
      toolCalls.push({
        name: part.functionCall.name ?? '',
        args: (part.functionCall.args as Record<string, unknown>) ?? {},
      });
    }
  }

  return toolCalls;
}

/**
 * Check if response contains thinking parts (either inline thoughts or signatures)
 */
function hasThinkingParts(parts: Part[]): boolean {
  return parts.some((part) => part.thought === true || !!part.thoughtSignature);
}

/**
 * Build a Content object from a list of parts (used for response.rawPayload)
 */
function partsToModelContent(parts: Part[]): Content {
  return { role: 'model', parts };
}

/**
 * Build the rawPayload Content for a streamed response (issue #83).
 *
 * `finalContent` is the LAST chunk's candidate.content ("last chunk wins") and is
 * kept verbatim to preserve thought signatures. But when the model emits a
 * functionCall in an earlier chunk and then a trailing content/thought chunk,
 * last-chunk-wins drops the functionCall from the stored payload — the model turn
 * replayed as history then shows a functionResponse with no preceding functionCall,
 * corrupting tool-round history for every continuation and retry.
 *
 * `allParts` accumulates every part of every chunk in exact arrival order,
 * INCLUDING the final chunk's parts as its tail (same object references). So when
 * a functionCall would be dropped, substituting `allParts` as the part list IS the
 * merge of the dropped part(s) into the final content: arrival order — and with it
 * thoughtSignature-to-part attachment and ordering — is exactly preserved. When no
 * functionCall is missing (the common single-chunk case), `finalContent` is
 * returned unchanged, by identity, so the primary path's signature handling is
 * untouched.
 */
function streamRawPayload(finalContent: Content | undefined, allParts: Part[]): Content {
  if (!finalContent) return partsToModelContent(allParts);
  const finalCallCount = (finalContent.parts ?? []).filter((p) => p.functionCall).length;
  const allCallCount = allParts.filter((p) => p.functionCall).length;
  // finalContent's parts are a suffix of allParts, so a strictly greater count in
  // allParts means an earlier chunk's functionCall is absent from finalContent.
  if (allCallCount <= finalCallCount) return finalContent;
  return { ...finalContent, parts: allParts };
}

/**
 * Parse a non-streaming response into GeminiResponse format
 */
function parseResponse(response: GenerateContentResponse): GeminiResponse {
  const candidate = response.candidates?.[0];

  if (!candidate || !candidate.content) {
    return {
      text: '',
      toolCalls: [],
      rawPayload: { role: 'model', parts: [] },
      hasThinking: false,
    };
  }

  const parts = candidate.content.parts ?? [];

  return {
    text: extractDisplayText(parts),
    toolCalls: extractToolCalls(parts),
    rawPayload: candidate.content, // Preserve exact format with thought signatures
    hasThinking: hasThinkingParts(parts),
  };
}

/**
 * Convert GenerateContentResponse usageMetadata to our GeminiUsageMetadata shape.
 */
function toUsage(response: GenerateContentResponse): GeminiUsageMetadata | undefined {
  const um = response.usageMetadata;
  if (!um) return undefined;
  return {
    promptTokenCount: um.promptTokenCount ?? 0,
    candidatesTokenCount: um.candidatesTokenCount ?? 0,
    thoughtsTokenCount: um.thoughtsTokenCount ?? 0,
    totalTokenCount: um.totalTokenCount ?? 0,
  };
}

/**
 * Call Gemini model (non-streaming)
 *
 * @param message - User message
 * @param options - Call options
 * @returns Response with text, tool calls, and raw payload
 */
export async function callGemini(
  message: string,
  options: GeminiCallOptions = {}
): Promise<GeminiResponse> {
  const ai = getClient();

  const response = await withRetry((model) => {
    const chat: Chat = ai.chats.create({
      model,
      config: buildConfig(options),
      history: options.history ?? [],
    });
    return chat.sendMessage({ message });
  }, 'callGemini', options.model);
  return parseResponse(response);
}

/**
 * Call Gemini model with streaming
 *
 * @param message - User message
 * @param options - Call options including streaming callbacks
 * @returns Response with text, tool calls, raw payload, and usage metrics
 */
export async function callGeminiStreaming(
  message: string,
  options: GeminiCallOptions = {}
): Promise<GeminiResponse> {
  const startTime = Date.now();
  const ai = getClient();

  // Returns true when the chunk actually reaches the caller (a callback fired),
  // which is what locks retry. Tool calls and unsubscribed thoughts are only
  // aggregated into the return value, so they don't lock a still-safe retry.
  const emit = async (event: GeminiStreamEvent): Promise<boolean> => {
    if (event.type === 'text' && options.onTextChunk) {
      await options.onTextChunk(event.data);
      return true;
    }
    if (event.type === 'thinking' && options.onThinkingPart) {
      await options.onThinkingPart(event.data);
      return true;
    }
    return false;
  };

  const streamingOperation = (): Promise<GeminiResponse> =>
    streamWithRetry(
      startTime,
      'callGeminiStreaming',
      (model) => {
        const chat: Chat = ai.chats.create({
          model,
          config: buildConfig(options),
          history: options.history ?? [],
        });
        return chat.sendMessageStream({ message });
      },
      emit,
      options.model
    );

  return await withTimeout(streamingOperation(), GEMINI_TIMEOUT_MS, 'Gemini streaming call');
}

/**
 * Stream Gemini response with real-time event delivery
 *
 * Uses an async queue pattern to yield events as they arrive from Gemini,
 * enabling true real-time streaming to the frontend.
 *
 * @param message - User message
 * @param options - Call options (onTextChunk/onThinkingPart are ignored - use yielded events)
 * @yields GeminiStreamEvent - text chunks, tool calls, and completion events
 */
export async function* streamGemini(
  message: string,
  options: Omit<GeminiCallOptions, 'onTextChunk' | 'onThinkingPart'> = {}
): AsyncGenerator<GeminiStreamEvent, void, unknown> {
  const startTime = Date.now();
  const ai = getClient();

  // Per-call overall deadline (issue #49). The effective deadline is the tighter of the
  // client-wide GEMINI_TIMEOUT_MS and an optional caller-supplied timeoutMs, so the
  // facilitator's request budget can bound each Gemini call. The consumer-loop deadline
  // below is the primary guarantee that the *response* returns within this window (even if
  // the background stream keeps retrying). When timeoutMs is set we ALSO wire an
  // AbortController into the SDK request so the underlying stream is truly cancelled, not
  // left hanging. When timeoutMs is omitted, no controller is created and behavior is
  // identical to before (effectiveTimeoutMs === GEMINI_TIMEOUT_MS).
  const effectiveTimeoutMs = Math.min(GEMINI_TIMEOUT_MS, options.timeoutMs ?? GEMINI_TIMEOUT_MS);
  const abortController = options.timeoutMs !== undefined ? new AbortController() : undefined;
  const abortTimer = abortController
    ? setTimeout(() => abortController.abort(), effectiveTimeoutMs)
    : undefined;

  // Async queue for streaming events
  const queue: GeminiStreamEvent[] = [];
  let streamDone = false;
  let resolver: (() => void) | null = null;
  let streamError: Error | null = null;

  const notify = () => {
    if (resolver) {
      resolver();
      resolver = null;
    }
  };

  // Start streaming in background. streamWithRetry handles mid-stream retry +
  // fallback before the first event is queued; once an event is queued it locks,
  // so the queue can never receive duplicate output from a retry.
  const streamPromise = (async (): Promise<GeminiResponse> => {
    try {
      const response = await streamWithRetry(
        startTime,
        'streamGemini',
        (model) => {
          const chat: Chat = ai.chats.create({
            model,
            // The chat-level config applies to every request in the session unless a
            // per-request config overrides it; sendMessageStream below passes none, so
            // this abortSignal governs the actual request (issue #49).
            config: abortController
              ? { ...buildConfig(options), abortSignal: abortController.signal }
              : buildConfig(options),
            history: options.history ?? [],
          });
          return chat.sendMessageStream({ message });
        },
        (event) => {
          // Every event is yielded to the consumer, so each one locks retry.
          queue.push(event);
          notify();
          return true;
        },
        options.model
      );

      queue.push({ type: 'done', response });
      streamDone = true;
      notify();

      return response;
    } catch (error) {
      streamError = error instanceof Error ? error : new Error(String(error));
      queue.push({ type: 'error', error: streamError });
      streamDone = true;
      notify();
      throw streamError;
    }
  })();

  // The background streamPromise rejects on error and surfaces it via the queued
  // 'error' event. Every exit path of this generator — normal completion, a thrown
  // error event, the timeout/deadline throws, or an early consumer return — must
  // leave streamPromise handled, or Node raises an unhandledRejection. A single
  // finally guard covers them all (issue #37); previously only the timeout paths
  // attached the guard, so the normal-error path leaked.
  try {
    // Yield events from queue as they arrive
    while (!streamDone || queue.length > 0) {
      while (queue.length > 0) {
        const event = queue.shift()!;
        if (event.type === 'error') {
          throw event.error;
        }
        yield event;
      }

      if (!streamDone && queue.length === 0) {
        // Wall-clock safety net. The background reader can block forever if Gemini
        // stops sending chunks without closing the stream (a hang) — the in-loop
        // CHUNK_TIMEOUT check above only fires when a *new* chunk arrives, so it
        // can't catch a true stall. Here we race the next-event signal against a
        // gap timeout (no new event for CHUNK_TIMEOUT_MS) and an overall deadline,
        // so the user's request can never wait indefinitely.
        const overallRemaining = startTime + effectiveTimeoutMs - Date.now();
        if (overallRemaining <= 0) {
          throw new Error(`Gemini stream exceeded ${Math.round(effectiveTimeoutMs / 1000)}s overall deadline`);
        }
        const waitMs = Math.min(CHUNK_TIMEOUT_MS, overallRemaining);
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timedOut = await new Promise<boolean>((resolve) => {
          resolver = () => resolve(false);
          timer = setTimeout(() => resolve(true), waitMs);
        });
        if (timer) clearTimeout(timer);
        if (timedOut) {
          // Distinguish "the whole call's deadline elapsed" from a mid-stream chunk gap.
          // With a small caller timeoutMs the former is what fires; the default path
          // (effectiveTimeoutMs === GEMINI_TIMEOUT_MS) still reports the chunk-gap hang.
          if (Date.now() - startTime >= effectiveTimeoutMs) {
            throw new Error(`Gemini stream exceeded ${Math.round(effectiveTimeoutMs / 1000)}s overall deadline`);
          }
          throw new Error(`No response from Gemini for ${Math.round(waitMs / 1000)}s - possible hang`);
        }
      }
    }

    await streamPromise;
  } finally {
    // Stop the abort timer and cancel any still-in-flight request on every exit path
    // (normal completion, thrown error, deadline, or early consumer return) so a bounded
    // call never leaves a dangling Gemini socket (issue #49). abort() after completion is
    // a harmless no-op.
    if (abortTimer) clearTimeout(abortTimer);
    abortController?.abort();
    // Guard on ALL exit paths so the orphaned background reader can never become
    // an unhandledRejection — its error already surfaced via the queued event.
    void streamPromise.catch(() => undefined);
  }
}

/**
 * Build conversation history from stored messages
 *
 * Uses rawPayload when available (for thought signature preservation),
 * falls back to content for legacy messages.
 */
export function buildHistoryFromMessages(
  messages: Array<{
    role: 'user' | 'assistant';
    content: string;
    rawPayload?: Content | null;
  }>
): Content[] {
  return messages.map((msg) => {
    if (msg.role === 'assistant' && msg.rawPayload) {
      return msg.rawPayload;
    }

    return {
      role: msg.role === 'user' ? 'user' : 'model',
      parts: [{ text: msg.content }],
    };
  });
}

/**
 * Continue a chat with a tool result
 *
 * After executing a tool, use this to send the result back to Gemini and
 * continue the conversation. Streams internally and returns aggregated response.
 */
export async function continueWithToolResult(
  toolName: string,
  toolResult: unknown,
  history: Content[],
  options: GeminiCallOptions = {}
): Promise<GeminiResponse> {
  const startTime = Date.now();
  const ai = getClient();

  // Tool result is a "user"-role Content carrying a functionResponse part.
  const toolResultContent: Content = {
    role: 'user',
    parts: [
      {
        functionResponse: {
          name: toolName,
          response: toolResult as Record<string, unknown>,
        },
      },
    ],
  };

  // Returns true when the chunk actually reaches the caller (a callback fired),
  // which is what locks retry. Tool calls and unsubscribed thoughts are only
  // aggregated into the return value, so they don't lock a still-safe retry.
  const emit = async (event: GeminiStreamEvent): Promise<boolean> => {
    if (event.type === 'text' && options.onTextChunk) {
      await options.onTextChunk(event.data);
      return true;
    }
    if (event.type === 'thinking' && options.onThinkingPart) {
      await options.onThinkingPart(event.data);
      return true;
    }
    return false;
  };

  const streamingOperation = (): Promise<GeminiResponse> =>
    streamWithRetry(
      startTime,
      'continueWithToolResult',
      (model) => {
        const chat: Chat = ai.chats.create({
          model,
          config: buildConfig(options),
          history: [...history, toolResultContent],
        });
        // Explicit directive, not an empty message, to continue after the tool
        // result (issue #73): the empty user turn is the trigger for flash's
        // thoughts-only empty completions under load.
        return chat.sendMessageStream({ message: TOOL_CONTINUATION_DIRECTIVE });
      },
      emit,
      options.model
    );

  return await withTimeout(streamingOperation(), GEMINI_TIMEOUT_MS, 'Gemini tool result call');
}
