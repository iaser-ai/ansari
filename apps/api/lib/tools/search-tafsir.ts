import { config } from '../config';
import type { ToolDescription, DocumentBlock, ToolResult, IslamicSearchTool } from './types';
import { trimCitationTitle } from './types';
import { usulSearch } from './usul-client';
import { unavailableResult, reportDegradedTool, toolLabel, ToolFetchError } from './resilience';

const TAFSIR_BOOK_ID = 'l5oibf0iw7zzbc8m2h4hy7vp';
const TAFSIR_VERSION_ID = 'hvzQnv-4En';

/**
 * Search the Encyclopedia of Evidence-based Tafsir using Usul.ai API
 */
export class SearchTafsir implements IslamicSearchTool {
  private baseUrl: string;

  constructor() {
    this.baseUrl = `${config.tools.usul.baseUrl}/${TAFSIR_BOOK_ID}/${TAFSIR_VERSION_ID}`;
  }

  getToolName(): string {
    return 'search_tafsir_encyclopedia';
  }

  getToolDescription(): ToolDescription {
    return {
      name: 'search_tafsir_encyclopedia',
      description: `Search the Encyclopedia of Evidence-based Tafsir (Quran interpretation).
This provides scholarly commentary and explanation of Quranic verses.
Use this when the user wants to understand the meaning, context, or interpretation of Quran verses.`,
      input_schema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'The search query. Use Arabic for best results. Be specific about the topic or verse.',
          },
        },
        required: ['query'],
      },
    };
  }

  async run(query: string): Promise<ToolResult> {
    try {
      const data = await usulSearch(this.baseUrl, query);

      if (!data.results || data.results.length === 0) {
        return {
          content: 'No results found in the Tafsir Encyclopedia for this query.',
          documents: [{
            type: 'document',
            source: {
              type: 'text',
              media_type: 'text/plain',
              data: 'No results found.',
            },
            title: 'No Results',
            context: 'Tafsir Encyclopedia Search',
            citations: { enabled: false },
          }],
        };
      }

      const documents: DocumentBlock[] = data.results.map((result) => {
        let text = '';
        let nodeId = 'Unknown';
        let pageInfo = 'Unknown';
        let volumeInfo = '';
        let chapterInfo = '';

        // Handle new API response structure
        if (result.node) {
          text = result.node.text || '';
          if (result.node.metadata) {
            nodeId = result.node.metadata.bookId || 'Unknown';
            if (result.node.metadata.pages && result.node.metadata.pages.length > 0) {
              pageInfo = result.node.metadata.pages[0].page || 'Unknown';
              volumeInfo = result.node.metadata.pages[0].volume || '';
            }
            if (result.node.metadata.chapters && result.node.metadata.chapters.length > 0) {
              chapterInfo = result.node.metadata.chapters[0].title || '';
            }
          }
        } else {
          // Fallback to original structure
          text = result.text || '';
          nodeId = result.nodeId || 'Unknown';
          pageInfo = result.page || 'Unknown';
          if (result.chapter) {
            chapterInfo = result.chapter.title || '';
          }
        }

        // Build title
        const titleParts = ['Tafsir Encyclopedia'];
        if (volumeInfo) titleParts.push(`Volume ${volumeInfo}`);
        if (pageInfo !== 'Unknown') titleParts.push(`Page ${pageInfo}`);
        const title = trimCitationTitle(titleParts.join(', '));

        // Include chapter info in content if available
        const contentData = chapterInfo ? `Chapter: ${chapterInfo}\n\n${text}` : text;

        return {
          type: 'document' as const,
          source: {
            type: 'text' as const,
            media_type: 'text/plain' as const,
            data: contentData,
          },
          title,
          context: 'Retrieved from Encyclopedia of Evidence-based Tafsir',
          citations: { enabled: true },
        };
      });

      return {
        content: 'Please see the references from the Tafsir Encyclopedia below.',
        documents,
      };
    } catch (error) {
      // Degrade gracefully (Spec 43): never throw into the facilitator loop. Report
      // the degraded event with NON-PII metadata and return the unified
      // "temporarily unavailable" signal so the facilitator continues.
      const meta =
        error instanceof ToolFetchError
          ? { status: error.status, attempts: error.attempts, errorClass: error.errorClass }
          : {};
      reportDegradedTool({
        tool: this.getToolName(),
        provider: 'usul',
        queryLength: query.length,
        ...meta,
      });
      return unavailableResult(toolLabel(this.getToolName()));
    }
  }
}
