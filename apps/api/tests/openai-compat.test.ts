/**
 * Tests for the OpenAI-compatible /v1/chat/completions adapter (Spec 19).
 *
 * Behavior under test:
 *  - Auth: missing/invalid bearer → 401; missing LEADERBOARD_API_KEY → 503.
 *  - Body validation: stream:true → 400, invalid JSON → 400.
 *  - Letter-answer mode kicks in when max_tokens <= 16 or the prompt
 *    contains an MCQ pattern; the response content is reduced to the
 *    single letter the model emitted.
 *  - Response envelope matches OpenAI chat.completion shape and surfaces
 *    token usage from the facilitator.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const API_KEY = 'test-leaderboard-key-must-be-at-least-32-chars-long';

beforeEach(() => {
  vi.resetModules();
  process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
  process.env.JWT_SECRET = 'test-secret-key-for-testing-purposes-only-32chars';
  process.env.GEMINI_API_KEY = 'test-gemini-key';
  process.env.KALEMAT_API_KEY = 'test-kalemat-key';
  process.env.USUL_API_TOKEN = 'test-usul-token';
  process.env.LEADERBOARD_API_KEY = API_KEY;
  // Inkling (issue #74) is opt-in per test; default = unset.
  delete process.env.TINKER_API_KEY;
});

// Default-allow mocks for DB and facilitator. Individual tests override.
const mockGetOrCreateSystemUser = vi.fn();
const mockCreateThread = vi.fn();
const mockCreateMessage = vi.fn();
const mockRunFacilitator = vi.fn();

vi.mock('@/lib/db/users', () => ({
  getOrCreateSystemUser: (...args: unknown[]) => mockGetOrCreateSystemUser(...args),
}));
vi.mock('@/lib/db/threads', () => ({
  createThread: (...args: unknown[]) => mockCreateThread(...args),
  createMessage: (...args: unknown[]) => mockCreateMessage(...args),
}));

// The route wraps pre-stream persistence in db.transaction (issue #20);
// pass the callback straight through so the mocked helpers above still run.
vi.mock('@/lib/db/index', () => ({
  db: { transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({}) },
}));
vi.mock('@/lib/facilitator/agent', () => ({
  runFacilitator: (...args: unknown[]) => mockRunFacilitator(...args),
}));
vi.mock('@sentry/nextjs', () => ({
  setTag: vi.fn(),
  captureException: vi.fn(),
  captureMessage: vi.fn(),
}));

const SYSTEM_USER = {
  id: 'leaderboard-system-user-id',
  email: 'leaderboard@system.ansari.chat',
  passwordHash: 'nologin',
  firstName: 'Leaderboard',
  lastName: 'System User',
  source: 'leaderboard',
  createdAt: new Date(),
  updatedAt: new Date(),
};

const MOCK_THREAD = {
  id: 'leaderboard-thread-id-1',
  userId: SYSTEM_USER.id,
  name: null,
  source: 'leaderboard',
  createdAt: new Date(),
  updatedAt: new Date(),
};

function makeRequest(body: unknown, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest('http://localhost/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

async function* facilitatorEmits(text: string, usage?: Record<string, number>) {
  yield { type: 'text' as const, data: text };
  yield {
    type: 'done' as const,
    data: '',
    usage: usage
      ? {
          promptTokenCount: usage.prompt ?? 0,
          candidatesTokenCount: usage.candidates ?? 0,
          thoughtsTokenCount: usage.thoughts ?? 0,
          totalTokenCount: usage.total ?? 0,
        }
      : undefined,
  };
}

function setupSuccessfulMocks(text = 'Sample answer', usage?: Record<string, number>) {
  mockGetOrCreateSystemUser.mockResolvedValue(SYSTEM_USER);
  mockCreateThread.mockResolvedValue(MOCK_THREAD);
  mockCreateMessage.mockResolvedValue({ id: 'msg-1' });
  mockRunFacilitator.mockReturnValue(facilitatorEmits(text, usage));
}

const AUTH = { authorization: `Bearer ${API_KEY}` };
const MCQ_PROMPT =
  'Which of the following is a pillar of Islam?\nA) Salah\nB) Yoga\nC) Meditation\nD) Tai chi';

describe('POST /v1/chat/completions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupSuccessfulMocks();
  });

  it('rejects requests without a bearer token (401)', async () => {
    const { POST } = await import('../src/app/api/v1/chat/completions/route');
    const res = await POST(
      makeRequest({ model: 'ansari-facilitator', messages: [{ role: 'user', content: 'hi' }] })
    );
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe('invalid_api_key');
  });

  it('rejects requests with the wrong bearer token (401)', async () => {
    const { POST } = await import('../src/app/api/v1/chat/completions/route');
    const res = await POST(
      makeRequest(
        { model: 'ansari-facilitator', messages: [{ role: 'user', content: 'hi' }] },
        { authorization: 'Bearer wrong-key' }
      )
    );
    expect(res.status).toBe(401);
  });

  it('rejects a wrong key of the SAME length (constant-time content compare, spec 4)', async () => {
    // Same byte-length as API_KEY but different content — exercises the
    // timingSafeEqual content comparison, not just the length short-circuit.
    const sameLenWrong = 'X'.repeat(API_KEY.length);
    const { POST } = await import('../src/app/api/v1/chat/completions/route');
    const res = await POST(
      makeRequest(
        { model: 'ansari-facilitator', messages: [{ role: 'user', content: 'hi' }] },
        { authorization: `Bearer ${sameLenWrong}` }
      )
    );
    expect(res.status).toBe(401);
  });

  it('returns 503 when LEADERBOARD_API_KEY is not configured', async () => {
    delete process.env.LEADERBOARD_API_KEY;
    const { POST } = await import('../src/app/api/v1/chat/completions/route');
    const res = await POST(
      makeRequest({ model: 'ansari-facilitator', messages: [{ role: 'user', content: 'hi' }] }, AUTH)
    );
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error.code).toBe('not_configured');
  });

  it('rejects stream:true requests (400)', async () => {
    const { POST } = await import('../src/app/api/v1/chat/completions/route');
    const res = await POST(
      makeRequest(
        { model: 'ansari-facilitator', messages: [{ role: 'user', content: 'hi' }], stream: true },
        AUTH
      )
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('streaming_unsupported');
  });

  it('rejects invalid JSON bodies (400)', async () => {
    const { POST } = await import('../src/app/api/v1/chat/completions/route');
    const res = await POST(makeRequest('{not valid json', AUTH));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('invalid_json');
  });

  it('returns OpenAI-shaped envelope with usage when present', async () => {
    setupSuccessfulMocks('The answer is patience.', {
      prompt: 100, candidates: 5, thoughts: 12, total: 117,
    });
    const { POST } = await import('../src/app/api/v1/chat/completions/route');
    const res = await POST(
      makeRequest(
        { model: 'ansari-facilitator', messages: [{ role: 'user', content: 'Tell me about patience.' }] },
        AUTH
      )
    );
    expect(res.status).toBe(200);
    // Endpoint→identity mapping (spec 4): the leaderboard endpoint resolves its
    // system user by the 'leaderboard' key.
    expect(mockGetOrCreateSystemUser).toHaveBeenCalledWith('leaderboard');
    const body = await res.json();
    expect(body.object).toBe('chat.completion');
    // Response.model is the backend's id, not the caller's input, per OpenAI spec.
    expect(body.model).toBe('ansari-facilitator');
    expect(body.choices[0].message.role).toBe('assistant');
    expect(body.choices[0].message.content).toBe('The answer is patience.');
    expect(body.choices[0].finish_reason).toBe('stop');
    expect(body.usage).toEqual({
      prompt_tokens: 100,
      completion_tokens: 5,
      total_tokens: 117,
      completion_tokens_details: { reasoning_tokens: 12 },
    });
  });

  it('letter-answer mode: reduces content to a single letter when max_tokens<=16', async () => {
    setupSuccessfulMocks('Answer: B');
    const { POST } = await import('../src/app/api/v1/chat/completions/route');
    const res = await POST(
      makeRequest(
        {
          model: 'ansari-facilitator',
          messages: [{ role: 'user', content: 'Which letter? A B C D' }],
          max_tokens: 8,
        },
        AUTH
      )
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.choices[0].message.content).toBe('B');
  });

  it('letter-answer mode: triggers on MCQ prompt shape even at default max_tokens', async () => {
    setupSuccessfulMocks('A');
    const { POST } = await import('../src/app/api/v1/chat/completions/route');
    const res = await POST(
      makeRequest({ model: 'ansari-facilitator', messages: [{ role: 'user', content: MCQ_PROMPT }] }, AUTH)
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.choices[0].message.content).toBe('A');
  });

  it('non-letter mode: leaves full prose intact', async () => {
    setupSuccessfulMocks('Patience is mentioned many times.');
    const { POST } = await import('../src/app/api/v1/chat/completions/route');
    const res = await POST(
      makeRequest(
        {
          model: 'ansari-facilitator',
          messages: [{ role: 'user', content: 'What does the Quran say about patience?' }],
        },
        AUTH
      )
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.choices[0].message.content).toBe('Patience is mentioned many times.');
  });

  it('logs the assistant message with token counts when usage is present', async () => {
    setupSuccessfulMocks('Some answer', { prompt: 10, candidates: 2, thoughts: 3, total: 15 });
    const { POST } = await import('../src/app/api/v1/chat/completions/route');
    await POST(
      makeRequest(
        { model: 'ansari-facilitator', messages: [{ role: 'user', content: 'What about sabr?' }] },
        AUTH
      )
    );
    // Last createMessage call is the assistant row
    const assistantCalls = mockCreateMessage.mock.calls.filter(
      ([arg]) => (arg as { role: string }).role === 'assistant'
    );
    expect(assistantCalls.length).toBe(1);
    expect(assistantCalls[0][0]).toMatchObject({
      role: 'assistant',
      source: 'leaderboard',
      inputTokens: 10,
      outputTokens: 2,
      thinkingTokens: 3,
      totalTokens: 15,
    });
  });

  it('attributes the thread + messages from X-Ansari-Client (source stays leaderboard) — spec 56', async () => {
    setupSuccessfulMocks('Some answer');
    const { POST } = await import('../src/app/api/v1/chat/completions/route');

    await POST(
      makeRequest(
        { model: 'ansari-facilitator', messages: [{ role: 'user', content: 'What about sabr?' }] },
        { ...AUTH, 'X-Ansari-Client': 'muslimpedia' }
      )
    );

    // Thread carries client (not just messages) while source stays leaderboard.
    expect(mockCreateThread).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'leaderboard', client: 'muslimpedia' }),
      expect.anything()
    );
    for (const [arg] of mockCreateMessage.mock.calls) {
      expect(arg).toEqual(expect.objectContaining({ source: 'leaderboard', client: 'muslimpedia' }));
    }
  });

  it('client is null when the header is absent (unchanged behavior) — spec 56', async () => {
    setupSuccessfulMocks('Some answer');
    const { POST } = await import('../src/app/api/v1/chat/completions/route');

    await POST(
      makeRequest({ model: 'ansari-facilitator', messages: [{ role: 'user', content: 'Q' }] }, AUTH)
    );

    expect(mockCreateThread).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'leaderboard', client: null }),
      expect.anything()
    );
  });
});

describe('model routing (issue #74)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupSuccessfulMocks();
  });

  it('unknown model id → 400 model_not_found, facilitator never invoked', async () => {
    const { POST } = await import('../src/app/api/v1/chat/completions/route');
    const res = await POST(
      makeRequest(
        { model: 'ansari-facilitator-inklng', messages: [{ role: 'user', content: 'Q' }] },
        AUTH
      )
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('model_not_found');
    expect(mockRunFacilitator).not.toHaveBeenCalled();
  });

  it('omitted model → Gemini pipeline, response model is ansari-facilitator', async () => {
    const { POST } = await import('../src/app/api/v1/chat/completions/route');
    const res = await POST(
      makeRequest({ messages: [{ role: 'user', content: 'Q' }] }, AUTH)
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.model).toBe('ansari-facilitator');
    expect(mockRunFacilitator).toHaveBeenCalledWith(
      expect.anything(),
      undefined,
      expect.objectContaining({ provider: 'gemini' })
    );
  });

  it('ansari-facilitator-inkling → provider inkling threads to the facilitator, model echoed', async () => {
    process.env.TINKER_API_KEY = 'test-tinker-key';
    const { POST } = await import('../src/app/api/v1/chat/completions/route');
    const res = await POST(
      makeRequest(
        { model: 'ansari-facilitator-inkling', messages: [{ role: 'user', content: 'Q' }] },
        AUTH
      )
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.model).toBe('ansari-facilitator-inkling');
    expect(mockRunFacilitator).toHaveBeenCalledWith(
      expect.anything(),
      undefined,
      expect.objectContaining({ provider: 'inkling' })
    );
  });

  it('ansari-facilitator-inkling without TINKER_API_KEY → 503, facilitator never invoked', async () => {
    const { POST } = await import('../src/app/api/v1/chat/completions/route');
    const res = await POST(
      makeRequest(
        { model: 'ansari-facilitator-inkling', messages: [{ role: 'user', content: 'Q' }] },
        AUTH
      )
    );
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error.code).toBe('inkling_not_configured');
    expect(mockRunFacilitator).not.toHaveBeenCalled();
  });

  it('ansari-facilitator works with TINKER_API_KEY unset (unaffected)', async () => {
    const { POST } = await import('../src/app/api/v1/chat/completions/route');
    const res = await POST(
      makeRequest(
        { model: 'ansari-facilitator', messages: [{ role: 'user', content: 'Q' }] },
        AUTH
      )
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.model).toBe('ansari-facilitator');
  });
});

describe('GET /v1/chat/completions (health check)', () => {
  it('returns 200 with a small JSON body', async () => {
    const { GET } = await import('../src/app/api/v1/chat/completions/route');
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.healthy).toBe(true);
    expect(body.name).toBe('ansari-facilitator');
  });
});
