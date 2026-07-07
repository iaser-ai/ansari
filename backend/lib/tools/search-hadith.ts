import { config } from '../config';
import type { ToolDescription, DocumentBlock, ToolResult, IslamicSearchTool } from './types';
import { trimCitationTitle } from './types';
import { fetchWithTimeout, unavailableResult, reportDegradedTool, toolLabel, ToolFetchError } from './resilience';

interface KalimatHadithResult {
  id: string;
  source_book: string;
  chapter_number: string;
  chapter_english: string;
  section_number: string;
  section_english: string;
  hadith_number: string;
  en_text: string;
  ar_text: string;
  grade_en: string;
}

/**
 * Search Hadith collections using Kalimat API
 */
export class SearchHadith implements IslamicSearchTool {
  private apiKey: string;
  private baseUrl = 'https://api.kalimat.dev/search';

  constructor() {
    this.apiKey = config.tools.kalemat.apiKey;
  }

  getToolName(): string {
    return 'search_hadith';
  }

  getToolDescription(): ToolDescription {
    return {
      name: 'search_hadith',
      description: `Search Hadith collections for narrations from Prophet Muhammad (PBUH).
Returns hadith with Arabic text, English translation, and grading.
Searches across major collections including Bukhari, Muslim, and others.
Use this when the user asks about prophetic traditions or what the Prophet said about a topic.`,
      input_schema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'The search query. Can be in Arabic or English. Be specific about the topic.',
          },
        },
        required: ['query'],
      },
    };
  }

  async run(query: string): Promise<ToolResult> {
    try {
      const params = new URLSearchParams({
        query: query,
        numResults: '5',
        getText: '2',  // 2 = Hadith
        indexes: '["sunnah_lk"]',
      });

      const response = await fetchWithTimeout(
        `${this.baseUrl}?${params}`,
        {
          headers: {
            'x-api-key': this.apiKey,
            'Accept': 'application/json',
          },
        },
        { errorPrefix: 'Kalemat API error' },
      );

      const data: KalimatHadithResult[] = await response.json();

      if (!data || data.length === 0) {
        return {
          content: 'No hadith found for this query.',
          documents: [{
            type: 'document',
            source: {
              type: 'text',
              media_type: 'text/plain',
              data: 'No results found.',
            },
            title: 'No Results',
            context: 'Hadith Search',
            citations: { enabled: false },
          }],
        };
      }

      const documents: DocumentBlock[] = data.map((hadith) => {
        const grade = hadith.grade_en?.trim() || '';
        let title = `${hadith.source_book} - Chapter ${hadith.chapter_number}: ${hadith.chapter_english}, Hadith ${hadith.hadith_number}`;
        if (grade) {
          title += ` (Grade: ${grade})`;
        }
        title = trimCitationTitle(title);

        const content = JSON.stringify({
          ar: hadith.ar_text,
          en: hadith.en_text,
          grade: grade,
          collection: hadith.source_book,
          chapter: hadith.chapter_english,
        });

        return {
          type: 'document' as const,
          source: {
            type: 'text' as const,
            media_type: 'text/plain' as const,
            data: content,
          },
          title,
          context: `Retrieved from hadith collections`,
          citations: { enabled: true },
        };
      });

      return {
        content: 'Please see the hadith references below.',
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
        provider: 'kalemat',
        queryLength: query.length,
        ...meta,
      });
      return unavailableResult(toolLabel(this.getToolName()));
    }
  }
}
