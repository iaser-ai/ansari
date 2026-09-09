/**
 * SOURCE-SIDE: normalizes legacy (ansari-backend) message content into this schema's
 * `ContentBlock[]` — text blocks only. Tool blocks are DROPPED, not converted; the
 * `messages.tool_calls` column (migration 0007) is left untouched by the target side.
 *
 * For the next use (ansari-multisage Postgres → Better Auth) content is already
 * `ContentBlock[]`, so this module becomes a pass-through or is deleted.
 *
 * Part of a PARTIAL PORT — see scripts/migrate-users/README.md.
 */
import type { SourceMessage } from '../types';
import type { ContentBlock } from '../../../db/schema/messages';

export interface FilteredMessage {
  mongoId: string;
  role: string;
  content: ContentBlock[];
  createdAt: Date | null;
}

const KNOWN_DROP_TYPES = new Set(['tool_use', 'tool_result', 'document']);

export function filterMessage(message: SourceMessage): FilteredMessage | null {
  // Skip tool-role messages entirely
  if (message.role === 'tool') {
    return null;
  }

  // Handle null/empty content
  if (message.content == null || message.content === '') {
    return null;
  }

  let blocks: ContentBlock[];

  if (typeof message.content === 'string') {
    // Wrap string content as text block
    blocks = [{ type: 'text' as const, text: message.content }];
  } else if (Array.isArray(message.content)) {
    // Filter to text blocks only (allowlist)
    blocks = [];
    for (const block of message.content) {
      if (block.type === 'text' && 'text' in block) {
        blocks.push({ type: 'text' as const, text: block.text as string });
      } else if (!KNOWN_DROP_TYPES.has(block.type)) {
        console.warn(`  [content-filter] Dropping unrecognized content block type: "${block.type}"`);
      }
    }
  } else {
    return null;
  }

  // If no text blocks remain, skip this message
  if (blocks.length === 0) {
    return null;
  }

  return {
    mongoId: message.mongoId,
    role: message.role,
    content: blocks,
    createdAt: message.createdAt,
  };
}
