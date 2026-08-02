import { config } from '../config';
import type { ToolDescription, DocumentBlock, ToolResult, IslamicSearchTool } from './types';
import { trimCitationTitle } from './types';
import { fetchJsonWithTimeout, unavailableResult, reportDegradedTool, toolLabel, ToolFetchError } from './resilience';

interface KalimatQuranResult {
  id: string;      // e.g., "2:255" (Surah:Ayah)
  text: string;    // Arabic text
  en_text: string; // English translation
}

/**
 * Search Quran using Kalimat API
 */
export class SearchQuran implements IslamicSearchTool {
  private apiKey: string;
  private baseUrl = 'https://api.kalimat.dev/search';

  constructor() {
    this.apiKey = config.tools.kalemat.apiKey;
  }

  getToolName(): string {
    return 'search_quran';
  }

  getToolDescription(): ToolDescription {
    return {
      name: 'search_quran',
      description: `Search the Quran for verses related to a topic or keyword.
Returns verses with Arabic text and English translation.
Use this when the user asks about Quranic verses, ayahs, or wants to know what the Quran says about a topic.`,
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
        getText: '1',  // 1 = Quran
      });

      const data = await fetchJsonWithTimeout<KalimatQuranResult[]>(
        `${this.baseUrl}?${params}`,
        {
          headers: {
            'x-api-key': this.apiKey,
            'Accept': 'application/json',
          },
        },
        { errorPrefix: 'Kalemat API error' },
      );

      // A 200 whose body is not the expected array (an error object, a shape change) must
      // NOT be waved through as "No results found" — that would tell the model the source
      // had nothing to say, invisibly to the degraded counter and Sentry (issue #2). Fail
      // loudly through the existing degraded path instead. Note `!data.length` alone would
      // read `undefined` on a non-array and silently degrade to the benign empty branch.
      if (!Array.isArray(data)) {
        throw new ToolFetchError('Kalemat API error: unexpected response shape (expected an array)', {
          errorClass: 'invalid_body',
        });
      }

      if (data.length === 0) {
        return {
          content: 'No Quran verses found for this query.',
          documents: [{
            type: 'document',
            source: {
              type: 'text',
              media_type: 'text/plain',
              data: 'No results found.',
            },
            title: 'No Results',
            context: 'Quran Search',
            citations: { enabled: false },
          }],
        };
      }

      const documents: DocumentBlock[] = data.map((verse) => {
        const title = trimCitationTitle(`Quran ${verse.id}`);
        const content = JSON.stringify({
          ar: verse.text,
          en: verse.en_text,
        });

        return {
          type: 'document' as const,
          source: {
            type: 'text' as const,
            media_type: 'text/plain' as const,
            data: content,
          },
          title,
          context: 'Retrieved from the Holy Quran',
          citations: { enabled: true },
        };
      });

      return {
        content: 'Please see the Quran verses below.',
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
