import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { authenticateRequest, createErrorResponse } from '@/lib/auth/middleware';
import { updateThread } from '@/lib/db/threads';

type RouteContext = {
  params: Promise<{ id: string }>;
};

const renameSchema = z.object({
  name: z.string().min(1, 'Name is required'),
});

// POST /api/v2/threads/[id]/name - Rename a thread
export async function POST(request: NextRequest, context: RouteContext) {
  try {
    const authResult = await authenticateRequest(request);
    if ('error' in authResult) {
      return authResult.error;
    }

    const { user } = authResult;
    const { id: threadId } = await context.params;

    const body = await request.json();
    const parseResult = renameSchema.safeParse(body);
    if (!parseResult.success) {
      const errors = parseResult.error.issues.map((i) => i.message);
      return createErrorResponse(errors.join(', '), 422);
    }

    const { name } = parseResult.data;

    const thread = await updateThread(threadId, user.id, { name });
    if (!thread) {
      return createErrorResponse('Thread not found', 404);
    }

    return NextResponse.json({
      status: 'success',
      thread_id: thread.id,
      thread_name: thread.name,
    });
  } catch (error) {
    console.error('Rename thread error:', error);
    return createErrorResponse('Failed to rename thread', 500);
  }
}
