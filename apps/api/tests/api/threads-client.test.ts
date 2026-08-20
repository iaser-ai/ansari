import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// Per-client attribution wiring (spec 56, phase 3). Drives the real routes +
// the real getClientId helper (NOT mocked), mocking only the boundaries: auth,
// DB writes, the facilitator, thread-naming, and Sentry.

const mockAuthenticateRequest = vi.fn();
vi.mock('@/lib/auth/middleware', () => ({
  authenticateRequest: (...a: unknown[]) => mockAuthenticateRequest(...a),
  createErrorResponse: (message: string, status: number) =>
    new Response(JSON.stringify({ error: message }), {
      status,
      headers: { 'Content-Type': 'application/json' },
    }),
}));

const mockCreateThread = vi.fn();
const mockCreateMessage = vi.fn();
const mockFindThreadById = vi.fn();
const mockFindMessagesByThread = vi.fn();
// Mock the full export surface the imported route modules reference (the create
// route also imports findThreadsByUser; the [id] route imports updateThread /
// deleteThread / getThreadWithMessages) so the mock mirrors the real module,
// even though only the POST paths are exercised here.
vi.mock('@/lib/db/threads', () => ({
  createThread: (...a: unknown[]) => mockCreateThread(...a),
  createMessage: (...a: unknown[]) => mockCreateMessage(...a),
  findThreadById: (...a: unknown[]) => mockFindThreadById(...a),
  findMessagesByThread: (...a: unknown[]) => mockFindMessagesByThread(...a),
  findThreadsByUser: vi.fn(),
  updateThread: vi.fn(),
  deleteThread: vi.fn(),
  getThreadWithMessages: vi.fn(),
}));

vi.mock('@/lib/ai/thread-naming', () => ({
  maybeGenerateThreadName: vi.fn(),
}));

const mockRunFacilitator = vi.fn();
vi.mock('@/lib/facilitator/agent', () => ({
  runFacilitator: (...a: unknown[]) => mockRunFacilitator(...a),
}));

vi.mock('@sentry/nextjs', () => ({
  setTag: vi.fn(),
  captureMessage: vi.fn(),
  captureException: vi.fn(),
}));

import { POST as createThreadPOST } from '../../src/app/api/v2/threads/route';
import { POST as chatPrimaryPOST } from '../../src/app/api/v2/threads/[id]/route';
import { POST as chatSiblingPOST } from '../../src/app/api/v2/threads/[id]/chat/route';

const USER = { id: 'user-1' };
const THREAD = { id: 'thread-1', userId: 'user-1', name: null, source: 'web' };

async function* facilitatorGen() {
  yield { type: 'text' as const, data: 'Sabr is patience.' };
  yield { type: 'done' as const, data: '' };
}

// Read a streaming Response to completion so the assistant-message write inside
// the stream's async `start()` closure has run before we assert.
async function drain(res: Response): Promise<void> {
  const reader = res.body?.getReader();
  if (!reader) return;
  for (;;) {
    const { done } = await reader.read();
    if (done) break;
  }
}

function postReq(url: string, body: unknown, clientId?: string): NextRequest {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (clientId !== undefined) headers['X-Ansari-Client'] = clientId;
  return new NextRequest(url, { method: 'POST', headers, body: JSON.stringify(body) });
}

const ctx = { params: Promise.resolve({ id: 'thread-1' }) };

beforeEach(() => {
  vi.clearAllMocks();
  mockAuthenticateRequest.mockResolvedValue({ user: USER });
  mockCreateThread.mockResolvedValue({ ...THREAD, createdAt: new Date(), updatedAt: new Date() });
  mockCreateMessage.mockResolvedValue({ id: 'msg-1' });
  mockFindThreadById.mockResolvedValue(THREAD);
  mockFindMessagesByThread.mockResolvedValue([]);
  mockRunFacilitator.mockImplementation(() => facilitatorGen());
});

describe('POST /api/v2/threads — thread-create attribution (spec 56)', () => {
  it('sets thread.client from the X-Ansari-Client header', async () => {
    await createThreadPOST(postReq('http://localhost/api/v2/threads', {}, 'muslimpedia'));
    expect(mockCreateThread).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-1', client: 'muslimpedia' })
    );
  });

  it('client is null when the header is absent (unchanged behavior)', async () => {
    await createThreadPOST(postReq('http://localhost/api/v2/threads', {}));
    expect(mockCreateThread).toHaveBeenCalledWith(expect.objectContaining({ client: null }));
  });

  it("stores the 'invalid' sentinel for a malformed header", async () => {
    await createThreadPOST(postReq('http://localhost/api/v2/threads', {}, 'not valid!'));
    expect(mockCreateThread).toHaveBeenCalledWith(expect.objectContaining({ client: 'invalid' }));
  });

  it('does not read client from the body (header-only)', async () => {
    // A body `client` field must be ignored; only the header drives attribution.
    await createThreadPOST(postReq('http://localhost/api/v2/threads', { client: 'spoofed' }));
    expect(mockCreateThread).toHaveBeenCalledWith(expect.objectContaining({ client: null }));
  });
});

describe('POST /api/v2/threads/[id] — message attribution (primary streaming route)', () => {
  it('sets client on BOTH the user and assistant messages', async () => {
    const res = await chatPrimaryPOST(
      postReq('http://localhost/api/v2/threads/thread-1', { content: 'hi' }, 'muslimpedia'),
      ctx
    );
    await drain(res);

    expect(mockCreateMessage).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'user', source: 'web', client: 'muslimpedia' })
    );
    expect(mockCreateMessage).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'assistant', source: 'web', client: 'muslimpedia' })
    );
  });

  it('client is null on both messages when the header is absent', async () => {
    const res = await chatPrimaryPOST(
      postReq('http://localhost/api/v2/threads/thread-1', { content: 'hi' }),
      ctx
    );
    await drain(res);

    const clients = mockCreateMessage.mock.calls.map(([arg]) => (arg as { client: unknown }).client);
    expect(clients).toEqual([null, null]);
  });
});

describe('POST /api/v2/threads/[id]/chat — message attribution (sibling streaming route)', () => {
  it('sets client on BOTH the user and assistant messages', async () => {
    const res = await chatSiblingPOST(
      postReq('http://localhost/api/v2/threads/thread-1/chat', { message: 'hi' }, 'muslimpedia'),
      ctx
    );
    await drain(res);

    expect(mockCreateMessage).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'user', source: 'web', client: 'muslimpedia' })
    );
    expect(mockCreateMessage).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'assistant', source: 'web', client: 'muslimpedia' })
    );
  });

  it("stores the 'invalid' sentinel on both messages for a malformed header", async () => {
    const res = await chatSiblingPOST(
      postReq('http://localhost/api/v2/threads/thread-1/chat', { message: 'hi' }, 'bad client!'),
      ctx
    );
    await drain(res);

    const clients = mockCreateMessage.mock.calls.map(([arg]) => (arg as { client: unknown }).client);
    expect(clients).toEqual(['invalid', 'invalid']);
  });
});
