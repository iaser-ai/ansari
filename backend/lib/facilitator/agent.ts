/**
 * Facilitator Agent using Gemini 3 Flash (Spec 0004)
 *
 * Ported from Claude to Gemini with:
 * - Real-time streaming via streamGemini async generator
 * - Tool calls via functionCall/functionResponse
 * - Same streaming event interface for frontend compatibility
 */
import * as Sentry from '@sentry/nextjs';
import {
  streamGemini,
  type Content,
  type GeminiToolCall,
  type GeminiResponse,
  type GeminiStreamEvent,
  type GeminiUsageMetadata,
} from '../ai/gemini-client';
import { FACILITATOR_SYSTEM_PROMPT } from '../ai/prompts/facilitator';
import { createToolMap, getGeminiToolDescriptions } from '../tools';
import type { ToolResult } from '../tools/types';
import { unavailableResult, reportDegradedTool, toolLabel } from '../tools/resilience';
import type { ContentBlock } from '@/db/schema/messages';

// Maximum iterations to prevent infinite loops
const MAX_ITERATIONS = 10;
const MAX_CONSECUTIVE_SAME_TOOL = 3;
const MAX_TOTAL_TOOL_CALLS = 10;

// Overall request-time budget (Spec 49). The count caps above and the per-step timeouts
// below the loop (#54 per-tool cap, #45/#42/#37 per-Gemini-call retry/failover) each bound
// an individual unit of work; this bounds the AGGREGATE so a degraded provider can never make
// a request grind past the frontend timeout and drop silently (persist happens only on the
// `done` event). Env-overridable; runFacilitator also takes a per-call override for tests.
function envBudgetMs(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
/** Hard wall-clock cap for a whole facilitator request (must stay < the frontend timeout). */
export const FACILITATOR_REQUEST_BUDGET_MS = envBudgetMs('FACILITATOR_REQUEST_BUDGET_MS', 120_000);
/** Reserve carved out of the budget for the final synthesis pass (soft deadline = budget - reserve). */
export const FACILITATOR_SYNTHESIS_RESERVE_MS = envBudgetMs('FACILITATOR_SYNTHESIS_RESERVE_MS', 25_000);

// Fail-fast on degradation (Spec 49, T1). Once this many tool calls in a request have returned
// #54's degraded ("temporarily unavailable") result, stop gathering and synthesize — so a real
// outage exits in ~20–30s instead of grinding to the 120s wall-clock backstop (T2). Time alone
// cannot separate slow-but-healthy (p99 ~75s) from degraded; this keys off #54's marker instead.
const T1_DEGRADED_THRESHOLD = 2;

// Appended to the system prompt for the final, tools-disabled synthesis pass. Delivered via
// systemPrompt (NOT a new user message) so it can never break Gemini's user/model alternation
// after the user-role functionResponse parts already in history.
const SYNTHESIS_DIRECTIVE =
  'You have run out of time to gather more sources. Using ONLY the information already ' +
  'gathered above, give the best answer you can right now. If some sources could not be ' +
  'consulted, briefly note that. Do not call any tools. Do not invent citations.';

// User-facing message when even the best-effort synthesis cannot produce a usable answer.
// A clean bounded error — never a raw internal error string, never a silent close.
const BUDGET_ERROR_MESSAGE = 'This is taking longer than expected. Please try again.';

// Empty-final-completion handling (issue #60). Vertex's degraded-completion family can
// finish a call with a real finishReason=STOP and zero visible text. The #42 rule (never
// retry after a finishReason) exists to avoid duplicating tokens already delivered to the
// client — in the empty case nothing was delivered, so ONE bounded retry duplicates
// nothing. Non-STOP empties are NOT retried: SAFETY = blocked (a retry would likely
// re-block), MAX_TOKENS = the thinking budget consumed the output cap (a config bug to
// surface loudly — coordinate cap sizing with issue #51).
const MAX_EMPTY_FINAL_RETRIES = 1;
const EMPTY_ANSWER_ERROR_MESSAGE =
  'The model returned an empty answer. Please try again.';
const SAFETY_BLOCKED_ERROR_MESSAGE =
  'The response was blocked by the provider. Please rephrase your question and try again.';

// Degenerate-fragment detection (issue #66). Beyond a fully empty final (#60), Vertex's
// capacity-cut family can end a turn with a real finishReason and a single trivial token as
// the entire visible text — a lone '}', ']', '.', etc. That is never a valid facilitator
// answer, yet '}'.trim() is non-empty so #60's empty-check waves it through and it ships as a
// completed reply. Scope the guard to avoid false positives on legitimate ultra-short answers
// ("Yes.", "لا", "42"): a fragment is short (< this many chars) AND contains no letter or
// number in ANY script — i.e. punctuation/bracket/symbol only.
const MAX_DEGENERATE_FRAGMENT_LEN = 10;
const LETTER_OR_NUMBER = /[\p{L}\p{N}]/u;

/**
 * Classify a terminal completion's visible text as unusable-as-an-answer, else null.
 * 'empty' = nothing after trim (#60); 'fragment' = a short, letter/number-free token (#66).
 * Both are handled by the same one-bounded-retry-then-explicit-error machinery.
 */
function classifyDegenerateFinal(text: string): 'empty' | 'fragment' | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return 'empty';
  if (trimmed.length < MAX_DEGENERATE_FRAGMENT_LEN && !LETTER_OR_NUMBER.test(trimmed)) {
    return 'fragment';
  }
  return null;
}

/**
 * True once accumulated streamed text has proven it is NOT a degenerate fragment — i.e.
 * `classifyDegenerateFinal(text) === null`. Used to gate LIVE emission (issue #66): a turn's
 * visible text is buffered until this holds, so a turn whose entire text is a trivial
 * punctuation-only fragment is never handed to the client and a subsequent bounded retry can
 * deliver clean output (no stray leading "}") on every surface — including the SSE routes that
 * persist the aggregate of streamed `text` events. Note the empty string is (correctly) not
 * yet "proven": nothing has been emitted, and the classifier will still route it via 'empty'.
 */
function isProvenNonDegenerateText(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length >= MAX_DEGENERATE_FRAGMENT_LEN || LETTER_OR_NUMBER.test(trimmed);
}

export interface Message {
  role: 'user' | 'assistant';
  content: ContentBlock[];
  /** Raw Gemini payload for assistant messages - preserves tool calls and thought signatures */
  rawPayload?: Content | null;
}

interface ToolUsageTracker {
  history: string[];
  callsWithArgs: Array<{ tool: string; args: Record<string, unknown>; id: string }>;
}

/**
 * Check if we should force an answer due to tool limits
 */
function checkToolLimit(tracker: ToolUsageTracker, currentToolName: string): boolean {
  // Check for same tool used 3 times consecutively
  if (tracker.history.length >= MAX_CONSECUTIVE_SAME_TOOL) {
    const lastThree = tracker.history.slice(-MAX_CONSECUTIVE_SAME_TOOL);
    if (lastThree.every((t) => t === currentToolName)) {
      return true;
    }
  }

  // Check for total tool calls
  if (tracker.history.length >= MAX_TOTAL_TOOL_CALLS - 1) {
    return true;
  }

  return false;
}

/**
 * Process a single tool call
 */
async function processToolCall(
  toolName: string,
  toolArgs: Record<string, unknown>,
  tracker: ToolUsageTracker
): Promise<ToolResult> {
  const toolMap = createToolMap();

  // Check if we hit the limit
  if (checkToolLimit(tracker, toolName)) {
    return {
      content: 'Tool usage limit reached. Please synthesize your answer based on gathered information.',
      documents: [
        {
          type: 'document',
          source: {
            type: 'text',
            media_type: 'text/plain',
            data: 'Tool usage limit reached.',
          },
          title: 'Tool Limit Notice',
          context: 'System',
          citations: { enabled: false },
        },
      ],
    };
  }

  // Track tool usage (generate a simple ID since Gemini doesn't use tool IDs)
  const toolId = `tool_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  tracker.history.push(toolName);
  tracker.callsWithArgs.push({ tool: toolName, args: toolArgs, id: toolId });

  // Get the tool
  const tool = toolMap.get(toolName);
  if (!tool) {
    return {
      content: `Unknown tool: ${toolName}`,
      documents: [
        {
          type: 'document',
          source: {
            type: 'text',
            media_type: 'text/plain',
            data: `Unknown tool: ${toolName}`,
          },
          title: 'Error',
          context: 'System',
          citations: { enabled: false },
        },
      ],
    };
  }

  // Execute the tool. Defense-in-depth backstop (Spec 43): the four search tools
  // already catch provider failures and return a degraded result, but if any tool
  // (including a future one) throws, convert it into the unified "temporarily
  // unavailable" result rather than letting it crash or hang the facilitator loop.
  const query = toolArgs.query as string;
  try {
    return await tool.run(query);
  } catch (error) {
    reportDegradedTool({
      tool: toolName,
      provider: 'unknown',
      errorClass: 'network',
      queryLength: typeof query === 'string' ? query.length : 0,
    });
    return unavailableResult(toolLabel(toolName));
  }
}

export interface FacilitatorStreamEvent {
  type: 'text' | 'tool_use' | 'tool_result' | 'done' | 'error';
  data: string;
  /** Set on the final 'done' event: token usage summed across all tool-loop iterations. */
  usage?: GeminiUsageMetadata;
}

/**
 * Convert our message history to Gemini's Content[] format
 *
 * For assistant messages with rawPayload, uses the preserved Gemini Content
 * which includes tool calls and thought signatures. Falls back to text-only
 * for legacy messages without rawPayload.
 */
function convertToGeminiHistory(messages: Message[]): Content[] {
  const history: Content[] = [];

  for (const msg of messages) {
    if (msg.role === 'user') {
      // Extract text from user messages
      const textContent = msg.content
        .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
        .map((c) => c.text)
        .join('\n');

      if (textContent) {
        history.push({
          role: 'user',
          parts: [{ text: textContent }],
        });
      }
    } else {
      // For assistant messages, prefer rawPayload if available
      // This preserves tool calls, citations, and thought signatures
      if (msg.rawPayload) {
        history.push(msg.rawPayload);
      } else {
        // Fallback for legacy messages without rawPayload
        const textContent = msg.content
          .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
          .map((c) => c.text)
          .join('');

        if (textContent) {
          history.push({
            role: 'model',
            parts: [{ text: textContent }],
          });
        }
      }
    }
  }

  return history;
}

/**
 * Format tool result for Gemini's functionResponse
 */
function formatToolResultForGemini(toolName: string, result: ToolResult): object {
  return {
    results: result.documents.map((doc) => ({
      title: doc.title,
      context: doc.context,
      content: doc.source.data,
    })),
    summary: result.content,
  };
}

/**
 * Main facilitator agent that handles the conversation with Gemini
 */
export async function* runFacilitator(
  messageHistory: Message[],
  onMessage?: (message: Message) => Promise<void>,
  options?: { budgetMs?: number; reserveMs?: number }
): AsyncGenerator<FacilitatorStreamEvent> {
  const tools = getGeminiToolDescriptions();
  const tracker: ToolUsageTracker = { history: [], callsWithArgs: [] };

  // Build initial history from messages
  let geminiHistory = convertToGeminiHistory(messageHistory);

  // Get the last user message to send
  const lastMessage = messageHistory[messageHistory.length - 1];
  if (!lastMessage || lastMessage.role !== 'user') {
    yield { type: 'error', data: 'No user message to process' };
    return;
  }

  // Extract the user's query
  const userQuery = lastMessage.content
    .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
    .map((c) => c.text)
    .join('\n');

  // Remove the last message from history since we'll send it as the current message
  geminiHistory = geminiHistory.slice(0, -1);

  let iterations = 0;
  let currentQuery = userQuery;
  // The user query starts as the `message` arg and is only appended to geminiHistory once we
  // continue the loop after a tool call. The synthesis pass needs it in history, so track it.
  let userMessageInHistory = false;
  // Monotonic, per-request cumulative count of degraded tool results (T1). Repeated degraded
  // calls to the same tool count; a later healthy result never decrements it.
  let degradedCount = 0;
  // Bounded retries used for STOP-with-empty-text final completions (issue #60).
  let emptyFinalRetries = 0;

  // Overall request-time budget (Spec 49). softDeadline = when we stop starting new tool
  // work; the reserve between it and hardDeadline is the window for one synthesis pass.
  const budgetMs = options?.budgetMs ?? FACILITATOR_REQUEST_BUDGET_MS;
  const reserveMs = options?.reserveMs ?? FACILITATOR_SYNTHESIS_RESERVE_MS;
  const startTime = Date.now();
  const softDeadline = startTime + budgetMs - reserveMs;
  const hardDeadline = startTime + budgetMs;

  // Token usage summed across every Gemini call in this turn (initial + tool-loop continuations).
  const totalUsage: GeminiUsageMetadata = {
    promptTokenCount: 0,
    candidatesTokenCount: 0,
    thoughtsTokenCount: 0,
    totalTokenCount: 0,
  };
  const addUsage = (usage?: GeminiUsageMetadata) => {
    if (!usage) return;
    totalUsage.promptTokenCount += usage.promptTokenCount;
    totalUsage.candidatesTokenCount += usage.candidatesTokenCount;
    totalUsage.thoughtsTokenCount += usage.thoughtsTokenCount;
    totalUsage.totalTokenCount += usage.totalTokenCount;
  };

  // Graceful short-circuit (Spec 49): stop gathering and make ONE final, tools-disabled
  // best-effort synthesis pass from whatever context is already in hand. Reuses the existing
  // events (streamed `text` → `done`, or a single clean `error`) — no new wire events — and
  // is bounded to the remaining budget so it always finishes before the hard deadline.
  // Triggered by T2 (wall-clock) here; Phase 3's T1 (degraded-count) will reuse it.
  const runSynthesis = async function* (
    trigger: 'T1' | 'T2'
  ): AsyncGenerator<FacilitatorStreamEvent> {
    // Timing-only, NON-PII observability: no token counts (null in prod, #52), no query text.
    // Logged once at the terminal point so it can record which path was taken (done/error).
    const logShortCircuit = (terminalPath: 'done' | 'error') => {
      const summary = {
        trigger,
        terminalPath,
        elapsedMs: Date.now() - startTime,
        iterations,
        toolCallCount: tracker.history.length,
        degradedCount,
      };
      console.warn('[facilitator] request-budget short-circuit', summary);
      Sentry.captureMessage('facilitator request-budget short-circuit', {
        level: 'warning',
        extra: summary,
      });
    };

    const synthesisHistory = userMessageInHistory
      ? geminiHistory
      : [...geminiHistory, { role: 'user', parts: [{ text: userQuery }] } as Content];
    const remainingMs = Math.max(0, hardDeadline - Date.now());

    let synthText = '';
    let synthResponse: GeminiResponse | null = null;
    try {
      // Tools omitted → the model cannot emit a functionCall, so it must answer from context.
      const stream = streamGemini('', {
        systemPrompt: `${FACILITATOR_SYSTEM_PROMPT}\n\n${SYNTHESIS_DIRECTIVE}`,
        history: synthesisHistory,
        timeoutMs: remainingMs,
      });
      for await (const event of stream) {
        if (event.type === 'text') {
          synthText += event.data;
          yield { type: 'text', data: event.data };
        } else if (event.type === 'done') {
          synthResponse = event.response;
        }
      }
    } catch (error) {
      console.error('Facilitator synthesis error:', error);
      Sentry.captureException(error);
      logShortCircuit('error');
      yield { type: 'error', data: BUDGET_ERROR_MESSAGE };
      return;
    }

    // "Usable text" = non-empty after trim. Otherwise a clean bounded error, never silence.
    if (synthText.trim().length === 0) {
      logShortCircuit('error');
      yield { type: 'error', data: BUDGET_ERROR_MESSAGE };
      return;
    }

    addUsage(synthResponse?.usage);
    // Mirror the normal done path: persist via onMessage if a caller passed it (the SSE routes
    // do not — they persist the streamed text on the `done` event).
    if (onMessage) {
      await onMessage({
        role: 'assistant',
        content: [{ type: 'text', text: synthText }],
        rawPayload: synthResponse?.rawPayload ?? null,
      });
    }
    logShortCircuit('done');
    yield { type: 'done', data: '', usage: totalUsage };
  };

  while (iterations < MAX_ITERATIONS) {
    iterations++;

    // T2 (wall-clock backstop): out of time to gather → synthesize from what we have.
    const remainingToSoft = softDeadline - Date.now();
    if (remainingToSoft <= 0) {
      yield* runSynthesis('T2');
      return;
    }

    try {
      // Stream Gemini response with real-time event delivery. Bound the tool-gathering call to
      // the remaining-to-soft-deadline so a single slow/hanging call cannot blow the budget
      // (Spec 49); if it is cut, the catch below falls through to the synthesis pass.
      const stream = streamGemini(currentQuery, {
        systemPrompt: FACILITATOR_SYSTEM_PROMPT,
        history: geminiHistory,
        tools,
        timeoutMs: remainingToSoft,
      });

      const toolCallsCollected: GeminiToolCall[] = [];
      let response: GeminiResponse | null = null;

      // Live-emission gate for this turn (issue #66). Hold the visible text until it proves
      // non-degenerate (a letter/number appears, or it crosses the fragment-length bound),
      // then flush the held prefix and stream the rest live. A turn whose entire visible text
      // is a trivial punctuation-only fragment therefore NEVER reaches the client, so the
      // bounded retry below produces clean output on every surface — including the SSE routes
      // that persist the aggregate of streamed `text`. Symmetric with classifyDegenerateFinal:
      // the gate opens iff that classifier would return null. Real answers cross the bar on
      // their first token, so streaming stays near-real-time; a tool call is itself proof of a
      // real turn and opens the gate (flushing any buffered prefix first, preserving order).
      let streamedText = '';
      let pendingText = '';
      let gateOpen = false;

      // Process streaming events in real-time
      for await (const event of stream) {
        if (event.type === 'text') {
          streamedText += event.data;
          if (gateOpen) {
            yield { type: 'text', data: event.data };
          } else if (isProvenNonDegenerateText(streamedText)) {
            gateOpen = true;
            yield { type: 'text', data: pendingText + event.data };
            pendingText = '';
          } else {
            pendingText += event.data;
          }
        } else if (event.type === 'tool_call') {
          // Collect tool calls and notify frontend. A tool call opens the gate: flush any
          // buffered prefix first so its bytes and order are preserved.
          if (!gateOpen) {
            if (pendingText) yield { type: 'text', data: pendingText };
            pendingText = '';
            gateOpen = true;
          }
          toolCallsCollected.push(event.data);
          yield { type: 'tool_use', data: JSON.stringify({ name: event.data.name }) };
        } else if (event.type === 'done') {
          // Capture the final response with rawPayload
          response = event.response;
        }
        // Ignore 'thinking' events for now (could be logged or streamed separately)
      }

      if (!response) {
        throw new Error('Stream ended without response');
      }

      addUsage(response.usage);

      const assistantText = response.text;

      // If no tool calls, we're done
      if (toolCallsCollected.length === 0) {
        // Degenerate final completion (issues #60 + #66): a terminal answer that is empty OR
        // a trivial punctuation-only fragment (a lone '}' etc.) must never become a silent
        // `done` that ships as a real reply. STOP gets one bounded retry (nothing usable was
        // delivered, so re-issuing the identical call duplicates nothing, and the loop's
        // soft-deadline check keeps it inside the #49 budget). Anything else — SAFETY,
        // MAX_TOKENS, or an unknown reason — fails fast with an explicit error. No PII in
        // logs: reason + counters + fragment length only, never query text.
        const degenerateKind = classifyDegenerateFinal(assistantText);
        if (degenerateKind) {
          const finishReason = response.finishReason ?? 'MISSING';
          const summary = {
            degenerateKind,
            finishReason,
            fragmentLength: assistantText.trim().length,
            iterations,
            toolCallCount: tracker.history.length,
            emptyFinalRetries,
          };
          if (finishReason === 'STOP' && emptyFinalRetries < MAX_EMPTY_FINAL_RETRIES) {
            emptyFinalRetries++;
            console.warn('[facilitator] empty final completion — retrying once', summary);
            Sentry.captureMessage('facilitator empty final completion (retrying)', {
              level: 'warning',
              extra: summary,
            });
            continue;
          }
          console.error('[facilitator] empty final completion — failing', summary);
          Sentry.captureMessage('facilitator empty final completion', {
            level: 'error',
            extra: summary,
          });
          yield {
            type: 'error',
            data: finishReason === 'SAFETY' ? SAFETY_BLOCKED_ERROR_MESSAGE : EMPTY_ANSWER_ERROR_MESSAGE,
          };
          return;
        }

        // Create assistant message content
        const assistantContent: ContentBlock[] = [];
        if (assistantText) {
          assistantContent.push({ type: 'text', text: assistantText });
        }

        // Store the assistant message with rawPayload for history preservation
        if (onMessage && assistantContent.length > 0) {
          await onMessage({
            role: 'assistant',
            content: assistantContent,
            rawPayload: response.rawPayload, // Preserve for multi-turn conversations
          });
        }

        yield { type: 'done', data: '', usage: totalUsage };
        return;
      }

      // Process tool calls
      // On first iteration, add the user message to history
      // (It was removed to send as currentQuery, but we need it in history for context)
      if (iterations === 1) {
        geminiHistory.push({
          role: 'user',
          parts: [{ text: userQuery }],
        });
        userMessageInHistory = true;
      }

      // Add assistant's response to history - use rawPayload directly to preserve
      // thought signatures and any metadata on the Content object
      geminiHistory.push(response.rawPayload);

      // Process each tool call and collect results. Two triggers short-circuit mid-loop:
      // T2 (soft deadline reached before dispatching a tool) and T1 (>= threshold degraded
      // results). On either, stop calling tools but still append a synthetic functionResponse
      // (and emit a tool_result) for every remaining requested call — Gemini rejects a turn
      // with an unmatched functionCall.
      let shortCircuitTrigger: 'T1' | 'T2' | null = null;
      for (const tc of toolCallsCollected) {
        if (!shortCircuitTrigger && Date.now() >= softDeadline) {
          shortCircuitTrigger = 'T2';
        }

        if (shortCircuitTrigger) {
          yield {
            type: 'tool_result',
            data: JSON.stringify({ tool: tc.name, query: tc.args.query, resultCount: 0 }),
          };
          const skipped: ToolResult = {
            content: 'Skipped: request time budget reached before this tool was called.',
            documents: [],
          };
          geminiHistory.push({
            role: 'user',
            parts: [
              {
                functionResponse: {
                  name: tc.name,
                  response: formatToolResultForGemini(tc.name, skipped),
                },
              },
            ],
          } as Content);
          continue;
        }

        const result = await processToolCall(tc.name, tc.args, tracker);

        yield {
          type: 'tool_result',
          data: JSON.stringify({
            tool: tc.name,
            query: tc.args.query,
            resultCount: result.documents.length,
          }),
        };

        // Add tool result to history as function response.
        // @google/genai requires 'user' role for Content carrying a
        // functionResponse part (the old @google/generative-ai SDK used
        // 'function'; that's now rejected with "Role must be user or model").
        geminiHistory.push({
          role: 'user',
          parts: [
            {
              functionResponse: {
                name: tc.name,
                response: formatToolResultForGemini(tc.name, result),
              },
            },
          ],
        } as Content);

        // T1 (fail-fast): count degraded results via #54's machine-readable marker (not
        // string-matching). Both degraded paths carry it — the tool's own degraded return and
        // processToolCall's backstop `catch`, which returns unavailableResult. At the
        // threshold, stop gathering after this tool; remaining calls are skipped above.
        if (result.isDegraded) {
          degradedCount++;
          if (degradedCount >= T1_DEGRADED_THRESHOLD) {
            shortCircuitTrigger = 'T1';
          }
        }
      }

      // If either trigger fired mid-loop, synthesize now instead of another tool-gathering turn.
      if (shortCircuitTrigger) {
        yield* runSynthesis(shortCircuitTrigger);
        return;
      }

      // Continue the loop with empty query (let Gemini continue based on tool results)
      currentQuery = '';
      continue;
    } catch (error) {
      // A tool-gathering call cut at/after the soft deadline is a budget short-circuit, not a
      // failure → fall back to the best-effort synthesis pass. Any earlier failure is a
      // genuine unrecoverable error and still surfaces as an `error` event, as before.
      if (Date.now() >= softDeadline) {
        yield* runSynthesis('T2');
        return;
      }
      console.error('Facilitator error:', error);
      Sentry.captureException(error);
      yield {
        type: 'error',
        data: error instanceof Error ? error.message : 'Unknown error',
      };
      return;
    }
  }

  // Max iterations reached
  yield {
    type: 'error',
    data: 'Maximum iterations reached',
  };
}
