import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

/**
 * Web-route empty-answer backstops — issue #60.
 *
 * Before the fix both web chat routes hid an empty facilitator completion: the `done`
 * handler skipped storing the assistant message when text was empty and closed the
 * stream as if it were a success, so prod occurrences appeared as
 * user-message-with-no-reply threads. Now an empty `done` surfaces an explicit error
 * to the client and never a silent success.
 *
 * Covers BOTH routes: POST /api/v2/threads/[id] (the path the frontend actually calls,
 * raw-text stream) and POST /api/v2/threads/[id]/chat (SSE events).
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

import { POST as threadPost } from '../src/app/api/v2/threads/[id]/route';
import { POST as chatPost } from '../src/app/api/v2/threads/[id]/chat/route';

const USER = { id: 'user-1', email: 'u@example.com' };
const THREAD = { id: 'thread-1', userId: USER.id, name: null, source: 'web' };

/** The issue #60 failure shape: facilitator completes with zero visible text. */
async function* emptyDone() {
  yield { type: 'done' as const, data: '' };
}

async function* textThenDone(text: string) {
  yield { type: 'text' as const, data: text };
  yield { type: 'done' as const, data: '' };
}

function makeRequest(url: string, body: unknown): NextRequest {
  return new NextRequest(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function routeContext(id: string) {
  return { params: Promise.resolve({ id }) };
}

function assistantCalls() {
  return mockCreateMessage.mock.calls.map((c) => c[0]).filter((m) => m.role === 'assistant');
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAuthenticate.mockResolvedValue({ user: USER });
  mockFindThreadById.mockResolvedValue(THREAD);
  mockCreateMessage.mockResolvedValue({ id: 'msg-1' });
  mockFindMessagesByThread.mockResolvedValue([
    { role: 'user', content: [{ type: 'text', text: 'What is sabr?' }] },
  ]);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('POST /api/v2/threads/[id] empty-answer backstop (issue #60)', () => {
  it('surfaces an explicit error instead of a silent close on an empty done', async () => {
    mockRunFacilitator.mockReturnValue(emptyDone());

    const response = await threadPost(
      makeRequest(`http://localhost/api/v2/threads/${THREAD.id}`, { content: 'What is sabr?' }),
      routeContext(THREAD.id)
    );
    const body = await response.text();

    expect(body).toMatch(/error.*empty answer/i);
    expect(assistantCalls()).toHaveLength(0); // nothing persisted for the empty turn
  });

  it('a normal answer still streams and persists unchanged', async () => {
    mockRunFacilitator.mockReturnValue(textThenDone('Sabr means patience.'));

    const response = await threadPost(
      makeRequest(`http://localhost/api/v2/threads/${THREAD.id}`, { content: 'What is sabr?' }),
      routeContext(THREAD.id)
    );
    const body = await response.text();

    expect(body).toBe('Sabr means patience.');
    expect(assistantCalls()).toHaveLength(1);
  });
});

describe('POST /api/v2/threads/[id]/chat empty-answer backstop (issue #60)', () => {
  it('emits an SSE error event (not a done) on an empty done', async () => {
    mockRunFacilitator.mockReturnValue(emptyDone());

    const response = await chatPost(
      makeRequest(`http://localhost/api/v2/threads/${THREAD.id}/chat`, { message: 'What is sabr?' }),
      routeContext(THREAD.id)
    );
    const body = await response.text();

    expect(body).toContain('"type":"error"');
    expect(body).toMatch(/empty answer/i);
    expect(body).not.toContain('"type":"done"');
    expect(assistantCalls()).toHaveLength(0);
  });

  it('a normal answer still emits a done event and persists', async () => {
    mockRunFacilitator.mockReturnValue(textThenDone('Sabr means patience.'));

    const response = await chatPost(
      makeRequest(`http://localhost/api/v2/threads/${THREAD.id}/chat`, { message: 'What is sabr?' }),
      routeContext(THREAD.id)
    );
    const body = await response.text();

    expect(body).toContain('"type":"done"');
    expect(assistantCalls()).toHaveLength(1);
  });
});
