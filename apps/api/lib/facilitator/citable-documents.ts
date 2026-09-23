/**
 * Citable-document collection for a facilitator turn (issue #66).
 *
 * Tools return DocumentBlocks for the model; until now they reached only the
 * Gemini functionResponse and were discarded. This accumulator keeps the ones a
 * client may cite, in dispatch order, projected to the persisted `document`
 * ContentBlock shape.
 */
import type { DocumentBlock } from '../tools/types';
import type { DocumentContentBlock } from '@/db/schema/messages';

export interface CitableDocumentCollector {
  /** Feed one executed dispatch's documents, in dispatch order. */
  add(docs: DocumentBlock[]): void;
  /** The collected documents, or undefined (never []) when none were citable. */
  collected(): DocumentContentBlock[] | undefined;
}

export function createCitableDocumentCollector(): CitableDocumentCollector {
  const documents: DocumentContentBlock[] = [];
  const seen = new Set<string>();

  return {
    add(docs) {
      for (const doc of docs) {
        // Fail closed: notices (no results, unavailable, limit, unknown tool) set
        // enabled: false, and a missing flag is not treated as citable either.
        if (doc.citations?.enabled !== true) continue;
        // A JSON tuple, not a separator-joined string: all three fields are free text.
        const key = JSON.stringify([doc.title, doc.context ?? null, doc.source.data]);
        if (seen.has(key)) continue;
        seen.add(key);
        documents.push({
          type: 'document',
          source: {
            type: doc.source.type,
            media_type: doc.source.media_type,
            data: doc.source.data,
          },
          title: doc.title,
          ...(doc.context !== undefined ? { context: doc.context } : {}),
        });
      }
    },
    collected() {
      return documents.length > 0 ? documents : undefined;
    },
  };
}
