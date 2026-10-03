import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

/**
 * Image attachments at the HTTP surface — spec 211.
 *
 * POST /api/v2/threads/[id]/chat validates images BEFORE writing anything,
 * persists placeholders (never bytes), and hands the images to the facilitator.
 * Thread GET and share GET serve placeholders in an additive `attachments` key.
 * Scaffolding mirrors tests/chat-empty-answer.test.ts.
 */

const h = vi.hoisted(() => ({ primaryBackend: 'gemini' as 'gemini' | 'inkling' }));

const mockRunFacilitator = vi.fn();
vi.mock('@/lib/facilitator/agent', () => ({
  runFacilitator: (...args: unknown[]) => mockRunFacilitator(...args),
}));

vi.mock('@sentry/nextjs', () => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
  setTag: vi.fn(),
}));

vi.mock('@/lib/config', () => ({
  config: {
    get primaryBackend() {
      return h.primaryBackend;
    },
  },
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
const mockGetThreadWithMessages = vi.fn();
vi.mock('@/lib/db/threads', () => ({
  persistOrphanToolCalls: vi.fn(),
  findThreadById: (...a: unknown[]) => mockFindThreadById(...a),
  createMessage: (...a: unknown[]) => mockCreateMessage(...a),
  findMessagesByThread: (...a: unknown[]) => mockFindMessagesByThread(...a),
  updateThread: vi.fn(),
  deleteThread: vi.fn(),
  getThreadWithMessages: (...a: unknown[]) => mockGetThreadWithMessages(...a),
}));

const mockFindShareById = vi.fn();
vi.mock('@/lib/db/shares', () => ({
  findShareById: (...a: unknown[]) => mockFindShareById(...a),
  createThreadSnapshot: vi.fn(),
}));

const mockNameThread = vi.fn().mockResolvedValue(undefined);
vi.mock('@/lib/ai/thread-naming', () => ({
  maybeGenerateThreadName: (...a: unknown[]) => mockNameThread(...a),
}));

import { POST as chatPost } from '../src/app/api/v2/threads/[id]/chat/route';
import { GET as threadGet } from '../src/app/api/v2/threads/[id]/route';
import { GET as shareGet } from '../src/app/api/v2/share/[id]/route';
import { MAX_CHAT_BODY_BYTES } from '../lib/attachments';

const USER = { id: 'user-1', email: 'u@example.com' };
const THREAD = { id: 'thread-1', userId: USER.id, name: null, source: 'web' };
const PNG_B64 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]).toString('base64');
const JPEG_B64 = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 9, 9]).toString('base64');
const PLACEHOLDER = { type: 'image', status: 'not_stored', media_type: 'image/png' };

async function* textThenDone(text: string) {
  yield { type: 'text' as const, data: text };
  yield { type: 'done' as const, data: '' };
}

function chatRequest(body: unknown, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest('http://localhost/api/v2/threads/thread-1/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

async function drain(res: Response) {
  if (res.body) await res.text();
}

beforeEach(() => {
  vi.clearAllMocks();
  h.primaryBackend = 'gemini';
  mockAuthenticate.mockResolvedValue({ user: USER });
  mockFindThreadById.mockResolvedValue(THREAD);
  mockCreateMessage.mockResolvedValue({ id: 'm1' });
  mockFindMessagesByThread.mockResolvedValue([]);
  mockRunFacilitator.mockImplementation(() => textThenDone('An answer.'));
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('POST /threads/[id]/chat with images', () => {
  it('persists text + one placeholder per image, never the bytes', async () => {
    const res = await chatPost(
      chatRequest({
        message: 'What is this?',
        images: [
          { media_type: 'image/png', data: PNG_B64 },
          { media_type: 'image/jpeg', data: JPEG_B64 },
        ],
      }),
      ctx('thread-1')
    );
    await drain(res);

    expect(res.status).toBe(200);
    const userRow = mockCreateMessage.mock.calls[0][0];
    expect(userRow.content).toEqual([
      { type: 'text', text: 'What is this?' },
      PLACEHOLDER,
      { type: 'image', status: 'not_stored', media_type: 'image/jpeg' },
    ]);
    const written = JSON.stringify(mockCreateMessage.mock.calls);
    expect(written).not.toContain(PNG_B64);
    expect(written).not.toContain(JPEG_B64);
  });

  it('hands the decoded images to the facilitator as a request option', async () => {
    const res = await chatPost(
      chatRequest({ message: 'What is this?', images: [{ media_type: 'image/png', data: PNG_B64 }] }),
      ctx('thread-1')
    );
    await drain(res);

    expect(mockRunFacilitator).toHaveBeenCalledWith(expect.any(Array), undefined, {
      images: [{ mediaType: 'image/png', data: PNG_B64 }],
    });
  });

  it('a text-only message calls the facilitator exactly as before', async () => {
    const res = await chatPost(chatRequest({ message: 'What is sabr?' }), ctx('thread-1'));
    await drain(res);

    expect(mockRunFacilitator).toHaveBeenCalledWith(expect.any(Array), undefined, undefined);
    expect(mockCreateMessage.mock.calls[0][0].content).toEqual([{ type: 'text', text: 'What is sabr?' }]);
  });

  it('accepts an image-only message and names the thread with the fallback', async () => {
    const res = await chatPost(
      chatRequest({ message: '', images: [{ media_type: 'image/png', data: PNG_B64 }] }),
      ctx('thread-1')
    );
    await drain(res);

    expect(res.status).toBe(200);
    expect(mockCreateMessage.mock.calls[0][0].content).toEqual([PLACEHOLDER]);
    expect(mockNameThread).toHaveBeenCalledWith('thread-1', USER.id, '', 'Image question');
  });

  it.each([
    ['no text and no images', { message: '' }],
    ['no text and an empty images array', { message: '', images: [] }],
    ['five images', { message: 'q', images: Array(5).fill({ media_type: 'image/png', data: PNG_B64 }) }],
    ['an unsupported type', { message: 'q', images: [{ media_type: 'image/gif', data: PNG_B64 }] }],
    ['bytes that do not match the type', { message: 'q', images: [{ media_type: 'image/png', data: JPEG_B64 }] }],
    ['invalid base64', { message: 'q', images: [{ media_type: 'image/png', data: '%%%%' }] }],
  ])('rejects %s with 422 and writes nothing', async (_label, body) => {
    const res = await chatPost(chatRequest(body), ctx('thread-1'));

    expect(res.status).toBe(422);
    expect(mockCreateMessage).not.toHaveBeenCalled();
    expect(mockRunFacilitator).not.toHaveBeenCalled();
  });

  it('refuses an oversize declared body with 413 before parsing', async () => {
    const res = await chatPost(
      chatRequest('{}', { 'Content-Length': String(MAX_CHAT_BODY_BYTES + 1) }),
      ctx('thread-1')
    );

    expect(res.status).toBe(413);
    expect(mockCreateMessage).not.toHaveBeenCalled();
  });

  it('refuses an oversize body even when the header understates it', async () => {
    const big = JSON.stringify({ message: 'x'.repeat(MAX_CHAT_BODY_BYTES) });
    const res = await chatPost(chatRequest(big, { 'Content-Length': '10' }), ctx('thread-1'));

    expect(res.status).toBe(413);
    expect(mockCreateMessage).not.toHaveBeenCalled();
  });

  it('refuses images with 422 under PRIMARY_BACKEND=inkling, but not text', async () => {
    h.primaryBackend = 'inkling';

    const withImages = await chatPost(
      chatRequest({ message: 'q', images: [{ media_type: 'image/png', data: PNG_B64 }] }),
      ctx('thread-1')
    );
    expect(withImages.status).toBe(422);
    expect(mockCreateMessage).not.toHaveBeenCalled();

    const textOnly = await chatPost(chatRequest({ message: 'q' }), ctx('thread-1'));
    await drain(textOnly);
    expect(textOnly.status).toBe(200);
  });
});

describe('placeholders on the read surfaces', () => {
  const rows = [
    { id: 'u1', role: 'user', content: [{ type: 'text', text: 'What is this?' }, PLACEHOLDER], agentName: null, source: 'web', createdAt: new Date(0) },
    { id: 'u2', role: 'user', content: [PLACEHOLDER], agentName: null, source: 'web', createdAt: new Date(0) },
    { id: 'a1', role: 'assistant', content: [{ type: 'text', text: 'A mosque.' }], agentName: 'facilitator', source: 'web', createdAt: new Date(0) },
  ];

  it('thread GET: bare-string content, attachments only on image messages', async () => {
    mockGetThreadWithMessages.mockResolvedValue({
      thread: { ...THREAD, createdAt: new Date(0), updatedAt: new Date(0) },
      messages: rows,
    });

    const res = await threadGet(new NextRequest('http://localhost/api/v2/threads/thread-1'), ctx('thread-1'));
    const body = await res.json();

    expect(body.messages[0]).toMatchObject({ content: 'What is this?', attachments: [PLACEHOLDER] });
    expect(body.messages[1]).toMatchObject({ content: '', attachments: [PLACEHOLDER] });
    expect(body.messages[2].content).toBe('A mosque.');
    expect('attachments' in body.messages[2]).toBe(false);
  });

  it('share GET: the same projection over the snapshot', async () => {
    mockFindShareById.mockResolvedValue({
      id: 's1',
      createdAt: new Date(0),
      content: {
        threadName: 't',
        messages: rows.map((r) => ({ role: r.role, content: r.content, createdAt: '1970-01-01T00:00:00.000Z' })),
      },
    });

    const res = await shareGet(new NextRequest('http://localhost/api/v2/share/s1'), ctx('s1'));
    const body = await res.json();

    expect(body.messages[0]).toEqual({
      role: 'user',
      content: 'What is this?',
      attachments: [PLACEHOLDER],
      created_at: '1970-01-01T00:00:00.000Z',
    });
    expect(body.messages[2]).toEqual({ role: 'assistant', content: 'A mosque.', created_at: '1970-01-01T00:00:00.000Z' });
  });
});
