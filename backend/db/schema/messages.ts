import { pgTable, uuid, text, timestamp, jsonb, integer, index } from 'drizzle-orm/pg-core';
import { threads } from './threads';

// Content block types matching Claude's format
export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string }
  | { type: 'document'; source: { type: string; media_type: string; data: string }; title: string; context?: string };

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
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (table) => [
  index('idx_messages_thread').on(table.threadId, table.createdAt),
]);

export type Message = typeof messages.$inferSelect;
export type NewMessage = typeof messages.$inferInsert;
