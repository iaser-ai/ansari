import { pgTable, uuid, timestamp, jsonb } from 'drizzle-orm/pg-core';
import { threads } from './threads';
import type { Message, DocumentContentBlock } from './messages';

export type ThreadSnapshot = {
  threadName: string | null;
  messages: Array<{
    role: string;
    content: Message['content'];
    createdAt: string;
    // Citable sources, copied at share creation (spec 168); present only when
    // non-empty. Served by GET /api/v2/share/{id}/documents — share GET's
    // explicit projection never emits it. Pre-168 snapshots have no key.
    documents?: DocumentContentBlock[];
  }>;
};

export const shares = pgTable('shares', {
  id: uuid('id').primaryKey().defaultRandom(),
  threadId: uuid('thread_id').references(() => threads.id, { onDelete: 'cascade' }).notNull(),
  content: jsonb('content').notNull().$type<ThreadSnapshot>(), // Snapshot of thread
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

export type Share = typeof shares.$inferSelect;
export type NewShare = typeof shares.$inferInsert;
