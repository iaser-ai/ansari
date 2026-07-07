import { count, eq, gte, desc, sql } from 'drizzle-orm';
import { db } from '.';
import { users, threads, messages, feedback } from '../../db/schema';
import type { ContentBlock } from '../../db/schema';

// --- Pure helpers (exported for testing) ---

/**
 * Safely convert a date value (string or Date object) to YYYY-MM-DD string.
 * The pg driver may return Date objects even for DATE::text casts.
 */
function toDateString(value: unknown): string {
  if (value instanceof Date) return value.toISOString().split('T')[0];
  return String(value);
}

/**
 * Extract a text preview from a ContentBlock array.
 * - First text block: truncated to 200 chars with "..." if needed.
 * - No text block: returns "[type]" placeholder based on first block type.
 * - Empty array: returns "".
 */
export function extractContentPreview(content: ContentBlock[]): string {
  if (!content || content.length === 0) return '';

  const textBlock = content.find((b) => b.type === 'text');
  if (textBlock && textBlock.type === 'text') {
    const text = textBlock.text;
    if (text.length > 200) return text.slice(0, 200) + '...';
    return text;
  }

  return `[${content[0].type}]`;
}

/**
 * Generate a zero-filled date range array.
 * Fills every day from (today - days + 1) to today with default values,
 * merging actual data where available.
 */
export function fillDateRange<T extends { date: string }>(
  days: number,
  data: T[],
  defaults: Omit<T, 'date'>,
): T[] {
  const map = new Map(data.map((d) => [d.date, d]));
  const result: T[] = [];

  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - days + 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

  for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    const dateStr = d.toISOString().split('T')[0];
    const existing = map.get(dateStr);
    if (existing) {
      result.push(existing);
    } else {
      result.push({ date: dateStr, ...defaults } as T);
    }
  }

  return result;
}

// --- Query functions ---

export async function getSummaryStats() {
  const now = new Date();
  const d24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const d7d = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const d30d = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  const [totalUsers, newUsers24h, newUsers7d, newUsers30d, totalThreads, totalMessages, totalFeedback] =
    await Promise.all([
      db.select({ total: count() }).from(users),
      db.select({ total: count() }).from(users).where(gte(users.createdAt, d24h)),
      db.select({ total: count() }).from(users).where(gte(users.createdAt, d7d)),
      db.select({ total: count() }).from(users).where(gte(users.createdAt, d30d)),
      db.select({ total: count() }).from(threads),
      db.select({ total: count() }).from(messages),
      db.select({ total: count() }).from(feedback),
    ]);

  return {
    total_users: totalUsers[0].total,
    new_users_24h: newUsers24h[0].total,
    new_users_7d: newUsers7d[0].total,
    new_users_30d: newUsers30d[0].total,
    total_threads: totalThreads[0].total,
    total_messages: totalMessages[0].total,
    total_feedback: totalFeedback[0].total,
  };
}

export async function getUsersPerDay(days: number) {
  const startDate = new Date();
  startDate.setUTCDate(startDate.getUTCDate() - days + 1);
  startDate.setUTCHours(0, 0, 0, 0);

  const dateExpr = sql<string>`DATE(${users.createdAt} AT TIME ZONE 'UTC')::text`;

  const rows = await db
    .select({
      date: dateExpr,
      count: count(),
    })
    .from(users)
    .where(gte(users.createdAt, startDate))
    .groupBy(dateExpr)
    .orderBy(dateExpr);

  const data = rows.map((r) => ({
    date: toDateString(r.date),
    count: r.count,
  }));

  return fillDateRange(days, data, { count: 0 });
}

export async function getThreadsPerDay(days: number) {
  const startDate = new Date();
  startDate.setUTCDate(startDate.getUTCDate() - days + 1);
  startDate.setUTCHours(0, 0, 0, 0);

  const dateExpr = sql<string>`DATE(${threads.createdAt} AT TIME ZONE 'UTC')::text`;

  const rows = await db
    .select({
      date: dateExpr,
      source: threads.source,
      count: count(),
    })
    .from(threads)
    .where(gte(threads.createdAt, startDate))
    .groupBy(dateExpr, threads.source)
    .orderBy(dateExpr);

  // Pivot: group by date, split by source
  const dateMap = new Map<string, { date: string; web: number; legacy: number }>();
  for (const row of rows) {
    const dateStr = toDateString(row.date);
    const entry = dateMap.get(dateStr) || { date: dateStr, web: 0, legacy: 0 };
    const source = row.source as 'web' | 'legacy';
    if (source === 'web' || source === 'legacy') {
      entry[source] = row.count;
    }
    dateMap.set(dateStr, entry);
  }

  return fillDateRange(days, Array.from(dateMap.values()), { web: 0, legacy: 0 });
}

export async function getMessagesPerDay(days: number) {
  const startDate = new Date();
  startDate.setUTCDate(startDate.getUTCDate() - days + 1);
  startDate.setUTCHours(0, 0, 0, 0);

  const dateExpr = sql<string>`DATE(${messages.createdAt} AT TIME ZONE 'UTC')::text`;

  const rows = await db
    .select({
      date: dateExpr,
      role: messages.role,
      count: count(),
    })
    .from(messages)
    .where(gte(messages.createdAt, startDate))
    .groupBy(dateExpr, messages.role)
    .orderBy(dateExpr);

  // Pivot: group by date, split by role
  const dateMap = new Map<string, { date: string; user: number; assistant: number }>();
  for (const row of rows) {
    const dateStr = toDateString(row.date);
    const entry = dateMap.get(dateStr) || { date: dateStr, user: 0, assistant: 0 };
    const role = row.role as 'user' | 'assistant';
    if (role === 'user' || role === 'assistant') {
      entry[role] = row.count;
    }
    dateMap.set(dateStr, entry);
  }

  return fillDateRange(days, Array.from(dateMap.values()), { user: 0, assistant: 0 });
}

export async function getRecentMessages(limit: number) {
  const rows = await db
    .select({
      id: messages.id,
      threadId: messages.threadId,
      threadName: threads.name,
      role: messages.role,
      content: messages.content,
      agentName: messages.agentName,
      source: messages.source,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .leftJoin(threads, eq(messages.threadId, threads.id))
    .orderBy(desc(messages.createdAt))
    .limit(limit);

  return rows.map((r) => ({
    id: r.id,
    thread_id: r.threadId,
    thread_name: r.threadName,
    role: r.role,
    content_preview: extractContentPreview(r.content as ContentBlock[]),
    agent_name: r.agentName,
    source: r.source,
    created_at: r.createdAt?.toISOString() ?? null,
  }));
}

export async function getFeedbackSummary() {
  const rows = await db
    .select({
      feedbackClass: feedback.feedbackClass,
      count: count(),
    })
    .from(feedback)
    .groupBy(feedback.feedbackClass);

  const result: Record<string, number> = {
    thumbs_up: 0,
    thumbs_down: 0,
    report: 0,
  };

  for (const row of rows) {
    result[row.feedbackClass] = row.count;
  }

  return result;
}
