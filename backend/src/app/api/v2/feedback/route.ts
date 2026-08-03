import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { authenticateRequest, createErrorResponse } from '@/lib/auth/middleware';
import { createFeedback } from '@/lib/db/feedback';
import { findMessageInOwnedThread } from '@/lib/db/threads';
import { safeErrorMeta } from '@/lib/log';

const feedbackSchema = z.object({
  thread_id: z.string().uuid('Invalid thread ID'),
  message_id: z.string().uuid('Invalid message ID'),
  feedback_class: z.preprocess(
    (val) => {
      if (val === 'thumbsup') return 'thumbs_up';
      if (val === 'thumbsdown') return 'thumbs_down';
      return val;
    },
    z.enum(['thumbs_up', 'thumbs_down', 'report']),
  ),
  comment: z.string().optional(),
});

// POST /api/v2/feedback - Submit feedback on a message
export async function POST(request: NextRequest) {
  try {
    const authResult = await authenticateRequest(request);
    if ('error' in authResult) {
      return authResult.error;
    }

    const { user } = authResult;

    const body = await request.json();
    const parseResult = feedbackSchema.safeParse(body);
    if (!parseResult.success) {
      const errors = parseResult.error.issues.map((i) => i.message);
      return createErrorResponse(errors.join(', '), 422);
    }

    const { thread_id, message_id, feedback_class, comment } = parseResult.data;

    // Verify the message exists AND its thread belongs to the caller (spec 4).
    // A nonexistent, foreign-owned, or mismatched target all return this same
    // 404 — so feedback is neither a cross-user write nor an existence oracle.
    const message = await findMessageInOwnedThread(message_id, thread_id, user.id);
    if (!message) {
      return createErrorResponse('Message not found', 404);
    }

    // Create feedback
    const feedback = await createFeedback({
      userId: user.id,
      threadId: thread_id,
      messageId: message_id,
      feedbackClass: feedback_class,
      comment,
    });

    return NextResponse.json({
      id: feedback.id,
      thread_id: feedback.threadId,
      message_id: feedback.messageId,
      feedback_class: feedback.feedbackClass,
      comment: feedback.comment,
      created_at: feedback.createdAt?.toISOString(),
    });
  } catch (error) {
    // Log ONLY sanitized metadata — a raw driver error can embed user content
    // (the feedback comment, query params). See @/lib/log (issue #19).
    console.error('Feedback error:', safeErrorMeta(error));
    return createErrorResponse('Failed to submit feedback', 500);
  }
}
