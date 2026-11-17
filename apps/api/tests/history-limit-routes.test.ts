import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

/**
 * Thread history limits on the two thread routes — issue #400.
 *
 * POST /api/v2/threads/[id] (raw text; the legacy mobile app) and
 * POST /api/v2/threads/[id]/chat (SSE; the web app and WhatsApp). From the warn
 * threshold the answer opens with a notice, in the stream and in the stored
 * message; from the block threshold the notice is the answer and the facilitator
 * is never called. Both arrive in the frames and the row shape the routes already
 * produce. The real config is used, with low thresholds set through the env.
 */

const mockRunFacilitator = vi.fn();
vi.mock('@/lib/facilitator/agent', () => ({
  runFacilitator: (...args: unknown[]) => mockRunFacilitator(...args),
}));

vi.mock('@sentry/nextjs', () => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
  setTag: vi.fn(),
}));

const mockAuthenticate = vi.fn();
vi.mock('@/lib/error-response', () => ({
  createErrorResponse: (detail: string, status = 400) =>
    new Response(JSON.stringify({ error: detail }), { status }),
}));
vi.mock('@/lib/auth/require-user', () => ({
  requireUser: (...a: unknown[]) => mockAuthenticate(...a),
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

const mockMaybeGenerateThreadName = vi.fn();
vi.mock('@/lib/ai/thread-naming', () => ({
  maybeGenerateThreadName: (...args: unknown[]) => mockMaybeGenerateThreadName(...args),
}));

import { POST as threadPost } from '../src/app/api/v2/threads/[id]/route';
import { POST as chatPost } from '../src/app/api/v2/threads/[id]/chat/route';
import { resetEnvCache } from '@/lib/config';
import {
  BYTES_PER_TOKEN,
  HISTORY_BLOCK_MESSAGE,
  HISTORY_MESSAGE_TOO_LONG_MESSAGE,
  HISTORY_WARNING_MESSAGE,
} from '@/lib/facilitator/history-limit';

const USER = { id: 'user-1', email: 'u@example.com' };
const THREAD = { id: 'thread-1', userId: USER.id, name: null, source: 'web' };
const WARN_TOKENS = 100;
const BLOCK_TOKENS = 200;
const ANSWER = 'Sabr means patience.';

type Row = {
  role: 'user' | 'assistant';
  content: Array<{ type: 'text'; text: string }>;
  inputTokens: number | null;
  rawPayload: null;
};

/** A stored thread whose history is estimated at exactly `tokens`, ending on the user's new message. */
function threadOfTokens(tokens: number, lastAnswerInputTokens: number | null = null): Row[] {
  const question = 'What is sabr?';
  const filler = 'a'.repeat(tokens * BYTES_PER_TOKEN - 2 * question.length);
  return [
    { role: 'user', content: [{ type: 'text', text: question }], inputTokens: null, rawPayload: null },
    { role: 'assistant', content: [{ type: 'text', text: filler }], inputTokens: lastAnswerInputTokens, rawPayload: null },
    { role: 'user', content: [{ type: 'text', text: question }], inputTokens: null, rawPayload: null },
  ];
}

async function* textThenDone(text: string) {
  yield { type: 'text' as const, data: text };
  yield { type: 'done' as const, data: '' };
}

async function* emptyDone() {
  yield { type: 'done' as const, data: '' };
}

function makeRequest(url: string, body: unknown): NextRequest {
  return new NextRequest(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const routeContext = (id: string) => ({ params: Promise.resolve({ id }) });

/** The raw-text route's whole stream. */
async function postThread(content = 'What is sabr?'): Promise<string> {
  const response = await threadPost(
    makeRequest(`http://localhost/api/v2/threads/${THREAD.id}`, { content }),
    routeContext(THREAD.id)
  );
  expect(response.status).toBe(200);
  return response.text();
}

/** The SSE route's `data:` frames, in order. */
async function postChat(message = 'What is sabr?'): Promise<Array<{ type: string; content?: string; message?: string }>> {
  const response = await chatPost(
    makeRequest(`http://localhost/api/v2/threads/${THREAD.id}/chat`, { message }),
    routeContext(THREAD.id)
  );
  expect(response.status).toBe(200);
  return (await response.text())
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice('data: '.length)));
}

function assistantRows() {
  return mockCreateMessage.mock.calls.map((c) => c[0]).filter((m) => m.role === 'assistant');
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('THREAD_HISTORY_WARN_TOKENS', String(WARN_TOKENS));
  vi.stubEnv('THREAD_HISTORY_BLOCK_TOKENS', String(BLOCK_TOKENS));
  resetEnvCache();
  mockAuthenticate.mockResolvedValue({ user: USER });
  mockFindThreadById.mockResolvedValue(THREAD);
  mockCreateMessage.mockResolvedValue({ id: 'msg-1' });
  mockRunFacilitator.mockImplementation(() => textThenDone(ANSWER));
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  resetEnvCache();
});

describe('under the warn threshold', () => {
  beforeEach(() => mockFindMessagesByThread.mockResolvedValue(threadOfTokens(WARN_TOKENS - 1)));

  it('raw-text route: the answer alone, streamed and stored', async () => {
    expect(await postThread()).toBe(ANSWER);
    expect(assistantRows().map((m) => m.content)).toEqual([[{ type: 'text', text: ANSWER }]]);
  });

  it('SSE route: the answer alone, then done', async () => {
    expect(await postChat()).toEqual([{ type: 'text', content: ANSWER }, { type: 'done' }]);
    expect(assistantRows().map((m) => m.content)).toEqual([[{ type: 'text', text: ANSWER }]]);
  });
});

describe('from the warn threshold: the answer is given and opens with the warning', () => {
  const WARNED = `${HISTORY_WARNING_MESSAGE}\n\n${ANSWER}`;

  beforeEach(() => mockFindMessagesByThread.mockResolvedValue(threadOfTokens(WARN_TOKENS)));

  it('raw-text route: warning then answer in the stream, stored as one text block', async () => {
    expect(await postThread()).toBe(WARNED);
    expect(mockRunFacilitator).toHaveBeenCalledTimes(1);
    // One text block, so thread GET still serves `content` as a bare string.
    expect(assistantRows().map((m) => m.content)).toEqual([[{ type: 'text', text: WARNED }]]);
  });

  it('SSE route: the warning as a text frame, then the answer, then done', async () => {
    expect(await postChat()).toEqual([
      { type: 'text', content: `${HISTORY_WARNING_MESSAGE}\n\n` },
      { type: 'text', content: ANSWER },
      { type: 'done' },
    ]);
    expect(mockRunFacilitator).toHaveBeenCalledTimes(1);
    expect(assistantRows().map((m) => m.content)).toEqual([[{ type: 'text', text: WARNED }]]);
  });

  it('an empty answer is still the empty-answer error: the warning is never stored on its own', async () => {
    mockRunFacilitator.mockImplementation(() => emptyDone());
    expect(await postThread()).toMatch(/Error: The model returned an empty answer/);
    const frames = await postChat();
    expect(frames.map((f) => f.type)).toEqual(['error']);
    expect(assistantRows()).toEqual([]);
  });
});

describe('from the block threshold: no model call, the notice is the answer', () => {
  beforeEach(() => mockFindMessagesByThread.mockResolvedValue(threadOfTokens(BLOCK_TOKENS)));

  it('raw-text route: the stream is the block message, stored as an ordinary assistant message', async () => {
    expect(await postThread()).toBe(HISTORY_BLOCK_MESSAGE);
    expect(mockRunFacilitator).not.toHaveBeenCalled();
    expect(assistantRows()).toEqual([
      expect.objectContaining({
        threadId: THREAD.id,
        role: 'assistant',
        content: [{ type: 'text', text: HISTORY_BLOCK_MESSAGE }],
        agentName: 'facilitator',
        inputTokens: null,
        outputTokens: null,
        rawPayload: null,
        toolCalls: null,
        modelProvider: null,
        modelId: null,
      }),
    ]);
  });

  it('SSE route: one text frame with the block message, then done, and no error frame', async () => {
    expect(await postChat()).toEqual([{ type: 'text', content: HISTORY_BLOCK_MESSAGE }, { type: 'done' }]);
    expect(mockRunFacilitator).not.toHaveBeenCalled();
    expect(assistantRows().map((m) => m.content)).toEqual([[{ type: 'text', text: HISTORY_BLOCK_MESSAGE }]]);
  });

  it('the user message of a blocked turn is stored, like any other', async () => {
    await postThread();
    const stored = mockCreateMessage.mock.calls.map((c) => c[0].role);
    expect(stored).toEqual(['user', 'assistant']);
  });
});

describe('one incoming message over the block threshold on its own', () => {
  // A short thread: what is too long is the message, not the conversation.
  beforeEach(() => mockFindMessagesByThread.mockResolvedValue(threadOfTokens(10)));

  const AT_BLOCK = 'a'.repeat(BLOCK_TOKENS * BYTES_PER_TOKEN);
  const UNDER_BLOCK = 'a'.repeat(BLOCK_TOKENS * BYTES_PER_TOKEN - BYTES_PER_TOKEN);

  it('raw-text route: told the message is too long; nothing stored, no model call, no thread name', async () => {
    expect(await postThread(AT_BLOCK)).toBe(HISTORY_MESSAGE_TOO_LONG_MESSAGE);
    expect(mockCreateMessage).not.toHaveBeenCalled();
    expect(mockFindMessagesByThread).not.toHaveBeenCalled();
    expect(mockRunFacilitator).not.toHaveBeenCalled();
    expect(mockMaybeGenerateThreadName).not.toHaveBeenCalled();
  });

  it('SSE route: one text frame with that message, then done, and no error frame; nothing stored', async () => {
    expect(await postChat(AT_BLOCK)).toEqual([
      { type: 'text', content: HISTORY_MESSAGE_TOO_LONG_MESSAGE },
      { type: 'done' },
    ]);
    expect(mockCreateMessage).not.toHaveBeenCalled();
    expect(mockFindMessagesByThread).not.toHaveBeenCalled();
    expect(mockRunFacilitator).not.toHaveBeenCalled();
    expect(mockMaybeGenerateThreadName).not.toHaveBeenCalled();
  });

  it('the size is in bytes: Arabic of half as many characters is refused too', async () => {
    const arabic = '\u0635'.repeat((BLOCK_TOKENS * BYTES_PER_TOKEN) / 2);
    expect(await postThread(arabic)).toBe(HISTORY_MESSAGE_TOO_LONG_MESSAGE);
    expect(mockCreateMessage).not.toHaveBeenCalled();
  });

  it('one token under the threshold is stored and goes on to the ordinary thread check', async () => {
    expect(await postThread(UNDER_BLOCK)).toBe(ANSWER);
    expect(mockCreateMessage.mock.calls.map((c) => c[0].role)).toEqual(['user', 'assistant']);
  });

  it('logs the thread id and the estimate, and none of the message', async () => {
    await postThread(AT_BLOCK);
    expect(vi.mocked(console.warn).mock.calls).toEqual([
      ['[history-limit] incoming message refused', { threadId: THREAD.id, estimatedTokens: BLOCK_TOKENS }],
    ]);
  });

  it('says the message is too long, not the conversation, and does not suggest splitting it', () => {
    expect(HISTORY_MESSAGE_TOO_LONG_MESSAGE).toMatch(/message is too long/);
    expect(HISTORY_MESSAGE_TOO_LONG_MESSAGE).not.toMatch(/conversation|split|several|parts/i);
  });
});

describe('the size is the estimate, never a stored token count', () => {
  it('a long thread with no stored count on any row is blocked', async () => {
    mockFindMessagesByThread.mockResolvedValue(threadOfTokens(BLOCK_TOKENS, null));
    expect(await postThread()).toBe(HISTORY_BLOCK_MESSAGE);
    expect(await postChat()).toEqual([{ type: 'text', content: HISTORY_BLOCK_MESSAGE }, { type: 'done' }]);
    expect(mockRunFacilitator).not.toHaveBeenCalled();
  });

  it('a short thread whose last answer stored a huge input_tokens is answered, with no notice', async () => {
    mockFindMessagesByThread.mockResolvedValue(threadOfTokens(WARN_TOKENS - 1, 5_000_000));
    expect(await postThread()).toBe(ANSWER);
    expect(await postChat()).toEqual([{ type: 'text', content: ANSWER }, { type: 'done' }]);
    expect(mockRunFacilitator).toHaveBeenCalledTimes(2);
  });
});
