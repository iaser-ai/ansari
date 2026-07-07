import { config } from '../config';
import type { ToolDescription, DocumentBlock, ToolResult, IslamicSearchTool } from './types';
import { trimCitationTitle } from './types';
import { usulSearch } from './usul-client';
import { unavailableResult, reportDegradedTool, toolLabel, ToolFetchError } from './resilience';

const MAWSUAH_BOOK_ID = 'pet7s2sjr900zvxjsafa3s3b';
const MAWSUAH_VERSION_ID = 'MT3i8pDNoM';

/**
 * Search Mawsuah Al-Fiqhiyyah (Encyclopedia of Islamic Jurisprudence) using Usul.ai
 */
export class SearchMawsuah implements IslamicSearchTool {
  private baseUrl: string;

  constructor() {
    this.baseUrl = `${config.tools.usul.baseUrl}/${MAWSUAH_BOOK_ID}/${MAWSUAH_VERSION_ID}`;
  }

  getToolName(): string {
    return 'search_mawsuah';
  }

  getToolDescription(): ToolDescription {
    return {
      name: 'search_mawsuah',
      description: `Search the Encyclopedia of Islamic Jurisprudence (Al-Mawsuah Al-Fiqhiyyah).
This is a comprehensive encyclopedia of Islamic legal rulings across all schools of thought.
Use this for questions about fiqh (Islamic jurisprudence), halal/haram rulings, worship practices, and legal opinions.`,
      input_schema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'The search query. Use Arabic for best results. Be specific about the fiqh topic.',
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
          content: 'No results found in the Mawsuah for this query.',
          documents: [{
            type: 'document',
            source: {
              type: 'text',
              media_type: 'text/plain',
              data: 'No results found.',
            },
            title: 'No Results',
            context: 'Mawsuah Search',
            citations: { enabled: false },
          }],
        };
      }

      const documents: DocumentBlock[] = data.results.map((result) => {
        let text = '';
        let pageInfo = 'Unknown';
        let volumeInfo = '';
        let chapterInfo = '';

        // Handle new API response structure
        if (result.node) {
          text = result.node.text || '';
          if (result.node.metadata) {
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
          pageInfo = result.page || 'Unknown';
          if (result.chapter) {
            chapterInfo = result.chapter.title || '';
          }
        }

        // Build title
        const titleParts = ['Encyclopedia of Islamic Jurisprudence'];
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
          context: 'Retrieved from Encyclopedia of Islamic Jurisprudence',
          citations: { enabled: true },
        };
      });

      return {
        content: 'Please see the references from the Mawsuah below.',
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
