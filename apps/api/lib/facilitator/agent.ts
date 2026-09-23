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
  type Part,
  type GeminiToolCall,
  type GeminiResponse,
  type GeminiStreamEvent,
  type GeminiUsageMetadata,
} from '../ai/gemini-client';
import { streamInkling, isInklingConfigured } from '../ai/inkling-client';
import { FACILITATOR_SYSTEM_PROMPT, TOOL_CONTINUATION_DIRECTIVE } from '../ai/prompts/facilitator';
import { config } from '../config';
import { createToolMap, getGeminiToolDescriptions } from '../tools';
import type { ToolResult } from '../tools/types';
import { unavailableResult, reportDegradedTool, toolLabel } from '../tools/resilience';
import type {
  ContentBlock,
  ModelProvenance,
  ToolCallRecord,
  ToolResultStatus,
} from '@/db/schema/messages';

type ToolResultRecord = Extract<ToolCallRecord, { type: 'tool_result' }>;

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
// outage exits after ≤~40s of tool time (tools dispatch serially; ≤20s per timed-out tool with
// #72's timeout-only retry) instead of grinding to the 120s wall-clock backstop (T2). Time alone
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

// Empty-final-completion handling (issues #60/#70/#74/#79). Vertex's degraded-completion
// family can finish a call with a real finishReason and zero visible text. The #42 rule
// (never retry after a finishReason) exists to avoid duplicating tokens already delivered
// to the client — in the empty case nothing was delivered, so bounded retries duplicate
// nothing. Retryable reasons are STOP and MALFORMED_FUNCTION_CALL (both transient provider
// flakiness, #70). The ladder (#79): retry 1 re-issues on the same model (cheap, handles
// blips); retry 2 leaves Vertex entirely for thinkingmachines/Inkling (Tinker
// infrastructure, #74). Degradation that survives a same-model retry is overwhelmingly the
// capacity-wave family that hits BOTH Vertex pools at once, so the second Vertex pool is
// no longer a rung — config.gemini.fallbackModel now serves only gemini-client's
// intra-Vertex 429 fast-failover (#45). When TINKER_API_KEY is unset the ladder is the
// single same-model retry (the Inkling rung is skipped cleanly; warned once at boot-style
// first use). Other reasons are NOT retried: SAFETY = blocked (a retry would likely
// re-block), MAX_TOKENS = the thinking budget consumed the output cap (a config bug to
// surface loudly — coordinate cap sizing with issue #51).
const MAX_EMPTY_FINAL_RETRIES = 2;

// Terminal-Gemini-error rescue (#79): minimum time remaining before the soft deadline for
// a rescue attempt to be worth starting. Below this the request is nearly out of gathering
// budget anyway — surface the error (or synthesize) rather than start a doomed
// off-Vertex call, and Spec 49's synthesis reserve beyond the soft deadline stays intact.
const INKLING_RESCUE_MIN_REMAINING_MS = 20_000;
const RETRYABLE_EMPTY_FINISH_REASONS = new Set(['STOP', 'MALFORMED_FUNCTION_CALL']);
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
  /** Tool dispatch records for this assistant turn (spec 73); null when no tools ran. */
  toolCalls?: ToolCallRecord[] | null;
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
 * How a dispatch resolved (spec 73). Return-typed — the persisted status is derived
 * from this tag plus ToolResult.isDegraded, never by string-matching `content` (#54).
 * 'limit_refused' and 'unknown_tool' never execute the tool; 'backstop_error' means
 * the tool threw and the defense-in-depth catch degraded it.
 */
type ToolDispatchOutcome = 'ok' | 'limit_refused' | 'unknown_tool' | 'backstop_error';

/**
 * Process a single tool call. `toolId` is minted by the loop (spec 73) so the
 * usage tracker and the persisted tool_use/tool_result pair share one id.
 */
async function processToolCall(
  toolName: string,
  toolArgs: Record<string, unknown>,
  tracker: ToolUsageTracker,
  toolId: string
): Promise<{ result: ToolResult; outcome: ToolDispatchOutcome }> {
  const toolMap = createToolMap();

  // Check if we hit the limit
  if (checkToolLimit(tracker, toolName)) {
    return {
      outcome: 'limit_refused',
      result: {
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
      },
    };
  }

  // Track tool usage
  tracker.history.push(toolName);
  tracker.callsWithArgs.push({ tool: toolName, args: toolArgs, id: toolId });

  // Get the tool
  const tool = toolMap.get(toolName);
  if (!tool) {
    return {
      outcome: 'unknown_tool',
      result: {
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
      },
    };
  }

  // Execute the tool. Defense-in-depth backstop (Spec 43): the four search tools
  // already catch provider failures and return a degraded result, but if any tool
  // (including a future one) throws, convert it into the unified "temporarily
  // unavailable" result rather than letting it crash or hang the facilitator loop.
  const query = toolArgs.query as string;
  try {
    return { result: await tool.run(query), outcome: 'ok' };
  } catch (error) {
    reportDegradedTool({
      tool: toolName,
      provider: 'unknown',
      errorClass: 'network',
      queryLength: typeof query === 'string' ? query.length : 0,
    });
    return {
      result: unavailableResult(toolLabel(toolName), { errorClass: 'network' }),
      outcome: 'backstop_error',
    };
  }
}

/**
 * Build the persisted tool_result record for an executed-or-refused dispatch (spec 73).
 * Status comes from the outcome tag + the #54 isDegraded marker; duration is null when
 * the tool never ran (limit-refused / unknown tool). Degradation detail fields are
 * copied only when present — a degrade without ToolFetchError detail stays bare.
 */
function buildToolResultRecord(
  toolUseId: string,
  content: Record<string, unknown>,
  outcome: ToolDispatchOutcome,
  result: ToolResult,
  durationMs: number
): ToolResultRecord {
  let status: ToolResultStatus;
  switch (outcome) {
    case 'limit_refused':
      status = 'limit_refused';
      break;
    case 'unknown_tool':
      status = 'unknown_tool';
      break;
    default:
      status = result.isDegraded ? 'degraded' : 'ok';
  }
  const executed = outcome === 'ok' || outcome === 'backstop_error';
  const record: ToolResultRecord = {
    type: 'tool_result',
    tool_use_id: toolUseId,
    content,
    status,
    duration_ms: executed ? durationMs : null,
  };
  const detail = result.degradation;
  if (detail?.errorClass !== undefined) record.error_class = detail.errorClass;
  if (detail?.attempts !== undefined) record.attempts = detail.attempts;
  if (detail?.status !== undefined) record.http_status = detail.status;
  return record;
}

export interface FacilitatorStreamEvent {
  type: 'text' | 'tool_use' | 'tool_result' | 'done' | 'error';
  data: string;
  /** Set on the final 'done' event: token usage summed across all tool-loop iterations. */
  usage?: GeminiUsageMetadata;
  /**
   * Set on the final 'done' event: the final model turn's Gemini Content — thought
   * signatures included — for the caller to persist so turn 2+ replays real history
   * instead of the text-only fallback (issue #70). Null when the payload failed the
   * consistency guard (a functionCall part with no paired functionResponse must
   * never be persisted — it would 400 every later turn of the thread).
   */
  rawPayload?: Content | null;
  /**
   * Set on EVERY terminal event (`done` AND `error`) when the request dispatched at
   * least one tool (spec 73): the ordered tool_use/tool_result records across all
   * loop iterations, for the caller to persist. Absent when no tool was dispatched.
   * Carried on `error` too so a turn that ran (degraded) tools and then failed is
   * still counted — those are disproportionately the turns the metric exists for.
   */
  toolCalls?: ToolCallRecord[];
  /**
   * Set on every terminal event (`done` AND `error`) that a model call produced
   * (issue #99): the serving backend + model id of the call that produced —
   * or failed to produce — the final turn. A #79-rescued turn reports
   * provider 'inkling' even though the request's primary was gemini, and the
   * synthesis path reports the model that wrote the synthesis. Absent only
   * when no provider was ever engaged (e.g. no user message to process);
   * persist sites map absence to NULL.
   */
  provenance?: ModelProvenance;
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
function formatToolResultForGemini(toolName: string, result: ToolResult): Record<string, unknown> {
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
  options?: {
    budgetMs?: number;
    reserveMs?: number;
    /**
     * Model provider for the whole request (issue #74 scope amendment).
     * 'inkling' runs EVERY call of the request — all tool-loop iterations,
     * continuations, and the synthesis pass — on the OpenAI-compatible
     * Inkling client, with no Gemini fallback of any kind: if Inkling fails,
     * the request fails loudly (benchmark integrity for the leaderboard
     * adapter's 'ansari-facilitator-inkling' model id). When omitted, the
     * env-gated PRIMARY_BACKEND switch decides (issue #95): 'gemini' by
     * default — Gemini primary with Inkling only as the final empty-final
     * ladder rung and the #79 rescue.
     */
    provider?: 'gemini' | 'inkling';
  }
): AsyncGenerator<FacilitatorStreamEvent> {
  const tools = getGeminiToolDescriptions();
  const tracker: ToolUsageTracker = { history: [], callsWithArgs: [] };

  // Tool dispatch records for persistence (spec 73), accumulated at the LOOP level —
  // not inside processToolCall — so budget-skipped and limit-refused calls (which
  // never reach the tracker) are recorded too. Ids are minted here; Gemini has none.
  const toolCallRecords: ToolCallRecord[] = [];
  // Per-request sequence makes id uniqueness structural within a turn; the timestamp
  // + random tail keep ids distinct across turns of the same thread.
  let toolIdSeq = 0;
  const recordToolUse = (name: string, input: Record<string, unknown>): string => {
    toolIdSeq++;
    const id = `tool_${Date.now()}_${toolIdSeq}_${Math.random().toString(36).slice(2, 7)}`;
    toolCallRecords.push({ type: 'tool_use', id, name, input });
    return id;
  };
  const recordToolResult = (record: ToolResultRecord) => {
    toolCallRecords.push(record);
  };
  // Attached to every terminal yield; undefined (→ NULL at persistence) when no tool ran.
  const collectedToolCalls = (): ToolCallRecord[] | undefined =>
    toolCallRecords.length > 0 ? toolCallRecords : undefined;

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
  // Bounded retries used for degenerate (empty/fragment) final completions (#60/#70).
  let emptyFinalRetries = 0;
  // Off-Vertex escalation to Inkling (#74/#79), sticky for the request: once engaged —
  // by the empty-final ladder's second rung or by the terminal-error rescue below — every
  // later call in the request (tool loop and synthesis alike) stays on Inkling, because
  // either engagement means Gemini has already failed this request and must not be
  // re-asked. Seeded true when the request's provider resolves to 'inkling' — an
  // explicit caller option (leaderboard adapter) wins, else the env-gated
  // PRIMARY_BACKEND switch (issue #95, default 'gemini'): then no Gemini call is ever
  // made and any Inkling failure surfaces loudly instead of degrading the benchmark.
  // Seeding also inherently short-circuits the #79 terminal-error rescue below (its
  // `!useInklingRung` guard): rescuing an inkling-primary request with Inkling would
  // be meaningless, so inkling-primary failures fail loudly instead. The empty-final
  // ladder still applies, as same-model (Inkling) retries.
  let useInklingRung = (options?.provider ?? config.primaryBackend) === 'inkling';
  // Terminal-Gemini-error rescue (#79): at most ONE Inkling rescue attempt per request
  // (cost guardrail), tracked separately from the ladder's emptyFinalRetries.
  let inklingRescueUsed = false;

  // Provenance of the provider currently serving this request (issue #99), read at
  // terminal-yield time so it reflects the call that actually produced (or failed
  // to produce) the final turn — after any ladder escalation or #79 rescue flipped
  // useInklingRung. config.gemini is only read on the gemini path (same lazy-read
  // rule as the ladder's model label: an inkling-only deployment's getter throws).
  const currentProvenance = (): ModelProvenance =>
    useInklingRung
      ? { provider: 'inkling', modelId: config.inkling.model }
      : { provider: 'gemini', modelId: config.gemini.model };

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

  // Build the payload handed out for persistence (issue #70), from the COMPLETE
  // arrival-ordered turn (`allParts`) — NOT `rawPayload`, whose last-chunk-wins
  // semantics (#83) mean a multi-chunk final answer's rawPayload holds only the
  // final text delta; persisting that would replay a fragment of the prior answer
  // on every later turn. Two rules applied here:
  //  - thought parts are never persisted (policy stated in inkling-client.ts:
  //    reasoning content must not be stored; with includeThoughts:false they
  //    should not arrive at all — this is the enforcement of that policy);
  //  - consistency guard: the final turn of a request ends with zero collected
  //    tool calls, so the persisted payload must carry zero functionCall parts.
  //    A violating payload would replay an orphan functionCall — no paired
  //    functionResponse — on EVERY later turn of the thread: a permanently
  //    poisoned thread. Degrade that one message to the text-only fallback
  //    (null), loudly. Counts only in logs, never content.
  const buildPersistablePayload = (response: GeminiResponse): Content | null => {
    const parts = response.allParts.filter((p) => p.thought !== true);
    if (parts.length === 0) return null;
    const orphanCallCount = parts.filter((p) => p.functionCall).length;
    if (orphanCallCount > 0) {
      const summary = { orphanCallCount, iterations, toolCallCount: tracker.history.length };
      console.error(
        '[facilitator] final turn carries functionCall parts — persisting null instead (issue #70)',
        summary
      );
      Sentry.captureMessage('facilitator final rawPayload functionCall desync', {
        level: 'error',
        extra: summary,
      });
      return null;
    }
    return { role: 'model', parts };
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
      // Once the request escalated to Inkling (#74/#79 — ladder rung or error rescue),
      // synthesis stays there: Gemini already failed this request and must not be re-asked.
      const synthesisOptions = {
        systemPrompt: `${FACILITATOR_SYSTEM_PROMPT}\n\n${SYNTHESIS_DIRECTIVE}`,
        history: synthesisHistory,
        timeoutMs: remainingMs,
      };
      // Layering (issue #90): the budget owns the request deadline,
      // INKLING_TIMEOUT_MS owns the per-call cap — min() preserves both. At the
      // default (180s > the whole budget) this is a no-op.
      const stream = useInklingRung
        ? streamInkling('', {
            ...synthesisOptions,
            timeoutMs: Math.min(remainingMs, config.inkling.timeoutMs),
          })
        : streamGemini('', synthesisOptions);
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
      yield {
        type: 'error',
        data: BUDGET_ERROR_MESSAGE,
        toolCalls: collectedToolCalls(),
        provenance: currentProvenance(),
      };
      return;
    }

    // A usable synthesis must be a PROVEN completion, not just non-empty text (issue #2):
    //  - a terminal `done` event must have arrived (synthResponse set) — a stream that ends
    //    without one is truncated (the Inkling last rung now throws on early EOF, but a
    //    streamGemini cut can still end silently), and
    //  - the visible text must clear the same degenerate-final gate the main loop applies
    //    (classifyDegenerateFinal: not empty, not a lone punctuation fragment).
    // Otherwise a clean bounded error, never silence and never a truncated/degenerate reply
    // shipped as a successful `done`.
    if (!synthResponse || classifyDegenerateFinal(synthText) !== null) {
      logShortCircuit('error');
      yield {
        type: 'error',
        data: BUDGET_ERROR_MESSAGE,
        toolCalls: collectedToolCalls(),
        provenance: currentProvenance(),
      };
      return;
    }

    addUsage(synthResponse?.usage);
    // Guarded payload for persistence (issue #70). Synthesis runs tools-disabled, so a
    // functionCall part here is a desync by definition — the guard nulls it loudly.
    const persistablePayload = buildPersistablePayload(synthResponse);
    // Mirror the normal done path: persist via onMessage if a caller passed it (the SSE routes
    // do not — they persist the streamed text on the `done` event).
    if (onMessage) {
      await onMessage({
        role: 'assistant',
        content: [{ type: 'text', text: synthText }],
        rawPayload: persistablePayload,
        toolCalls: collectedToolCalls() ?? null,
      });
    }
    logShortCircuit('done');
    yield {
      type: 'done',
      data: '',
      usage: totalUsage,
      rawPayload: persistablePayload,
      toolCalls: collectedToolCalls(),
      provenance: currentProvenance(),
    };
  };

  while (iterations < MAX_ITERATIONS) {
    iterations++;

    // T2 (wall-clock backstop): out of time to gather → synthesize from what we have.
    const remainingToSoft = softDeadline - Date.now();
    if (remainingToSoft <= 0) {
      yield* runSynthesis('T2');
      return;
    }

    // Whether THIS call has yielded any visible text to the client. Gates the #79 error
    // rescue: re-issuing a call whose text partially reached the client would duplicate
    // delivered tokens (the #42 rule) — such failures must still surface as errors.
    let visibleTextDelivered = false;

    try {
      // Stream the model response with real-time event delivery. Bound the tool-gathering
      // call to the remaining-to-soft-deadline so a single slow/hanging call cannot blow the
      // budget (Spec 49); if it is cut, the catch below falls through to the synthesis pass.
      // Once the request escalated to the Inkling rung (#74), the call runs on Inkling with
      // the SAME system prompt — its tool-budget rules are load-bearing for Inkling too.
      const callOptions = {
        systemPrompt: FACILITATOR_SYSTEM_PROMPT,
        history: geminiHistory,
        tools,
        timeoutMs: remainingToSoft,
      };
      // Layering (issue #90): the budget owns the request deadline,
      // INKLING_TIMEOUT_MS owns the per-call cap — min() preserves both. At the
      // default (180s > the whole budget) this is a no-op.
      const stream = useInklingRung
        ? streamInkling(currentQuery, {
            ...callOptions,
            timeoutMs: Math.min(remainingToSoft, config.inkling.timeoutMs),
          })
        : streamGemini(currentQuery, callOptions);

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
            visibleTextDelivered = true;
            yield { type: 'text', data: event.data };
          } else if (isProvenNonDegenerateText(streamedText)) {
            gateOpen = true;
            visibleTextDelivered = true;
            yield { type: 'text', data: pendingText + event.data };
            pendingText = '';
          } else {
            pendingText += event.data;
          }
        } else if (event.type === 'tool_call') {
          // Collect tool calls and notify frontend. A tool call opens the gate: flush any
          // buffered prefix first so its bytes and order are preserved.
          if (!gateOpen) {
            if (pendingText) {
              visibleTextDelivered = true;
              yield { type: 'text', data: pendingText };
            }
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
        // Degenerate final completion (issues #60 + #66 + #70 + #79): a terminal answer
        // that is empty OR a trivial punctuation-only fragment (a lone '}' etc.) must
        // never become a silent `done` that ships as a real reply. STOP and
        // MALFORMED_FUNCTION_CALL get bounded retries (nothing usable was delivered, so
        // re-issuing duplicates nothing, and the loop's soft-deadline check keeps them
        // inside the #49 budget): retry 1 on the same model, retry 2 straight to Inkling
        // off Vertex (#79 — no second-Vertex-pool rung). Anything else — SAFETY,
        // MAX_TOKENS, or an unknown reason — fails fast with an explicit error. No PII in
        // logs: reason + model + counters + fragment length only, never query text.
        const degenerateKind = classifyDegenerateFinal(assistantText);
        if (degenerateKind) {
          const finishReason = response.finishReason ?? 'MISSING';
          // Read lazily — this branch only runs on a degenerate final, so the config
          // getter is never touched on the healthy path. Under inkling-primary (#95)
          // config.gemini is never read AT ALL: on an inkling-only deployment (no
          // Gemini credentials) that getter throws, which would break the documented
          // same-model retry.
          const currentModel = useInklingRung ? config.inkling.model : config.gemini.model;
          // Rung 2 (#74/#79) runs on Inkling's separate (non-Vertex) infrastructure;
          // without TINKER_API_KEY the ladder is the single same-model retry.
          const inklingAvailable = isInklingConfigured();
          const maxRetries = inklingAvailable ? MAX_EMPTY_FINAL_RETRIES : 1;
          const summary = {
            degenerateKind,
            finishReason,
            fragmentLength: assistantText.trim().length,
            iterations,
            toolCallCount: tracker.history.length,
            emptyFinalRetries,
            model: currentModel,
          };
          if (RETRYABLE_EMPTY_FINISH_REASONS.has(finishReason) && emptyFinalRetries < maxRetries) {
            emptyFinalRetries++;
            if (inklingAvailable && emptyFinalRetries >= MAX_EMPTY_FINAL_RETRIES && !useInklingRung) {
              // The same-model retry also produced a degenerate final — leave Vertex (#79).
              useInklingRung = true;
              // Engagement breadcrumb for measuring the rung (issue #74). No PII:
              // counters and finishReason only, never query text.
              Sentry.addBreadcrumb({
                category: 'inkling',
                level: 'warning',
                message: 'empty-final ladder escalated to Inkling fallback rung (#74)',
                data: {
                  emptyFinalRetries,
                  iterations,
                  toolCallCount: tracker.history.length,
                  finishReason,
                },
              });
            }
            const retrySummary = {
              ...summary,
              nextModel: useInklingRung ? config.inkling.model : currentModel,
            };
            console.warn('[facilitator] empty final completion — retrying', retrySummary);
            Sentry.captureMessage('facilitator empty final completion (retrying)', {
              level: 'warning',
              extra: retrySummary,
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
            toolCalls: collectedToolCalls(),
            provenance: currentProvenance(),
          };
          return;
        }

        // Create assistant message content
        const assistantContent: ContentBlock[] = [];
        if (assistantText) {
          assistantContent.push({ type: 'text', text: assistantText });
        }

        // Guarded payload for persistence (issue #70): this turn collected zero tool
        // calls, so any functionCall part in its full turn is a desync — nulled loudly.
        const persistablePayload = buildPersistablePayload(response);

        // Store the assistant message with rawPayload for history preservation
        if (onMessage && assistantContent.length > 0) {
          await onMessage({
            role: 'assistant',
            content: assistantContent,
            rawPayload: persistablePayload, // Preserve for multi-turn conversations
            toolCalls: collectedToolCalls() ?? null,
          });
        }

        yield {
          type: 'done',
          data: '',
          usage: totalUsage,
          rawPayload: persistablePayload,
          toolCalls: collectedToolCalls(),
          provenance: currentProvenance(),
        };
        return;
      }

      // Process tool calls
      // Add the user message to history the first time we continue past a model turn
      // (it was removed to send as currentQuery, but we need it in history for context).
      // Guard on the flag, NOT `iterations === 1`: a degenerate-final retry (empty/fragment/
      // MALFORMED, or the Inkling rescue) does `continue` after `iterations++`, so if the FIRST
      // call fails and the retry then requests a tool, we are at iterations === 2 here and the
      // user's question would otherwise never enter history — every continuation would ask the
      // model to answer a question it never saw (issue #2).
      if (!userMessageInHistory) {
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
      //
      // ALL of the round's functionResponse parts go into ONE user Content (issue #14).
      // Gemini requires the turn following a functionCall turn to carry exactly as many
      // functionResponse parts as the model emitted functionCall parts; pushing one
      // single-part Content per call left the parallel-call case as a turn with 1 response
      // part vs N call parts, which Vertex rejects with 400 "number of function response
      // parts is [not] equal to the number of function call parts of the function call turn".
      const responseParts: Part[] = [];
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
          const skippedResponse = formatToolResultForGemini(tc.name, skipped);
          // Never executed, recorded anyway (spec 73): a skipped call belongs in the
          // reliability denominator, distinguishable by status + which trigger skipped it.
          const skippedId = recordToolUse(tc.name, tc.args);
          recordToolResult({
            type: 'tool_result',
            tool_use_id: skippedId,
            content: skippedResponse,
            status: 'budget_skipped',
            duration_ms: null,
            skip_trigger: shortCircuitTrigger,
          });
          responseParts.push({
            functionResponse: {
              name: tc.name,
              response: skippedResponse,
            },
          });
          continue;
        }

        const toolId = recordToolUse(tc.name, tc.args);
        const dispatchedAt = Date.now();
        const { result, outcome } = await processToolCall(tc.name, tc.args, tracker, toolId);
        const durationMs = Date.now() - dispatchedAt;
        const geminiResponse = formatToolResultForGemini(tc.name, result);
        recordToolResult(buildToolResultRecord(toolId, geminiResponse, outcome, result, durationMs));

        yield {
          type: 'tool_result',
          data: JSON.stringify({
            tool: tc.name,
            query: tc.args.query,
            resultCount: result.documents.length,
          }),
        };

        responseParts.push({
          functionResponse: {
            name: tc.name,
            response: geminiResponse,
          },
        });

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

      // Tool results enter history as functionResponse parts on a single 'user'-role
      // Content — @google/genai requires 'user' for functionResponse (the old
      // @google/generative-ai SDK's 'function' role is rejected), and the synthesis
      // path below relies on this push too, so it happens before the short-circuit.
      geminiHistory.push({ role: 'user', parts: responseParts });

      // If either trigger fired mid-loop, synthesize now instead of another tool-gathering turn.
      if (shortCircuitTrigger) {
        yield* runSynthesis(shortCircuitTrigger);
        return;
      }

      // Continue the loop with an explicit directive, not an empty message (issue #73):
      // the empty user turn after functionResponse parts is the trigger for flash's
      // thoughts-only empty completions under load. Transient — never added to
      // geminiHistory, so it cannot accumulate across rounds or persist.
      currentQuery = TOOL_CONTINUATION_DIRECTIVE;
      continue;
    } catch (error) {
      // A tool-gathering call cut at/after the soft deadline is a budget short-circuit, not a
      // failure → fall back to the best-effort synthesis pass. Any earlier failure is a
      // genuine unrecoverable error and still surfaces as an `error` event, as before.
      if (Date.now() >= softDeadline) {
        yield* runSynthesis('T2');
        return;
      }
      // Inkling rescue on a terminal Gemini error (#79). The empty-final ladder only sees
      // degenerate COMPLETIONS; hard failures (60s hang, dual-pool 429 exhaustion, Vertex
      // HTML ApiError) land here and used to surface straight to the user. Before giving
      // up, make ONE Inkling attempt — sticky, like the ladder rung — when ALL of:
      //   - the failed call ran on Gemini (never rescue Inkling with Inkling; the forced
      //     provider 'inkling' mode keeps failing loudly for benchmark integrity),
      //   - no rescue was already spent this request (cost guardrail: at most one),
      //   - the failed call delivered no visible text (the #42 rule: re-issuing after
      //     delivered tokens would duplicate them),
      //   - enough gathering budget remains for a real attempt (≥20s before the soft
      //     deadline, which also keeps Spec 49's synthesis reserve intact), and
      //   - TINKER_API_KEY is configured.
      if (
        !useInklingRung &&
        !inklingRescueUsed &&
        !visibleTextDelivered &&
        softDeadline - Date.now() >= INKLING_RESCUE_MIN_REMAINING_MS &&
        isInklingConfigured()
      ) {
        inklingRescueUsed = true;
        useInklingRung = true;
        // Same no-PII breadcrumb shape as the #74 ladder engagement but a DISTINCT
        // message, so ladder-engagements and error-rescues stay separable in Sentry.
        // The error text is provider-generated (never query text); truncated anyway.
        const rescueSummary = {
          elapsedMs: Date.now() - startTime,
          iterations,
          toolCallCount: tracker.history.length,
          error: (error instanceof Error ? error.message : String(error)).slice(0, 200),
        };
        console.warn('[facilitator] terminal Gemini error — rescuing on Inkling', rescueSummary);
        Sentry.addBreadcrumb({
          category: 'inkling',
          level: 'warning',
          message: 'terminal Gemini error rescued on Inkling (#79)',
          data: rescueSummary,
        });
        Sentry.captureMessage('facilitator terminal Gemini error rescued on Inkling', {
          level: 'warning',
          extra: rescueSummary,
        });
        continue;
      }
      console.error('Facilitator error:', error);
      Sentry.captureException(error);
      yield {
        type: 'error',
        data: error instanceof Error ? error.message : 'Unknown error',
        toolCalls: collectedToolCalls(),
        provenance: currentProvenance(),
      };
      return;
    }
  }

  // Max iterations reached
  yield {
    type: 'error',
    data: 'Maximum iterations reached',
    toolCalls: collectedToolCalls(),
    provenance: currentProvenance(),
  };
}
