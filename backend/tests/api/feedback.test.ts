import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const mockAuthenticateRequest = vi.fn();
vi.mock('@/lib/auth/middleware', () => ({
  authenticateRequest: (...args: unknown[]) => mockAuthenticateRequest(...args),
  createErrorResponse: (detail: string, status: number) =>
    NextResponse.json({ detail }, { status }),
}));

const mockCreateFeedback = vi.fn();
vi.mock('@/lib/db/feedback', () => ({
  createFeedback: (...args: unknown[]) => mockCreateFeedback(...args),
}));

const mockFindMessageById = vi.fn();
vi.mock('@/lib/db/threads', () => ({
  findMessageById: (...args: unknown[]) => mockFindMessageById(...args),
}));

import { POST } from '../../src/app/api/v2/feedback/route';

const user = {
  id: 'user-uuid',
  email: 'u@example.com',
  passwordHash: '',
  firstName: null,
  lastName: null,
  source: 'web',
  createdAt: new Date(),
  updatedAt: new Date(),
};

const THREAD_ID = '11111111-1111-4111-8111-111111111111';
const MESSAGE_ID = '22222222-2222-4222-8222-222222222222';

function makeRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost/api/v2/feedback', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer test-token',
    },
    body: JSON.stringify(body),
  });
}

describe('POST /api/v2/feedback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthenticateRequest.mockResolvedValue({ user });
    mockFindMessageById.mockResolvedValue({ id: MESSAGE_ID, threadId: THREAD_ID });
    mockCreateFeedback.mockImplementation(async (data) => ({
      id: 'feedback-uuid',
      threadId: data.threadId,
      messageId: data.messageId,
      feedbackClass: data.feedbackClass,
      comment: data.comment ?? null,
      createdAt: new Date('2026-05-01T00:00:00Z'),
    }));
  });

  it.each([
    ['thumbs_up'],
    ['thumbs_down'],
    ['report'],
  ])('accepts canonical value "%s" unchanged', async (value) => {
    const response = await POST(
      makeRequest({
        thread_id: THREAD_ID,
        message_id: MESSAGE_ID,
        feedback_class: value,
      }),
    );
    expect(response.status).toBe(200);
    expect(mockCreateFeedback).toHaveBeenCalledWith(
      expect.objectContaining({ feedbackClass: value }),
    );
  });

  it('normalizes legacy "thumbsup" to "thumbs_up"', async () => {
    const response = await POST(
      makeRequest({
        thread_id: THREAD_ID,
        message_id: MESSAGE_ID,
        feedback_class: 'thumbsup',
      }),
    );
    expect(response.status).toBe(200);
    expect(mockCreateFeedback).toHaveBeenCalledWith(
      expect.objectContaining({ feedbackClass: 'thumbs_up' }),
    );
    const body = await response.json();
    expect(body.feedback_class).toBe('thumbs_up');
  });

  it('normalizes legacy "thumbsdown" to "thumbs_down"', async () => {
    const response = await POST(
      makeRequest({
        thread_id: THREAD_ID,
        message_id: MESSAGE_ID,
        feedback_class: 'thumbsdown',
      }),
    );
    expect(response.status).toBe(200);
    expect(mockCreateFeedback).toHaveBeenCalledWith(
      expect.objectContaining({ feedbackClass: 'thumbs_down' }),
    );
    const body = await response.json();
    expect(body.feedback_class).toBe('thumbs_down');
  });

  it('rejects unknown feedback values with 422', async () => {
    const response = await POST(
      makeRequest({
        thread_id: THREAD_ID,
        message_id: MESSAGE_ID,
        feedback_class: 'wat',
      }),
    );
    expect(response.status).toBe(422);
    expect(mockCreateFeedback).not.toHaveBeenCalled();
  });
});
