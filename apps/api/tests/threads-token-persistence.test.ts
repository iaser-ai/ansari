/**
 * Token-accounting persistence regression tests (issue #52).
 *
 * The frontend chat path is POST /api/v2/threads/[id] (this route), NOT the
 * sibling /threads/[id]/chat. Before the fix, this route's assistant-message
 * insert omitted the four token columns, so input_tokens / output_tokens /
 * thinking_tokens / total_tokens were NULL for ALL source='web' traffic even
 * though the facilitator threads usage up on the 'done' event.
 *
 * These tests drive the real facilitator + real gemini-client (via a mocked
 * @google/genai SDK, mirroring tests/gemini-truncation.test.ts) end-to-end
 * through the route and assert the persisted assistant row carries the tokens.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

type Chunk = {
  candidates?: Array<{ content?: { role: string; parts: unknown[] }; finishReason?: string }>;
  usageMetadata?: Record<string, number>;
};

// Scriptable SDK mock: each sendMessageStream call pops the next script.
const sdk = vi.hoisted(() => ({
  scripts: [] as Array<() => AsyncGenerator<unknown>>,
}));

vi.mock('@google/genai', () => ({
  ThinkingLevel: { LOW: 'LOW', HIGH: 'HIGH' },
  GoogleGenAI: class {
    constructor(_opts: unknown) {}
    chats = {
      create: () => ({
        sendMessageStream: async () => {
          const script = sdk.scripts.shift();
          if (!script) {
            return (async function* () {
              yield textChunk('default answer');
            })();
          }
          return script();
        },
      }),
    };
  },
}));

vi.mock('@sentry/nextjs', () => ({
  captureException: vi.fn(),
  addBreadcrumb: vi.fn(),
  setTag: vi.fn(),
}));

const mockAuthenticate = vi.fn();
vi.mock('@/lib/auth/middleware', () => ({
  authenticateRequest: (...a: unknown[]) => mockAuthenticate(...a),
  createErrorResponse: (detail: string, status = 400) =>
    new Response(JSON.stringify({ error: detail }), { status }),
}));

const mockFindThreadById = vi.fn();
const mockCreateMessage = vi.fn();
const mockFindMessagesByThread = vi.fn();
vi.mock('@/lib/db/threads', () => ({
  findThreadById: (...a: unknown[]) => mockFindThreadById(...a),
  createMessage: (...a: unknown[]) => mockCreateMessage(...a),
  findMessagesByThread: (...a: unknown[]) => mockFindMessagesByThread(...a),
  updateThread: vi.fn(),
  deleteThread: vi.fn(),
  getThreadWithMessages: vi.fn(),
}));

vi.mock('@/lib/ai/thread-naming', () => ({
  maybeGenerateThreadName: vi.fn().mockResolvedValue(undefined),
}));

// Keep the real facilitator + real gemini-client; only stub the Islamic tools so
// the facilitator resolves in a single iteration with no external services.
vi.mock('@/lib/tools', () => ({
  getGeminiToolDescriptions: () => [],
  createToolMap: () => new Map(),
}));

/** A terminal chunk carrying text + finishReason + full usageMetadata. */
function textChunk(
  text: string,
  usage?: Record<string, number>
): Chunk {
  const chunk: Chunk = {
    candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP' }],
  };
  if (usage) chunk.usageMetadata = usage;
  return chunk;
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
  process.env.JWT_SECRET = 'test-secret-key-for-testing-purposes-only-32chars';
  process.env.GEMINI_API_KEY = 'test-gemini-key';
  process.env.KALEMAT_API_KEY = 'test-kalemat-key';
  process.env.USUL_API_TOKEN = 'test-usul-token';
  process.env.GEMINI_MODEL = 'gemini-primary';
  process.env.GEMINI_FALLBACK_MODEL = 'gemini-primary';
  sdk.scripts = [];
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('POST /api/v2/threads/[id] token persistence (issue #52)', () => {
  const USER = { id: 'user-1', email: 'u@example.com' };
  const THREAD = { id: 'thread-1', userId: USER.id, name: null, source: 'web' };

  function makePost(threadId: string, content: string): NextRequest {
    return new NextRequest(`http://localhost/api/v2/threads/${threadId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    });
  }

  function routeContext(id: string) {
    return { params: Promise.resolve({ id }) };
  }

  function assistantCall() {
    return mockCreateMessage.mock.calls
      .map((c) => c[0])
      .find((m) => m.role === 'assistant');
  }

  beforeEach(() => {
    mockAuthenticate.mockResolvedValue({ user: USER });
    mockFindThreadById.mockResolvedValue(THREAD);
    mockCreateMessage.mockResolvedValue({ id: 'msg-1' });
    mockFindMessagesByThread.mockResolvedValue([
      { role: 'user', content: [{ type: 'text', text: 'What is sabr?' }] },
    ]);
  });

  it('persists the token counts from the stream on the assistant message', async () => {
    const ANSWER = 'Sabr means patience and steadfastness through hardship.';
    sdk.scripts = [
      async function* () {
        yield textChunk(ANSWER, {
          promptTokenCount: 11,
          candidatesTokenCount: 22,
          thoughtsTokenCount: 33,
          totalTokenCount: 66,
        });
      },
    ];

    const { POST } = await import('../src/app/api/v2/threads/[id]/route');
    const response = await POST(makePost(THREAD.id, 'What is sabr?'), routeContext(THREAD.id));
    // Drain the stream so the 'done' handler runs and persists the message.
    const body = await response.text();
    expect(body).toBe(ANSWER);

    const assistant = assistantCall();
    expect(assistant).toBeDefined();
    expect(assistant).toMatchObject({
      role: 'assistant',
      source: 'web',
      inputTokens: 11,
      outputTokens: 22,
      thinkingTokens: 33,
      totalTokens: 66,
    });
  });

  it('leaves token columns absent-safe (no crash) when the stream carries no usage', async () => {
    const ANSWER = 'Charity is rewarded manyfold.';
    sdk.scripts = [
      // A delivered answer with a finishReason but NO usageMetadata at all.
      async function* () {
        yield textChunk(ANSWER);
      },
    ];

    const { POST } = await import('../src/app/api/v2/threads/[id]/route');
    const response = await POST(
      makePost(THREAD.id, 'Is charity rewarded?'),
      routeContext(THREAD.id)
    );
    const body = await response.text();
    expect(body).toBe(ANSWER);

    // The message is still persisted (graceful — no throw), and the token
    // columns are written from the facilitator's summed usage.
    const assistant = assistantCall();
    expect(assistant).toBeDefined();
    expect(assistant.role).toBe('assistant');
    expect(assistant).toHaveProperty('inputTokens');
    expect(assistant).toHaveProperty('totalTokens');
  });
});
