import { pgTable, uuid, text, timestamp, jsonb, integer, index } from 'drizzle-orm/pg-core';
import type { Content } from '@google/genai';
import { threads } from './threads';

// Content block types matching Claude's format
export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string }
  | { type: 'document'; source: { type: string; media_type: string; data: string }; title: string; context?: string };

// Tool dispatch records (spec 73). Persisted in the SEPARATE `tool_calls`
// column — NEVER in `content` — so no API-serialization path can leak them to
// the frozen mobile/web contract. Interleaved in dispatch order:
// tool_use then its tool_result, correlated by loop-minted ids (Gemini
// supplies none).
export const TOOL_RESULT_STATUSES = [
  // The tool executed and returned a normal result.
  'ok',
  // The tool executed but could not consult its source (ToolResult.isDegraded).
  'degraded',
  // Never executed: a T1 (degraded-count) or T2 (wall-clock) short-circuit
  // skipped it — see skip_trigger for which.
  'budget_skipped',
  // Never executed: the consecutive/total tool-usage limit refused it.
  'limit_refused',
  // The model requested a tool that does not exist.
  'unknown_tool',
] as const;
export type ToolResultStatus = (typeof TOOL_RESULT_STATUSES)[number];

export type ToolCallRecord =
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | {
      type: 'tool_result';
      tool_use_id: string;
      /** Full formatToolResultForGemini output — the ground truth of what the model received. */
      content: Record<string, unknown>;
      status: ToolResultStatus;
      /** Wall-clock execution time; null for calls that never executed (skipped/refused). */
      duration_ms: number | null;
      /** ToolFetchErrorClass when the degrade carried one (#76); absent otherwise. */
      error_class?: string;
      /** Attempts before degrading: 2 on a retried timeout (#76); absent when unknown. */
      attempts?: number;
      /** HTTP status of the failed fetch, when the degrade carried one. */
      http_status?: number;
      /** Which short-circuit skipped this call; only on budget_skipped records. */
      skip_trigger?: 'T1' | 'T2';
    };

export const messages = pgTable('messages', {
  id: uuid('id').primaryKey().defaultRandom(),
  threadId: uuid('thread_id').references(() => threads.id, { onDelete: 'cascade' }).notNull(),
  role: text('role').notNull(), // 'user', 'assistant', 'tool'
  content: jsonb('content').notNull().$type<ContentBlock[]>(), // Array of content blocks
  agentName: text('agent_name'), // 'facilitator', 'tool-quran', etc.
  source: text('source').default('web'),
  // Per-request client attribution from the X-Ansari-Client header (spec 56).
  // Nullable, no default: absent header => NULL; malformed => sentinel 'invalid'.
  client: text('client'),
  // Per-message LLM token usage (summed across the tool-loop iterations
  // that produced this assistant turn). Null for user messages and any
  // message persisted before token tracking landed.
  inputTokens: integer('input_tokens'),
  outputTokens: integer('output_tokens'),
  thinkingTokens: integer('thinking_tokens'),
  totalTokens: integer('total_tokens'),
  // Final model turn's Gemini Content — thought signatures included — so turn 2+
  // replays real history instead of a text-only fallback (issue #70). Only the
  // final turn is stored (never intermediate tool rounds), so tool args/results
  // are not duplicated here. Nullable: user messages, legacy rows, and
  // guard-rejected payloads legitimately have none.
  rawPayload: jsonb('raw_payload').$type<Content>(),
  // Tool dispatch records for this assistant turn (spec 73). NULL (never [])
  // when the turn invoked no tools. Deliberately excluded from the read-path
  // projections in lib/db/threads.ts / shares.ts: no serializing or replay
  // path selects it, so the frozen API contract cannot leak it structurally.
  toolCalls: jsonb('tool_calls').$type<ToolCallRecord[]>(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (table) => [
  index('idx_messages_thread').on(table.threadId, table.createdAt),
]);

export type Message = typeof messages.$inferSelect;
export type NewMessage = typeof messages.$inferInsert;
