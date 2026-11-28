import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

/**
 * WhatsApp non-streaming endpoint tests — Spec 360
 *
 * Tests the POST /api/v2/chat/complete endpoint which provides
 * non-streaming responses for WhatsApp with WhatsApp-specific formatting.
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

const mockRequireUser = vi.fn();
vi.mock('@/lib/auth/require-user', () => ({
  requireUser: (...a: unknown[]) => mockRequireUser(...a),
}));

vi.mock('@/lib/error-response', () => ({
  createErrorResponse: (detail: string, status = 400) =>
    new Response(JSON.stringify({ error: detail }), { status }),
}));

const mockGetOrCreateThread = vi.fn();
const mockCreateMessage = vi.fn();
const mockPersistOrphanToolCalls = vi.fn();

vi.mock('@/lib/db/threads', () => ({
  getOrCreateThreadWithUserMessage: (...a: unknown[]) => mockGetOrCreateThread(...a),
  createMessageIfThreadExists: (...a: unknown[]) => mockCreateMessage(...a),
  persistOrphanToolCalls: (...a: unknown[]) => mockPersistOrphanToolCalls(...a),
  findThreadById: vi.fn(),
}));

const mockAssessHistory = vi.fn();
const mockIncomingMessageTooLong = vi.fn();
vi.mock('@/lib/facilitator/history-limit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/facilitator/history-limit')>()),
  assessHistory: (...a: unknown[]) => mockAssessHistory(...a),
  incomingMessageTooLong: (...a: unknown[]) => mockIncomingMessageTooLong(...a),
}));

vi.mock('@/lib/attribution', () => ({
  getClientId: vi.fn().mockReturnValue('test-client'),
}));

import { POST } from '../src/app/api/v2/chat/complete/route';
import {
  HISTORY_BLOCK_MESSAGE,
  HISTORY_MESSAGE_TOO_LONG_MESSAGE,
  HISTORY_WARNING_MESSAGE,
} from '../lib/facilitator/history-limit';

const USER = { id: 'user-1', email: 'u@example.com' };
const THREAD = { id: 'thread-1', userId: USER.id, source: 'whatsapp', updatedAt: new Date() };

function makeRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/v2/chat/complete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireUser.mockResolvedValue({ user: USER });
  mockGetOrCreateThread.mockResolvedValue({
    thread: THREAD,
    message: { id: 'user-msg-1' },
    history: [{ role: 'user', content: [{ type: 'text', text: 'What is patience?' }] }],
  });
  mockCreateMessage.mockResolvedValue({ id: 'msg-1' });
  mockAssessHistory.mockReturnValue({ verdict: 'ok', estimatedTokens: 10 });
  mockIncomingMessageTooLong.mockReturnValue(false);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('POST /api/v2/chat/complete', () => {
  describe('authentication', () => {
    it('returns 401 when user is not authenticated', async () => {
      mockRequireUser.mockResolvedValue({
        error: new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 }),
      });

      const response = await POST(makeRequest({ message: 'test' }));
      expect(response.status).toBe(401);
    });
  });

  describe('request validation', () => {
    it('returns 422 when message is missing', async () => {
      const response = await POST(makeRequest({}));
      expect(response.status).toBe(422);

      const body = await response.json();
      expect(body.error).toBeDefined();
    });

    it('returns 422 when message is empty', async () => {
      const response = await POST(makeRequest({ message: '' }));
      expect(response.status).toBe(422);
    });

    it('accepts valid message with default expiryHours', async () => {
      mockRunFacilitator.mockImplementation(async function* () {
        yield { type: 'text', data: '{"messages":["Test message"]}' };
        yield {
          type: 'done',
          data: '',
          usage: { promptTokenCount: 10, candidatesTokenCount: 20 },
          toolCalls: [],
          provenance: { provider: 'gemini', modelId: 'gemini-3-flash' },
        };
      });

      const response = await POST(makeRequest({ message: 'test' }));
      expect(response.status).toBe(200);
    });

    it('accepts custom expiryHours', async () => {
      mockRunFacilitator.mockImplementation(async function* () {
        yield { type: 'text', data: '{"messages":["Test message"]}' };
        yield {
          type: 'done',
          data: '',
          usage: { promptTokenCount: 10, candidatesTokenCount: 20 },
          toolCalls: [],
          provenance: { provider: 'gemini', modelId: 'gemini-3-flash' },
        };
      });

      const response = await POST(makeRequest({ message: 'test', expiryHours: 6 }));
      expect(response.status).toBe(200);
    });

    it('returns 422 when expiryHours is out of range', async () => {
      const response = await POST(makeRequest({ message: 'test', expiryHours: 25 }));
      expect(response.status).toBe(422);
    });

    it('returns 422 when expiryHours is negative', async () => {
      const response = await POST(makeRequest({ message: 'test', expiryHours: -1 }));
      expect(response.status).toBe(422);
    });

    it('returns 422 when expiryHours is fractional', async () => {
      const response = await POST(makeRequest({ message: 'test', expiryHours: 1.5 }));
      expect(response.status).toBe(422);
    });
  });

  describe('thread management', () => {
    it('creates or gets thread with correct parameters', async () => {
      mockRunFacilitator.mockImplementation(async function* () {
        yield { type: 'text', data: '{"messages":["Test message"]}' };
        yield {
          type: 'done',
          data: '',
          usage: { promptTokenCount: 10, candidatesTokenCount: 20 },
          toolCalls: [],
          provenance: { provider: 'gemini', modelId: 'gemini-3-flash' },
        };
      });

      await POST(makeRequest({ message: 'test', expiryHours: 5 }));

      expect(mockGetOrCreateThread).toHaveBeenCalledWith(
        USER.id,
        'whatsapp',
        5,
        expect.objectContaining({ role: 'user', source: 'whatsapp' }),
      );
    });

    it('stores user message with correct parameters', async () => {
      mockRunFacilitator.mockImplementation(async function* () {
        yield { type: 'text', data: '{"messages":["Test message"]}' };
        yield {
          type: 'done',
          data: '',
          usage: { promptTokenCount: 10, candidatesTokenCount: 20 },
          toolCalls: [],
          provenance: { provider: 'gemini', modelId: 'gemini-3-flash' },
        };
      });

      await POST(makeRequest({ message: 'test message' }));

      expect(mockGetOrCreateThread).toHaveBeenCalledWith(
        USER.id,
        'whatsapp',
        3,
        expect.objectContaining({
          role: 'user',
          content: [{ type: 'text', text: 'test message' }],
          source: 'whatsapp',
          client: 'test-client',
        }),
      );
    });
  });

  describe('facilitator integration', () => {
    it('calls facilitator with WhatsApp source', async () => {
      mockRunFacilitator.mockImplementation(async function* () {
        yield { type: 'text', data: '{"messages":["Test message"]}' };
        yield {
          type: 'done',
          data: '',
          usage: { promptTokenCount: 10, candidatesTokenCount: 20 },
          toolCalls: [],
          provenance: { provider: 'gemini', modelId: 'gemini-3-flash' },
        };
      });

      await POST(makeRequest({ message: 'test' }));

      expect(mockRunFacilitator).toHaveBeenCalledWith(
        expect.any(Array),
        undefined,
        { source: 'whatsapp' }
      );
    });

    it('accumulates text from facilitator events', async () => {
      mockRunFacilitator.mockImplementation(async function* () {
        yield { type: 'text', data: '{"messages":[' };
        yield { type: 'text', data: '"Test message"]}' };
        yield {
          type: 'done',
          data: '',
          usage: { promptTokenCount: 10, candidatesTokenCount: 20 },
          toolCalls: [],
          provenance: { provider: 'gemini', modelId: 'gemini-3-flash' },
        };
      });

      const response = await POST(makeRequest({ message: 'test' }));
      const body = await response.json();

      expect(body.messages).toEqual(['Test message']);
    });
  });

  describe('response handling', () => {
    it('returns messages array on successful completion', async () => {
      const whatsappResponse = {
        messages: ['First message', 'Second message', 'Third message'],
      };

      mockRunFacilitator.mockImplementation(async function* () {
        yield { type: 'text', data: JSON.stringify(whatsappResponse) };
        yield {
          type: 'done',
          data: '',
          usage: { promptTokenCount: 10, candidatesTokenCount: 20 },
          toolCalls: [],
          provenance: { provider: 'gemini', modelId: 'gemini-3-flash' },
        };
      });

      const response = await POST(makeRequest({ message: 'test' }));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.messages).toEqual(whatsappResponse.messages);
      expect(mockGetOrCreateThread).toHaveBeenCalledTimes(1);
      expect(mockCreateMessage).toHaveBeenCalledTimes(1);
      expect(mockCreateMessage).toHaveBeenLastCalledWith(
        expect.objectContaining({ role: 'assistant', source: 'whatsapp' }),
        USER.id,
      );
    });

    it('returns the answer without storing it if a concurrent request replaced the thread', async () => {
      mockCreateMessage.mockResolvedValue(undefined);
      mockRunFacilitator.mockImplementation(async function* () {
        yield { type: 'text', data: '{"messages":["Still delivered"]}' };
        yield {
          type: 'done',
          data: '',
          usage: {},
          toolCalls: [],
          provenance: { provider: 'gemini', modelId: 'gemini-3-flash' },
        };
      });

      const response = await POST(makeRequest({ message: 'test' }));

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ messages: ['Still delivered'] });
      expect(mockCreateMessage).toHaveBeenCalledTimes(1);
    });

    it('returns 500 when facilitator returns empty answer', async () => {
      mockRunFacilitator.mockImplementation(async function* () {
        yield { type: 'done', data: '', usage: {}, toolCalls: [], provenance: {} };
      });

      const response = await POST(makeRequest({ message: 'test' }));
      expect(response.status).toBe(500);
      expect(mockGetOrCreateThread).toHaveBeenCalledTimes(1);
      expect(mockCreateMessage).not.toHaveBeenCalled();

      const body = await response.json();
      expect(body.error).toContain('empty answer');
    });

    it('returns 500 when response is not valid JSON and keeps tool history', async () => {
      const toolCalls = [{ type: 'tool_use', id: 'tool-1', name: 'search_quran', input: {} }];
      mockRunFacilitator.mockImplementation(async function* () {
        yield { type: 'text', data: 'not valid json' };
        yield {
          type: 'done',
          data: '',
          usage: { promptTokenCount: 10, candidatesTokenCount: 20 },
          toolCalls,
          provenance: { provider: 'gemini', modelId: 'gemini-3-flash' },
        };
      });

      const response = await POST(makeRequest({ message: 'test' }));
      expect(response.status).toBe(500);
      expect(mockCreateMessage).not.toHaveBeenCalled();
      expect(mockPersistOrphanToolCalls).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'empty_final', toolCalls }),
      );
    });

    it('returns 500 when response is missing messages array and keeps tool history', async () => {
      const toolCalls = [{ type: 'tool_use', id: 'tool-1', name: 'search_quran', input: {} }];
      mockRunFacilitator.mockImplementation(async function* () {
        yield { type: 'text', data: '{"invalid":"structure"}' };
        yield {
          type: 'done',
          data: '',
          usage: { promptTokenCount: 10, candidatesTokenCount: 20 },
          toolCalls,
          provenance: { provider: 'gemini', modelId: 'gemini-3-flash' },
        };
      });

      const response = await POST(makeRequest({ message: 'test' }));
      expect(response.status).toBe(500);
      expect(mockPersistOrphanToolCalls).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'empty_final', toolCalls }),
      );
    });

    it('returns 500 when messages is not an array', async () => {
      mockRunFacilitator.mockImplementation(async function* () {
        yield { type: 'text', data: '{"messages":"not an array"}' };
        yield {
          type: 'done',
          data: '',
          usage: { promptTokenCount: 10, candidatesTokenCount: 20 },
          toolCalls: [],
          provenance: { provider: 'gemini', modelId: 'gemini-3-flash' },
        };
      });

      const response = await POST(makeRequest({ message: 'test' }));
      expect(response.status).toBe(500);
      expect(mockCreateMessage).not.toHaveBeenCalled();
    });

    it('does not persist a response whose messages are not all strings', async () => {
      mockRunFacilitator.mockImplementation(async function* () {
        yield { type: 'text', data: '{"messages":["valid",42]}' };
        yield {
          type: 'done',
          data: '',
          usage: { promptTokenCount: 10, candidatesTokenCount: 20 },
          toolCalls: [],
          provenance: { provider: 'gemini', modelId: 'gemini-3-flash' },
        };
      });

      const response = await POST(makeRequest({ message: 'test' }));
      expect(response.status).toBe(500);
      expect(mockCreateMessage).not.toHaveBeenCalled();
    });

    it('wraps unstructured Inkling fallback text as one WhatsApp message', async () => {
      mockRunFacilitator.mockImplementation(async function* () {
        yield { type: 'text', data: 'A plain-text answer from the fallback model.' };
        yield {
          type: 'done',
          data: '',
          toolCalls: [],
          provenance: { provider: 'inkling', modelId: 'thinkingmachines/inkling' },
        };
      });

      const response = await POST(makeRequest({ message: 'test' }));

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ messages: ['A plain-text answer from the fallback model.'] });
      expect(mockCreateMessage).toHaveBeenCalledWith(
        expect.objectContaining({ content: [{ type: 'text', text: 'A plain-text answer from the fallback model.' }] }),
        USER.id,
      );
    });

    it('persists tool records as orphans when the model returns no text', async () => {
      const toolCalls = [{ type: 'tool_use', id: 'tool-1', name: 'search_quran', input: {} }];
      mockRunFacilitator.mockImplementation(async function* () {
        yield { type: 'done', data: '', toolCalls, provenance: { provider: 'gemini', modelId: 'm' } };
      });

      await POST(makeRequest({ message: 'test' }));

      expect(mockPersistOrphanToolCalls).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'empty_final', toolCalls }),
      );
    });
  });

  describe('thread history limit (issue #400)', () => {
    const ANSWER = '{"messages":["First part","Second part"]}';

    it('leads a warn-level answer with the warning as its own message', async () => {
      mockAssessHistory.mockReturnValue({ verdict: 'warn', estimatedTokens: 300_000 });
      mockRunFacilitator.mockImplementation(async function* () {
        yield { type: 'text', data: ANSWER };
        yield { type: 'done', data: '', toolCalls: [], provenance: { provider: 'gemini', modelId: 'm' } };
      });

      const response = await POST(makeRequest({ message: 'test' }));
      const body = await response.json();
      expect(body.messages).toEqual([HISTORY_WARNING_MESSAGE, 'First part', 'Second part']);
    });

    it('stores the warning ahead of a warn-level answer, as the thread route does', async () => {
      mockAssessHistory.mockReturnValue({ verdict: 'warn', estimatedTokens: 300_000 });
      mockRunFacilitator.mockImplementation(async function* () {
        yield { type: 'text', data: ANSWER };
        yield { type: 'done', data: '', toolCalls: [], provenance: { provider: 'gemini', modelId: 'm' } };
      });

      await POST(makeRequest({ message: 'test' }));
      expect(mockCreateMessage).toHaveBeenLastCalledWith(
        expect.objectContaining({
          role: 'assistant',
          content: [{ type: 'text', text: `${HISTORY_WARNING_MESSAGE}\n\nFirst part\n\nSecond part` }],
        }),
        USER.id,
      );
    });

    it('stores an ok-level answer without the warning', async () => {
      mockRunFacilitator.mockImplementation(async function* () {
        yield { type: 'text', data: ANSWER };
        yield { type: 'done', data: '', toolCalls: [], provenance: { provider: 'gemini', modelId: 'm' } };
      });

      await POST(makeRequest({ message: 'test' }));
      expect(mockCreateMessage).toHaveBeenLastCalledWith(
        expect.objectContaining({ role: 'assistant', content: [{ type: 'text', text: 'First part\n\nSecond part' }] }),
        USER.id,
      );
    });

    it('answers a block-level thread with the notice, without calling the model', async () => {
      mockAssessHistory.mockReturnValue({ verdict: 'block', estimatedTokens: 900_000 });

      const response = await POST(makeRequest({ message: 'test' }));
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ messages: [HISTORY_BLOCK_MESSAGE] });
      expect(mockRunFacilitator).not.toHaveBeenCalled();
    });

    it('stores the block notice as the assistant message', async () => {
      mockAssessHistory.mockReturnValue({ verdict: 'block', estimatedTokens: 900_000 });

      await POST(makeRequest({ message: 'test' }));
      expect(mockCreateMessage).toHaveBeenLastCalledWith(
        expect.objectContaining({
          threadId: THREAD.id,
          role: 'assistant',
          content: [{ type: 'text', text: HISTORY_BLOCK_MESSAGE }],
        }),
        USER.id,
      );
    });

    it('refuses one oversized message: the notice is the answer, nothing stored, no model call', async () => {
      mockIncomingMessageTooLong.mockReturnValue(true);

      const response = await POST(makeRequest({ message: 'x'.repeat(10) }));
      expect(await response.json()).toEqual({ messages: [HISTORY_MESSAGE_TOO_LONG_MESSAGE] });
      expect(mockGetOrCreateThread).not.toHaveBeenCalled();
      expect(mockRunFacilitator).not.toHaveBeenCalled();
    });

    it('leaves an ok-level answer unchanged', async () => {
      mockRunFacilitator.mockImplementation(async function* () {
        yield { type: 'text', data: ANSWER };
        yield { type: 'done', data: '', toolCalls: [], provenance: { provider: 'gemini', modelId: 'm' } };
      });

      const response = await POST(makeRequest({ message: 'test' }));
      expect((await response.json()).messages).toEqual(['First part', 'Second part']);
    });
  });

  describe('message persistence', () => {
    it('stores assistant message with correct metadata', async () => {
      const usage = {
        promptTokenCount: 100,
        candidatesTokenCount: 200,
        thoughtsTokenCount: 50,
        totalTokenCount: 350,
      };
      const provenance = { provider: 'gemini', modelId: 'gemini-3-flash' };
      const toolCalls = [{ type: 'tool_use', id: '1', name: 'search_quran', input: {} }];

      mockRunFacilitator.mockImplementation(async function* () {
        yield { type: 'text', data: '{"messages":["Test message"]}' };
        yield {
          type: 'done',
          data: '',
          usage,
          toolCalls,
          provenance,
          rawPayload: { role: 'model', parts: [] },
        };
      });

      await POST(makeRequest({ message: 'test' }));

      expect(mockCreateMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          threadId: THREAD.id,
          role: 'assistant',
          content: [{ type: 'text', text: 'Test message' }],
          agentName: 'facilitator',
          source: 'whatsapp',
          client: 'test-client',
          inputTokens: 100,
          outputTokens: 200,
          thinkingTokens: 50,
          totalTokens: 350,
          modelProvider: 'gemini',
          modelId: 'gemini-3-flash',
        }),
        USER.id,
      );
    });
  });

  describe('error handling', () => {
    it('returns 500 when facilitator throws an error', async () => {
      mockRunFacilitator.mockImplementation(async function* () {
        yield { type: 'error', data: 'Facilitator error' };
      });

      const response = await POST(makeRequest({ message: 'test' }));
      expect(response.status).toBe(500);
    });

    it('persists orphan tool calls on error', async () => {
      const toolCalls = [{ type: 'tool_use', id: '1', name: 'search_quran', input: {} }];
      const provenance = { provider: 'gemini', modelId: 'gemini-3-flash' };

      mockRunFacilitator.mockImplementation(async function* () {
        yield {
          type: 'error',
          data: 'Facilitator error',
          toolCalls,
          provenance,
        };
      });

      await POST(makeRequest({ message: 'test' }));

      expect(mockPersistOrphanToolCalls).toHaveBeenCalledWith(
        expect.objectContaining({
          threadId: THREAD.id,
          reason: 'error',
          source: 'whatsapp',
          client: 'test-client',
          toolCalls,
          provenance,
        })
      );
    });

    it('returns 500 when an unexpected error occurs', async () => {
      mockGetOrCreateThread.mockRejectedValue(new Error('Database error'));

      const response = await POST(makeRequest({ message: 'test' }));
      expect(response.status).toBe(500);
    });
  });
});