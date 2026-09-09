/**
 * Silent mid-stream truncation regression tests (issue #41).
 *
 * Since prod moved to Vertex AI (Dynamic Shared Quota, ~2026-06-06), an
 * intermittent capacity 429 sometimes arrives as a SILENT mid-stream close: the
 * SDK stream just ends — no thrown error, no usageMetadata, no finishReason —
 * after the model emitted only a stray fragment (usually "}"). The route then
 * streamed and persisted that "}" as the answer. Fix #37's error-based retry
 * never saw it (nothing was thrown, and the "}" had already been delivered).
 *
 * The fix buffers the first few tokens in the Gemini layer (streamWithRetry) and,
 * when a stream ends without ever producing a finishReason, discards the fragment
 * and retries invisibly — so both the raw `/threads/[id]` route and the SSE
 * `/chat` route recover with NO wire-contract change. These tests mock the
 * @google/genai SDK (like tests/gemini-stream-retry.test.ts) to script the silent
 * close, and drive both the Gemini client and the raw route end-to-end.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

type Chunk = {
  candidates?: Array<{ content?: { role: string; parts: unknown[] }; finishReason?: string }>;
  usageMetadata?: Record<string, number>;
};

// Scriptable SDK mock: each establishment (sendMessageStream call) pops the next
// script and returns the async iterator it produces. A script may inspect the
// target model to simulate model-specific congestion.
const sdk = vi.hoisted(() => ({
  primaryModel: 'gemini-primary',
  establishCalls: 0,
  modelsTried: [] as string[],
  scripts: [] as Array<(model: string) => AsyncGenerator<unknown>>,
}));

vi.mock('@google/genai', () => ({
  ThinkingLevel: { LOW: 'LOW', HIGH: 'HIGH' },
  GoogleGenAI: class {
    constructor(_opts: unknown) {}
    chats = {
      create: (args: { model: string }) => ({
        sendMessageStream: async () => {
          sdk.establishCalls += 1;
          sdk.modelsTried.push(args.model);
          const script = sdk.scripts.shift();
          if (!script) {
            // eslint-disable-next-line require-yield
            return (async function* () {
              yield textChunk(`answer from ${args.model}`);
            })();
          }
          return script(args.model);
        },
      }),
    };
  },
}));

// Mocks used only by the route-level test. Harmless to the client-level tests.
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
  persistOrphanToolCalls: vi.fn(),
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

// Keep the real facilitator + real gemini-client (driven by the mocked SDK); only
// stub out the Islamic tools so the truncation path needs no external services.
vi.mock('@/lib/tools', () => ({
  getGeminiToolDescriptions: () => [],
  createToolMap: () => new Map(),
}));

/** A complete text chunk, as a real Gemini terminal chunk: text + finishReason + usage. */
function textChunk(text: string, finishReason: string | null = 'STOP'): Chunk {
  const candidate: NonNullable<Chunk['candidates']>[number] = {
    content: { role: 'model', parts: [{ text }] },
  };
  if (finishReason) candidate.finishReason = finishReason;
  return {
    candidates: [candidate],
    usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 7, totalTokenCount: 12 },
  };
}

/** A streamed text part with NO finishReason / usage — the silent-truncation fragment. */
function fragmentChunk(text: string): Chunk {
  return { candidates: [{ content: { role: 'model', parts: [{ text }] } }] };
}

/** A terminal chunk that only carries a finishReason (e.g. a SAFETY block: empty content). */
function finishOnlyChunk(finishReason: string): Chunk {
  return { candidates: [{ content: { role: 'model', parts: [] }, finishReason }] };
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
  process.env.GEMINI_FALLBACK_MODEL = 'gemini-fallback';
  sdk.primaryModel = 'gemini-primary';
  sdk.establishCalls = 0;
  sdk.modelsTried = [];
  sdk.scripts = [];
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('streamGemini silent truncation (issue #41)', () => {
  it('retries a silent mid-stream close that emitted only "}" — the fragment never reaches the caller', async () => {
    sdk.scripts = [
      // Attempt 1: the model emits a stray "}" then the stream silently closes —
      // no thrown error, no finishReason, no usage.
      async function* () {
        yield fragmentChunk('}');
      },
      // Attempt 2 (retry): the real answer.
      async function* () {
        yield textChunk('Sabr means patience in the face of trials.');
      },
    ];

    const { streamGemini } = await import('../lib/ai/gemini-client');

    const texts: string[] = [];
    let doneText: string | undefined;
    for await (const ev of streamGemini('What is sabr?')) {
      if (ev.type === 'text') texts.push(ev.data);
      if (ev.type === 'done') doneText = ev.response.text;
    }

    expect(texts).not.toContain('}'); // the stray fragment was discarded, never delivered
    expect(texts.join('')).toBe('Sabr means patience in the face of trials.');
    expect(doneText).toBe('Sabr means patience in the face of trials.');
    expect(sdk.establishCalls).toBe(2); // one truncated close + one successful retry
  });

  it('retries an empty silent close (stream ends with no chunks at all)', async () => {
    sdk.scripts = [
      // eslint-disable-next-line require-yield
      async function* () {
        // ends immediately: no chunk, no finishReason
      },
      async function* () {
        yield textChunk('Recovered answer');
      },
    ];

    const { streamGemini } = await import('../lib/ai/gemini-client');

    const texts: string[] = [];
    for await (const ev of streamGemini('What is sabr?')) {
      if (ev.type === 'text') texts.push(ev.data);
    }

    expect(texts.join('')).toBe('Recovered answer');
    expect(sdk.establishCalls).toBe(2);
  });

  it('does NOT retry a deliberate stop (SAFETY) — it carries a finishReason', async () => {
    sdk.scripts = [
      // A safety block in streaming arrives as empty content WITH a finishReason.
      async function* () {
        yield finishOnlyChunk('SAFETY');
      },
    ];

    const { streamGemini } = await import('../lib/ai/gemini-client');

    const texts: string[] = [];
    let doneText: string | undefined;
    for await (const ev of streamGemini('Something blocked')) {
      if (ev.type === 'text') texts.push(ev.data);
      if (ev.type === 'done') doneText = ev.response.text;
    }

    expect(texts).toEqual([]); // nothing to stream, but...
    expect(doneText).toBe(''); // ...delivered as a (empty) completed response
    expect(sdk.establishCalls).toBe(1); // NOT retried — finishReason present
  });

  it('does NOT flag a genuinely short answer that ends with a finishReason', async () => {
    sdk.scripts = [
      async function* () {
        yield textChunk('Yes.'); // 4 chars, below the char gate, but has STOP
      },
    ];

    const { streamGemini } = await import('../lib/ai/gemini-client');

    const texts: string[] = [];
    for await (const ev of streamGemini('Is charity rewarded?')) {
      if (ev.type === 'text') texts.push(ev.data);
    }

    expect(texts.join('')).toBe('Yes.');
    expect(sdk.establishCalls).toBe(1); // delivered, not mistaken for a truncation
  });

  it('after retries AND fallback all truncate, surfaces a clean TruncatedStreamError — never a "}"', async () => {
    // Every establishment (4 primary attempts + 1 fallback) silently closes on "}".
    const truncate = (): AsyncGenerator<unknown> =>
      (async function* () {
        yield fragmentChunk('}');
      })();
    sdk.scripts = [truncate, truncate, truncate, truncate, truncate];

    const { streamGemini, TruncatedStreamError } = await import('../lib/ai/gemini-client');

    const texts: string[] = [];
    let caught: unknown = null;
    try {
      for await (const ev of streamGemini('What is sabr?')) {
        if (ev.type === 'text') texts.push(ev.data);
      }
    } catch (e) {
      caught = e;
    }

    expect(texts).toEqual([]); // the "}" was never delivered to the caller
    expect(caught).toBeInstanceOf(TruncatedStreamError);
    expect(sdk.modelsTried.filter((m) => m === 'gemini-primary')).toHaveLength(4);
    expect(sdk.modelsTried.at(-1)).toBe('gemini-fallback');
  }, 15000);

  it('streams a normal multi-chunk answer byte-shape-identical (buffer flush preserves order)', async () => {
    sdk.scripts = [
      async function* () {
        // First chunk is below the 32-char gate (buffered); the second crosses it
        // (gate opens, both flush live); a terminal chunk carries the finishReason.
        yield fragmentChunk('Patience (sabr) is a virtue ');
        yield fragmentChunk('mentioned often in the Quran.');
        yield finishOnlyChunk('STOP');
      },
    ];

    const { streamGemini } = await import('../lib/ai/gemini-client');

    const texts: string[] = [];
    for await (const ev of streamGemini('What is sabr?')) {
      if (ev.type === 'text') texts.push(ev.data);
    }

    // Same chunks, same order, nothing added or dropped — only momentarily buffered.
    expect(texts).toEqual([
      'Patience (sabr) is a virtue ',
      'mentioned often in the Quran.',
    ]);
    expect(texts.join('')).toBe('Patience (sabr) is a virtue mentioned often in the Quran.');
    expect(sdk.establishCalls).toBe(1);
  });
});

describe('POST /api/v2/threads/[id] silent truncation (issue #41)', () => {
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

  beforeEach(() => {
    mockAuthenticate.mockResolvedValue({ user: USER });
    mockFindThreadById.mockResolvedValue(THREAD);
    mockCreateMessage.mockResolvedValue({ id: 'msg-1' });
    mockFindMessagesByThread.mockResolvedValue([
      { role: 'user', content: [{ type: 'text', text: 'What is sabr?' }] },
    ]);
  });

  it('recovers invisibly: client gets only the real answer (no leading "}") and the persisted message has no "}"', async () => {
    const ANSWER = 'Sabr means patience and steadfastness through hardship.';
    sdk.scripts = [
      // Attempt 1: silent close after a stray "}".
      async function* () {
        yield fragmentChunk('}');
      },
      // Attempt 2: the real answer.
      async function* () {
        yield textChunk(ANSWER);
      },
    ];

    const { POST } = await import('../src/app/api/v2/threads/[id]/route');
    const response = await POST(makePost(THREAD.id, 'What is sabr?'), routeContext(THREAD.id));

    // The raw wire body is exactly the recovered answer — no leading "}".
    const body = await response.text();
    expect(body).toBe(ANSWER);
    expect(body).not.toContain('}');

    // The persisted assistant message is the real answer, not a "}".
    const assistantCall = mockCreateMessage.mock.calls
      .map((c) => c[0])
      .find((m) => m.role === 'assistant');
    expect(assistantCall).toBeDefined();
    expect(assistantCall.content).toEqual([{ type: 'text', text: ANSWER }]);
    expect(assistantCall.content[0].text).not.toContain('}'); // not the degenerate fragment
  });

  it('streams a normal response byte-shape-identical on the wire (no contract change)', async () => {
    const PARTS = ['In Islam, ', 'sabr is among ', 'the highest virtues.'];
    sdk.scripts = [
      async function* () {
        for (const p of PARTS) yield fragmentChunk(p);
        yield finishOnlyChunk('STOP');
      },
    ];

    const { POST } = await import('../src/app/api/v2/threads/[id]/route');
    const response = await POST(makePost(THREAD.id, 'What is sabr?'), routeContext(THREAD.id));

    const body = await response.text();
    expect(body).toBe(PARTS.join('')); // exact bytes, in order, nothing added
    expect(sdk.establishCalls).toBe(1); // a normal stream is never retried
  });
});
