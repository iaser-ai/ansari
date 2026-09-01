/**
 * Tool types for Claude's and Gemini's tool use
 */

import { Type, type Tool, type FunctionDeclaration } from '@google/genai';
// Type-only: resilience.ts type-imports ToolResult from here, so this cycle is
// erased at runtime and introduces no circular module dependency.
import type { ToolFetchErrorClass } from './resilience';

// Re-export Gemini types for convenience
// SchemaType kept as a backwards-compatible alias for Type (renamed in @google/genai migration).
export { Type as SchemaType, Type };
export type { Tool as GeminiTool, FunctionDeclaration };

/**
 * Claude tool description format
 */
export interface ToolDescription {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, {
      type: string;
      description: string;
    }>;
    required: string[];
  };
}

export interface DocumentBlock {
  type: 'document';
  source: {
    type: 'text';
    media_type: 'text/plain';
    data: string;
  };
  title: string;
  context?: string;
  citations?: {
    enabled: boolean;
  };
}

export interface ToolResult {
  content: string;
  documents: DocumentBlock[];
  /**
   * Machine-readable degradation marker (issue #54). `true` only when the tool
   * could not consult its source and returned the unified "temporarily
   * unavailable" result (see `unavailableResult`). Consumers (e.g. the #49
   * request-time budget's fail-fast) MUST detect degradation via this flag —
   * never by string-matching the human-facing `content`. Absent/undefined means
   * a normal result (including a successful search that found nothing).
   */
  isDegraded?: boolean;
  /**
   * Why/how the tool degraded (spec 73), for the persisted dispatch record.
   * Present only alongside `isDegraded`, and every field is optional: a
   * non-ToolFetchError failure carries nothing, the facilitator's backstop
   * knows only an error class. `attempts` is 2 on a retried timeout (#76).
   * Never reaches the model — formatToolResultForGemini maps fields explicitly.
   */
  degradation?: ToolDegradation;
}

export interface ToolDegradation {
  errorClass?: ToolFetchErrorClass;
  attempts?: number;
  status?: number;
}

/**
 * Base interface for Islamic search tools
 */
export interface IslamicSearchTool {
  /**
   * Get the tool description for Claude
   */
  getToolDescription(): ToolDescription;

  /**
   * Get the tool name
   */
  getToolName(): string;

  /**
   * Run the search and return formatted results
   */
  run(query: string): Promise<ToolResult>;
}

/**
 * Usul.ai vector search response format (shared by SearchMawsuah and SearchTafsir)
 */
export interface UsulSearchResult {
  results?: Array<{
    node?: {
      text: string;
      metadata?: {
        bookId?: string;
        pages?: Array<{
          page: string;
          volume: string;
        }>;
        chapters?: Array<{
          title: string;
        }>;
      };
    };
    text?: string;
    nodeId?: string;
    page?: string;
    chapter?: {
      title: string;
    };
  }>;
  total?: number;
}

/**
 * Truncate citation title to reasonable length
 */
export function trimCitationTitle(title: string, maxLength = 100): string {
  if (title.length <= maxLength) return title;
  return title.substring(0, maxLength - 3) + '...';
}
