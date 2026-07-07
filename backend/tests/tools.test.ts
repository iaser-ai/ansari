import { describe, it, expect, beforeEach } from 'vitest';
import {
  createToolMap,
  getToolDescriptions,
  trimCitationTitle,
  convertToGeminiTools,
  getGeminiToolDescriptions,
} from '../lib/tools';
import { Type as SchemaType, type Tool as FunctionDeclarationsTool, type FunctionDeclaration } from '@google/genai';

// Set environment variables for config
beforeEach(() => {
  process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
  process.env.JWT_SECRET = 'test-secret-key-for-testing-purposes-only-32chars';
  process.env.GEMINI_API_KEY = 'test-gemini-key';
  process.env.KALEMAT_API_KEY = 'test-kalemat-key';
  process.env.USUL_API_TOKEN = 'test-usul-token';
});

describe('Islamic Tools', () => {
  describe('getToolDescriptions', () => {
    it('returns descriptions for all 4 tools', () => {
      const descriptions = getToolDescriptions();
      expect(descriptions).toHaveLength(4);
    });

    it('includes search_quran tool', () => {
      const descriptions = getToolDescriptions();
      const quranTool = descriptions.find(t => t.name === 'search_quran');
      expect(quranTool).toBeDefined();
      expect(quranTool?.input_schema.properties.query).toBeDefined();
    });

    it('includes search_hadith tool', () => {
      const descriptions = getToolDescriptions();
      const hadithTool = descriptions.find(t => t.name === 'search_hadith');
      expect(hadithTool).toBeDefined();
    });

    it('includes search_mawsuah tool', () => {
      const descriptions = getToolDescriptions();
      const mawsuahTool = descriptions.find(t => t.name === 'search_mawsuah');
      expect(mawsuahTool).toBeDefined();
    });

    it('includes search_tafsir_encyclopedia tool', () => {
      const descriptions = getToolDescriptions();
      const tafsirTool = descriptions.find(t => t.name === 'search_tafsir_encyclopedia');
      expect(tafsirTool).toBeDefined();
    });
  });

  describe('createToolMap', () => {
    it('creates a map with all tools', () => {
      const toolMap = createToolMap();
      expect(toolMap.size).toBe(4);
      expect(toolMap.has('search_quran')).toBe(true);
      expect(toolMap.has('search_hadith')).toBe(true);
      expect(toolMap.has('search_mawsuah')).toBe(true);
      expect(toolMap.has('search_tafsir_encyclopedia')).toBe(true);
    });
  });

  describe('trimCitationTitle', () => {
    it('returns short titles unchanged', () => {
      const title = 'Short Title';
      expect(trimCitationTitle(title)).toBe(title);
    });

    it('truncates long titles', () => {
      const longTitle = 'A'.repeat(150);
      const result = trimCitationTitle(longTitle);
      expect(result.length).toBe(100);
      expect(result.endsWith('...')).toBe(true);
    });

    it('respects custom max length', () => {
      const title = 'A'.repeat(50);
      const result = trimCitationTitle(title, 20);
      expect(result.length).toBe(20);
    });
  });

  describe('convertToGeminiTools (Spec 0004)', () => {
    it('converts Claude tool format to Gemini format', () => {
      const claudeTools = getToolDescriptions();
      const geminiTools = convertToGeminiTools(claudeTools);

      // Should return array with single Tool object containing functionDeclarations
      expect(geminiTools).toHaveLength(1);
      const tool = geminiTools[0] as FunctionDeclarationsTool;
      expect(tool.functionDeclarations).toBeDefined();
      expect(tool.functionDeclarations).toHaveLength(4);
    });

    it('preserves tool names and descriptions', () => {
      const claudeTools = getToolDescriptions();
      const geminiTools = convertToGeminiTools(claudeTools);
      const tool = geminiTools[0] as FunctionDeclarationsTool;
      const declarations = tool.functionDeclarations!;

      const quranTool = declarations.find((d: FunctionDeclaration) => d.name === 'search_quran');
      expect(quranTool).toBeDefined();
      expect(quranTool?.description).toContain('Quran');
    });

    it('converts parameters to Gemini SchemaType format', () => {
      const claudeTools = getToolDescriptions();
      const geminiTools = convertToGeminiTools(claudeTools);
      const tool = geminiTools[0] as FunctionDeclarationsTool;
      const declarations = tool.functionDeclarations!;

      const quranTool = declarations.find((d: FunctionDeclaration) => d.name === 'search_quran');
      expect(quranTool?.parameters?.type).toBe(SchemaType.OBJECT);
      expect(quranTool?.parameters?.properties?.query?.type).toBe(SchemaType.STRING);
    });

    it('preserves required fields', () => {
      const claudeTools = getToolDescriptions();
      const geminiTools = convertToGeminiTools(claudeTools);
      const tool = geminiTools[0] as FunctionDeclarationsTool;
      const declarations = tool.functionDeclarations!;

      const quranTool = declarations.find((d: FunctionDeclaration) => d.name === 'search_quran');
      expect(quranTool?.parameters?.required).toContain('query');
    });
  });

  describe('getGeminiToolDescriptions (Spec 0004)', () => {
    it('returns tools ready for Gemini getGenerativeModel', () => {
      const tools = getGeminiToolDescriptions();

      expect(tools).toHaveLength(1);
      const tool = tools[0] as FunctionDeclarationsTool;
      expect(tool.functionDeclarations).toHaveLength(4);
    });
  });
});
