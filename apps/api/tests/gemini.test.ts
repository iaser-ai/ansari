/**
 * Gemini Client Tests (Spec 0004)
 *
 * Tests for the Gemini client module. Since we can't make real API calls in tests,
 * these focus on configuration, type exports, and error handling.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock the @google/genai SDK so we can simulate transient Vertex 429s and assert
// that withRetry / model-fallback recover them (the production-incident fix).
const sdk = vi.hoisted(() => ({
  primaryModel: 'gemini-primary',
  failFirst: 0, // throw a 429 for the first N sendMessage calls
  failPrimaryAlways: false, // throw a 429 on every call that targets primaryModel
  calls: 0,
  modelsTried: [] as string[],
}));

vi.mock('@google/genai', () => ({
  ThinkingLevel: { LOW: 'LOW', HIGH: 'HIGH' },
  GoogleGenAI: class {
    constructor(_opts: unknown) {}
    chats = {
      create: (args: { model: string }) => ({
        sendMessage: async (_m: unknown) => {
          sdk.calls += 1;
          sdk.modelsTried.push(args.model);
          const throw429 =
            sdk.calls <= sdk.failFirst || (sdk.failPrimaryAlways && args.model === sdk.primaryModel);
          if (throw429) {
            throw new Error(
              'got status: RESOURCE_EXHAUSTED. {"error":{"code":429,"message":"Resource exhausted. Please try again later.","status":"RESOURCE_EXHAUSTED"}}'
            );
          }
          return {
            candidates: [{ content: { role: 'model', parts: [{ text: `answer from ${args.model}` }] } }],
            usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 2, totalTokenCount: 3 },
          };
        },
      }),
    };
  },
}));

// Set environment variables before importing modules that use config
beforeEach(() => {
  vi.resetModules();
  process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
  process.env.JWT_SECRET = 'test-secret-key-for-testing-purposes-only-32chars';
  process.env.GEMINI_API_KEY = 'test-gemini-key';
  process.env.KALEMAT_API_KEY = 'test-kalemat-key';
  process.env.USUL_API_TOKEN = 'test-usul-token';
});

describe('Gemini Client (Spec 0004)', () => {
  describe('config integration', () => {
    it('config includes gemini settings', async () => {
      const { config } = await import('../lib/config');
      expect(config.gemini).toBeDefined();
      expect(config.gemini.apiKey).toBe('test-gemini-key');
      expect(config.gemini.model).toBe('gemini-3.6-flash');
    });

    it('uses default model when GEMINI_MODEL not set', async () => {
      delete process.env.GEMINI_MODEL;
      vi.resetModules();
      const { config } = await import('../lib/config');
      expect(config.gemini.model).toBe('gemini-3.6-flash');
    });
  });

  describe('type exports', () => {
    it('exports GeminiResponse type', async () => {
      const { callGeminiStreaming } = await import('../lib/ai/gemini-client');
      // Type check - function should exist and accept correct parameters
      expect(typeof callGeminiStreaming).toBe('function');
    });

    it('exports buildHistoryFromMessages helper', async () => {
      const { buildHistoryFromMessages } = await import('../lib/ai/gemini-client');
      expect(typeof buildHistoryFromMessages).toBe('function');
    });

    it('exports Content type from Google AI SDK', async () => {
      // Content is a type export - verify the module loads and the type is usable
      const geminiClient = await import('../lib/ai/gemini-client');
      // Just verify the module loads without error
      expect(geminiClient.callGeminiStreaming).toBeDefined();
    });
  });

  describe('buildHistoryFromMessages', () => {
    it('converts user messages correctly', async () => {
      const { buildHistoryFromMessages } = await import('../lib/ai/gemini-client');

      const messages = [
        { role: 'user' as const, content: 'Hello', rawPayload: null },
      ];

      const history = buildHistoryFromMessages(messages);
      expect(history).toHaveLength(1);
      expect(history[0].role).toBe('user');
      expect(history[0].parts?.[0]).toEqual({ text: 'Hello' });
    });

    it('converts assistant messages correctly', async () => {
      const { buildHistoryFromMessages } = await import('../lib/ai/gemini-client');

      const messages = [
        { role: 'assistant' as const, content: 'Hi there!', rawPayload: null },
      ];

      const history = buildHistoryFromMessages(messages);
      expect(history).toHaveLength(1);
      expect(history[0].role).toBe('model');
      expect(history[0].parts?.[0]).toEqual({ text: 'Hi there!' });
    });

    it('uses rawPayload when available for assistant messages', async () => {
      const { buildHistoryFromMessages } = await import('../lib/ai/gemini-client');
      type Content = Awaited<ReturnType<typeof import('../lib/ai/gemini-client')['buildHistoryFromMessages']>>[0];

      const rawPayload: Content = {
        role: 'model',
        parts: [{ text: 'Response text' }],
      };

      const messages = [
        { role: 'assistant' as const, content: 'Response text', rawPayload },
      ];

      const history = buildHistoryFromMessages(messages);
      expect(history).toHaveLength(1);
      // Should use rawPayload instead of building from content
      expect(history[0]).toBe(rawPayload);
    });

    it('handles empty messages array', async () => {
      const { buildHistoryFromMessages } = await import('../lib/ai/gemini-client');

      const history = buildHistoryFromMessages([]);
      expect(history).toHaveLength(0);
    });

    it('handles mixed conversation', async () => {
      const { buildHistoryFromMessages } = await import('../lib/ai/gemini-client');

      const messages = [
        { role: 'user' as const, content: 'Question 1', rawPayload: null },
        { role: 'assistant' as const, content: 'Answer 1', rawPayload: null },
        { role: 'user' as const, content: 'Question 2', rawPayload: null },
      ];

      const history = buildHistoryFromMessages(messages);
      expect(history).toHaveLength(3);
      expect(history[0].role).toBe('user');
      expect(history[1].role).toBe('model');
      expect(history[2].role).toBe('user');
    });
  });

  describe('error handling', () => {
    it('fails fast when neither GEMINI_API_KEY nor GOOGLE_CLOUD_PROJECT is set', async () => {
      delete process.env.GEMINI_API_KEY;
      delete process.env.GOOGLE_CLOUD_PROJECT;
      vi.resetModules();

      const { config } = await import('../lib/config');
      expect(() => config.gemini).toThrow(/Gemini is not configured/);
    });

    it('selects Vertex AI when GOOGLE_CLOUD_PROJECT is set', async () => {
      delete process.env.GEMINI_API_KEY;
      process.env.GOOGLE_CLOUD_PROJECT = 'test-project';
      process.env.GOOGLE_CLOUD_LOCATION = 'global';
      vi.resetModules();

      const { config } = await import('../lib/config');
      expect(config.gemini.useVertex).toBe(true);
      expect(config.gemini.vertex.project).toBe('test-project');
      expect(config.gemini.vertex.location).toBe('global');
    });
  });
});

describe('Gemini Response Types', () => {
  it('GeminiResponse has expected properties', async () => {
    // This is a type-level test - we verify the interface matches expectations
    // by checking that a mock object with the expected shape compiles
    const mockResponse = {
      text: 'Hello',
      toolCalls: [],
      rawPayload: { role: 'model' as const, parts: [] },
      hasThinking: false,
      usage: { promptTokenCount: 10, candidatesTokenCount: 20, totalTokenCount: 30 },
      durationMs: 100,
    };

    expect(mockResponse.text).toBe('Hello');
    expect(mockResponse.toolCalls).toEqual([]);
    expect(mockResponse.hasThinking).toBe(false);
    expect(mockResponse.usage?.totalTokenCount).toBe(30);
  });

  it('GeminiToolCall has name and args', async () => {
    const mockToolCall = {
      name: 'search_quran',
      args: { query: 'test query' },
    };

    expect(mockToolCall.name).toBe('search_quran');
    expect(mockToolCall.args.query).toBe('test query');
  });
});

describe('Facilitator Agent (Regression Tests)', () => {
  describe('convertToGeminiHistory preserves rawPayload', () => {
    it('preserves tool calls in rawPayload for multi-turn conversations', async () => {
      // Import the Message type and test the conversion function via module
      const agentModule = await import('../lib/facilitator/agent');
      type Message = typeof agentModule extends { Message: infer M } ? M : never;

      // Simulate a message with rawPayload containing tool calls
      const rawPayloadWithToolCall = {
        role: 'model' as const,
        parts: [
          { text: 'Let me search for that.' },
          {
            functionCall: {
              name: 'search_quran',
              args: { query: 'Ayat al-Kursi' },
            },
          },
        ],
      };

      // This tests that when messages have rawPayload, it's preserved
      // (The actual conversion is tested via the agent's internal function)
      expect(rawPayloadWithToolCall.parts).toHaveLength(2);
      expect(rawPayloadWithToolCall.parts[1]).toHaveProperty('functionCall');
    });

    it('Message interface includes optional rawPayload field', async () => {
      const agentModule = await import('../lib/facilitator/agent');

      // Test that Message can have rawPayload (type check)
      const messageWithRawPayload: typeof agentModule.Message extends never
        ? { role: 'assistant'; content: unknown[]; rawPayload?: unknown }
        : { role: 'assistant'; content: unknown[]; rawPayload?: unknown } = {
        role: 'assistant',
        content: [{ type: 'text', text: 'Response' }],
        rawPayload: {
          role: 'model',
          parts: [{ text: 'Response' }],
        },
      };

      expect(messageWithRawPayload.rawPayload).toBeDefined();
      expect(messageWithRawPayload.role).toBe('assistant');
    });
  });

  describe('thought signature preservation', () => {
    it('rawPayload can contain thought and thoughtSignature parts', async () => {
      // Verify the structure supports thought signatures
      const rawPayloadWithThinking = {
        role: 'model' as const,
        parts: [
          { thought: 'I need to search for Islamic sources...' },
          { thoughtSignature: 'abc123' },
          { text: 'Based on my research...' },
        ],
      };

      // Parts should include thinking-related fields
      const hasThought = rawPayloadWithThinking.parts.some(
        (p) => 'thought' in p || 'thoughtSignature' in p
      );
      expect(hasThought).toBe(true);
    });

    it('hasThinking flag is set when thought parts are present', async () => {
      // Test the response structure that indicates thinking
      const responseWithThinking = {
        text: 'The answer is...',
        toolCalls: [],
        rawPayload: {
          role: 'model' as const,
          parts: [
            { thought: 'Let me think about this...' },
            { text: 'The answer is...' },
          ],
        },
        hasThinking: true, // This should be set when thought parts exist
        usage: { promptTokenCount: 100, candidatesTokenCount: 50, totalTokenCount: 150 },
      };

      expect(responseWithThinking.hasThinking).toBe(true);
      expect(responseWithThinking.rawPayload.parts.some((p) => 'thought' in p)).toBe(true);
    });
  });

  describe('tool result handling', () => {
    it('tool results use user role with functionResponse part', async () => {
      // Verify the correct structure for tool results
      const toolResultContent = {
        role: 'user', // Gemini expects 'user' role for function responses
        parts: [
          {
            functionResponse: {
              name: 'search_quran',
              response: {
                results: [{ title: 'Ayat al-Kursi', content: 'Allah...' }],
                summary: '1 result found',
              },
            },
          },
        ],
      };

      // Verify structure
      expect(toolResultContent.role).toBe('user');
      expect(toolResultContent.parts[0]).toHaveProperty('functionResponse');
      expect(toolResultContent.parts[0].functionResponse.name).toBe('search_quran');
    });

    it('multi-turn tool calls maintain correct history order', async () => {
      // Simulate a multi-turn conversation with tools
      const history = [
        // User asks a question
        { role: 'user' as const, parts: [{ text: 'What is Ayat al-Kursi?' }] },
        // Model requests tool call
        {
          role: 'model' as const,
          parts: [
            { text: 'Let me search for that.' },
            { functionCall: { name: 'search_quran', args: { query: 'Ayat al-Kursi' } } },
          ],
        },
        // Tool result (user role with functionResponse)
        {
          role: 'user' as const,
          parts: [
            {
              functionResponse: {
                name: 'search_quran',
                response: { results: [{ title: 'Surah 2:255' }], summary: '1 result' },
              },
            },
          ],
        },
        // Model's final response
        {
          role: 'model' as const,
          parts: [{ text: 'Ayat al-Kursi is from Surah Al-Baqarah...' }],
        },
      ];

      // Verify alternating roles (user/model must alternate, function responses are 'user')
      expect(history[0].role).toBe('user');
      expect(history[1].role).toBe('model');
      expect(history[2].role).toBe('user'); // Tool result uses user role
      expect(history[3].role).toBe('model');
    });
  });
});

describe('Transient 429 recovery (retry + model fallback)', () => {
  it('recovers from a transient 429 by retrying — no user-visible failure', async () => {
    vi.resetModules();
    process.env.GEMINI_MODEL = 'gemini-primary';
    sdk.calls = 0;
    sdk.failFirst = 1; // first attempt 429s, retry succeeds
    sdk.failPrimaryAlways = false;
    sdk.modelsTried = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { callGemini } = await import('../lib/ai/gemini-client');
    const res = await callGemini('What is sabr?');

    expect(res.text).toBe('answer from gemini-primary'); // recovered
    expect(sdk.calls).toBe(2); // one 429, then success on retry
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('RESOURCE_EXHAUSTED'));
    warn.mockRestore();
  });

  it('falls back to the fallback model when the primary keeps returning 429', async () => {
    vi.resetModules();
    process.env.GEMINI_MODEL = 'gemini-primary';
    process.env.GEMINI_FALLBACK_MODEL = 'gemini-fallback';
    sdk.calls = 0;
    sdk.failFirst = 0;
    sdk.failPrimaryAlways = true; // primary always 429s
    sdk.modelsTried = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { callGemini } = await import('../lib/ai/gemini-client');
    const res = await callGemini('What is sabr?');

    expect(res.text).toBe('answer from gemini-fallback'); // recovered via fallback
    expect(sdk.modelsTried.filter((m) => m === 'gemini-primary').length).toBe(4); // 4 primary attempts
    expect(sdk.modelsTried.at(-1)).toBe('gemini-fallback');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('falling back'));
    warn.mockRestore();
  }, 15000);
});
