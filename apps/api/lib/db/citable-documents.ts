/**
 * Citable-document derivation (spec 168) — the ONLY module that reads
 * `messages.tool_calls` for serving.
 *
 * Retrieved sources are not stored twice: they are derived from the tool
 * records spec 73 already persists. Raw `ToolCallRecord`s never leave this
 * module — the exported functions return derived `document` blocks only, so no
 * route or serializer can reach the records structurally (owner ruling on
 * #168). Stored jsonb is untrusted: every record is shape-checked at runtime,
 * and anything unexpected fails closed for that record without failing the
 * request.
 */
import { eq } from 'drizzle-orm';
import { db, type Executor } from './index';
import { messages, type DocumentContentBlock } from '@/db/schema/messages';
import type { DocumentBlock } from '../tools/types';

/**
 * Why a tool_result record contributed no documents. A closed set of literals:
 * never record data, text, or indexes into it — safe to log.
 */
export type RejectReason =
  | 'not_array'
  | 'bad_record'
  | 'bad_content'
  | 'bad_results'
  | 'bad_entry'
  | 'no_citations'
  | 'bad_citations'
  | 'length_mismatch';

// Records written before spec 168 carry no `citations`: expected, not logged.
const LEGACY: RejectReason = 'no_citations';

// Fidelity guard. `source.type` / `media_type` are not persisted (only the
// citability flag is), so they are filled from the DocumentBlock literal types.
// If a tool ever widens either literal (e.g. a PDF source), this resolves to
// `never` and the build breaks HERE until someone decides how to serve it.
type ExactLiteral<T, L extends string> = [T] extends [L] ? ([L] extends [T] ? L : never) : never;
const TEXT_SOURCE: {
  type: ExactLiteral<DocumentBlock['source']['type'], 'text'>;
  media_type: ExactLiteral<DocumentBlock['source']['media_type'], 'text/plain'>;
} = { type: 'text', media_type: 'text/plain' };

type Entry = { title: string; content: string; context?: string };

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Validate one tool_result record; return its entries paired with their
 * citability, or the reason it contributes nothing.
 */
function readResultRecord(
  record: Record<string, unknown>
): { entries: Array<{ entry: Entry; citable: boolean }> } | { reason: RejectReason } {
  const content = record.content;
  if (!isObject(content)) return { reason: 'bad_content' };
  const results = content.results;
  if (!Array.isArray(results)) return { reason: 'bad_results' };

  const entries: Entry[] = [];
  for (const r of results) {
    if (!isObject(r) || typeof r.title !== 'string' || typeof r.content !== 'string') {
      return { reason: 'bad_entry' };
    }
    if (r.context !== undefined && typeof r.context !== 'string') return { reason: 'bad_entry' };
    entries.push({ title: r.title, content: r.content, ...(r.context !== undefined ? { context: r.context } : {}) });
  }

  const citations = record.citations;
  if (citations === undefined) return { reason: LEGACY };
  if (!Array.isArray(citations) || !citations.every((c) => isObject(c) && typeof c.enabled === 'boolean')) {
    return { reason: 'bad_citations' };
  }
  if (citations.length !== entries.length) return { reason: 'length_mismatch' };

  return {
    entries: entries.map((entry, i) => ({ entry, citable: (citations[i] as { enabled: boolean }).enabled === true })),
  };
}

/**
 * Derive a message's citable documents from its stored `tool_calls`.
 *
 * Pure and never logs. Walks tool_result records in dispatch order and keeps an
 * entry only when its tool marked it citable. Duplicates collapse on
 * (title, context, text), first occurrence kept in place. A malformed,
 * legacy, or misaligned record contributes nothing; the others still derive.
 */
export function deriveCitableDocuments(toolCalls: unknown): {
  documents: DocumentContentBlock[];
  rejected: RejectReason[];
} {
  if (!Array.isArray(toolCalls)) return { documents: [], rejected: ['not_array'] };

  const documents: DocumentContentBlock[] = [];
  const rejected: RejectReason[] = [];
  const seen = new Set<string>();

  for (const record of toolCalls) {
    if (!isObject(record)) {
      rejected.push('bad_record');
      continue;
    }
    if (record.type !== 'tool_result') continue;

    const read = readResultRecord(record);
    if ('reason' in read) {
      rejected.push(read.reason);
      continue;
    }
    for (const { entry, citable } of read.entries) {
      if (!citable) continue;
      // A JSON tuple, not a joined string: all three fields are free text.
      const key = JSON.stringify([entry.title, entry.context ?? null, entry.content]);
      if (seen.has(key)) continue;
      seen.add(key);
      documents.push({
        type: 'document',
        source: { ...TEXT_SOURCE, data: entry.content },
        title: entry.title,
        ...(entry.context !== undefined ? { context: entry.context } : {}),
      });
    }
  }

  return { documents, rejected };
}

/** One assistant message's citable documents, positioned in its thread. */
export interface MessageDocuments {
  messageId: string;
  /**
   * Zero-based position of the message in the thread, in the same
   * (`created_at`, `id`) order thread GET (findMessagesByThread) and share
   * snapshots use — the join
   * key clients use to attach documents to messages. Messages are append-only
   * (never deleted or reordered), so the index is stable.
   */
  messageIndex: number;
  documents: DocumentContentBlock[];
}

/**
 * Citable documents for a thread's assistant messages, in thread order.
 * Messages with none are absent (never an empty list).
 *
 * The caller MUST already have authorized `threadId` (owner-scoped thread
 * lookup, or createThreadSnapshot's ownership check) — this helper performs no
 * authorization. One ordered query over the thread yields both the index and
 * the records, so the index cannot drift from the order it describes. Neither
 * the raw rows nor the reject reasons leave this function; a malformed record
 * is reported by message id and reason codes only, never its content.
 */
export async function findCitableDocumentsByThread(
  threadId: string,
  exec: Executor = db
): Promise<MessageDocuments[]> {
  const rows = await exec
    .select({ id: messages.id, role: messages.role, toolCalls: messages.toolCalls })
    .from(messages)
    .where(eq(messages.threadId, threadId))
    // Same thread order as findMessagesByThread and createThreadSnapshot:
    // created_at, then id to break ties. Must stay identical across all three.
    .orderBy(messages.createdAt, messages.id);

  const out: MessageDocuments[] = [];
  rows.forEach((row, messageIndex) => {
    if (row.role !== 'assistant' || row.toolCalls === null) return;
    const { documents, rejected } = deriveCitableDocuments(row.toolCalls);
    const reasons = [...new Set(rejected)].filter((r) => r !== LEGACY);
    if (reasons.length > 0) {
      console.warn('[citable-documents] tool records skipped', { messageId: row.id, reasons });
    }
    if (documents.length > 0) out.push({ messageId: row.id, messageIndex, documents });
  });
  return out;
}
