// Export all tools
export * from './types';
export { SearchQuran } from './search-quran';
export { SearchHadith } from './search-hadith';
export { SearchMawsuah } from './search-mawsuah';
export { SearchTafsir } from './search-tafsir';

import { SearchQuran } from './search-quran';
import { SearchHadith } from './search-hadith';
import { SearchMawsuah } from './search-mawsuah';
import { SearchTafsir } from './search-tafsir';
import type { IslamicSearchTool, ToolDescription, GeminiTool } from './types';
import { SchemaType } from './types';

/**
 * Create all Islamic search tools
 */
export function createIslamicTools(): IslamicSearchTool[] {
  return [
    new SearchQuran(),
    new SearchHadith(),
    new SearchMawsuah(),
    new SearchTafsir(),
  ];
}

/**
 * Get tool descriptions for Claude
 */
export function getToolDescriptions(): ToolDescription[] {
  return createIslamicTools().map(tool => tool.getToolDescription());
}

/**
 * Create a map of tool name to tool instance
 */
export function createToolMap(): Map<string, IslamicSearchTool> {
  const tools = createIslamicTools();
  return new Map(tools.map(tool => [tool.getToolName(), tool]));
}

/**
 * Convert Claude tool descriptions to Gemini FunctionDeclaration format
 *
 * Claude format:
 * { name, description, input_schema: { type: 'object', properties, required } }
 *
 * Gemini format:
 * { name, description, parameters: { type: SchemaType.OBJECT, properties, required } }
 */
export function convertToGeminiTools(descriptions: ToolDescription[]): GeminiTool[] {
  return [
    {
      functionDeclarations: descriptions.map(desc => ({
        name: desc.name,
        description: desc.description,
        parameters: {
          type: SchemaType.OBJECT,
          properties: Object.fromEntries(
            Object.entries(desc.input_schema.properties).map(([key, val]) => [
              key,
              {
                type: SchemaType.STRING,
                description: val.description,
              },
            ])
          ),
          required: desc.input_schema.required,
        },
      })),
    },
  ];
}

/**
 * Get tool descriptions in Gemini format
 * Ready to pass to getGenerativeModel({ tools })
 */
export function getGeminiToolDescriptions(): GeminiTool[] {
  return convertToGeminiTools(getToolDescriptions());
}
