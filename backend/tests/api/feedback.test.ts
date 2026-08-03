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

const mockFindMessageInOwnedThread = vi.fn();
vi.mock('@/lib/db/threads', () => ({
  findMessageInOwnedThread: (...args: unknown[]) => mockFindMessageInOwnedThread(...args),
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
    mockFindMessageInOwnedThread.mockResolvedValue({ id: MESSAGE_ID, threadId: THREAD_ID });
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

  it('scopes the lookup to the authenticated user (owner-scoped query)', async () => {
    await POST(
      makeRequest({ thread_id: THREAD_ID, message_id: MESSAGE_ID, feedback_class: 'thumbs_up' }),
    );
    expect(mockFindMessageInOwnedThread).toHaveBeenCalledWith(MESSAGE_ID, THREAD_ID, user.id);
  });

  it('rejects a cross-user (foreign-thread) target and creates NO feedback', async () => {
    // The owner-scoped query returns nothing when the thread belongs to someone else.
    mockFindMessageInOwnedThread.mockResolvedValue(undefined);
    const response = await POST(
      makeRequest({ thread_id: THREAD_ID, message_id: MESSAGE_ID, feedback_class: 'report' }),
    );
    expect(response.status).toBe(404);
    expect(mockCreateFeedback).not.toHaveBeenCalled();
  });

  it('returns an IDENTICAL response for nonexistent, foreign-owned, and mismatched targets (no oracle)', async () => {
    // All three failure modes surface as the same owner-scoped miss.
    mockFindMessageInOwnedThread.mockResolvedValue(undefined);

    const bodies: unknown[] = [];
    const statuses: number[] = [];
    for (const [thread_id, message_id] of [
      ['33333333-3333-4333-8333-333333333333', '44444444-4444-4444-8444-444444444444'], // nonexistent
      [THREAD_ID, MESSAGE_ID], // foreign-owned
      [THREAD_ID, '55555555-5555-4555-8555-555555555555'], // mismatched message
    ]) {
      const res = await POST(makeRequest({ thread_id, message_id, feedback_class: 'thumbs_up' }));
      statuses.push(res.status);
      bodies.push(await res.json());
    }

    // Same status and same body shape for every failure mode.
    expect(statuses).toEqual([404, 404, 404]);
    expect(bodies[0]).toEqual(bodies[1]);
    expect(bodies[1]).toEqual(bodies[2]);
  });
});
