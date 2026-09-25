import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, createErrorResponse } from '@/lib/auth/middleware';
import { findThreadById } from '@/lib/db/threads';
import { findCitableDocumentsByThread } from '@/lib/db/citable-documents';

type RouteContext = {
  params: Promise<{ id: string }>;
};

// GET /api/v2/threads/[id]/documents - Citable sources behind a thread's answers (spec 168).
//
// Served separately from thread GET so that response stays byte-identical for
// released clients. `message_index` is the message's position in thread GET's
// `messages` array; only messages with at least one citable document appear.
export async function GET(request: NextRequest, context: RouteContext) {
  try {
    const authResult = await authenticateRequest(request);
    if ('error' in authResult) {
      return authResult.error;
    }

    const { user } = authResult;
    const { id } = await context.params;

    // Owner-scoped: a foreign thread is indistinguishable from a missing one.
    const thread = await findThreadById(id, user.id);
    if (!thread) {
      return createErrorResponse('Thread not found', 404);
    }

    const entries = await findCitableDocumentsByThread(thread.id);

    return NextResponse.json({
      thread_id: thread.id,
      messages: entries.map((e) => ({
        message_id: e.messageId,
        message_index: e.messageIndex,
        documents: e.documents,
      })),
    });
  } catch (error) {
    // {name, code} only: a raw driver error can embed query parameters.
    const e = error as { name?: string; code?: string };
    console.error('Get thread documents error:', { name: e?.name, code: e?.code });
    return createErrorResponse('Failed to get thread documents', 500);
  }
}
