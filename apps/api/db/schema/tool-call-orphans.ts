import { pgTable, uuid, text, timestamp, jsonb, index } from 'drizzle-orm/pg-core';
import { threads } from './threads';
import type { ModelProvider, ToolCallRecord } from './messages';

/**
 * Tool dispatch records from turns that produced NO assistant message row
 * (spec 73): the facilitator ended in an `error` event, an empty final answer,
 * or mcp-complete's empty-answer 502. Those turns are disproportionately the
 * degraded ones — losing them would bias the reliability metrics this feature
 * exists to produce.
 *
 * A separate table, NOT invisible rows in `messages`, so invisibility to the
 * frozen thread GET contract, share snapshots, history replay, and
 * message-count stats holds BY CONSTRUCTION: no existing query reads this
 * table. Reliability analytics union `messages.tool_calls` with this table.
 */
export const toolCallOrphans = pgTable('tool_call_orphans', {
  id: uuid('id').primaryKey().defaultRandom(),
  threadId: uuid('thread_id').references(() => threads.id, { onDelete: 'cascade' }).notNull(),
  // Why the turn produced no assistant row.
  reason: text('reason').$type<'error' | 'empty_final'>().notNull(),
  source: text('source'),
  client: text('client'),
  toolCalls: jsonb('tool_calls').$type<ToolCallRecord[]>().notNull(),
  // Per-turn model provenance (issue #99) — failed turns deserve it too: a
  // #79-rescued-then-failed turn is exactly the row that makes "rescued on
  // Inkling" queryable. NULL (never '') when the terminal event carried none.
  modelProvider: text('model_provider').$type<ModelProvider>(),
  modelId: text('model_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (table) => [
  index('idx_tool_call_orphans_thread').on(table.threadId, table.createdAt),
]);

export type ToolCallOrphan = typeof toolCallOrphans.$inferSelect;
export type NewToolCallOrphan = typeof toolCallOrphans.$inferInsert;
