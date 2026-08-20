import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, createErrorResponse } from '@/lib/auth/middleware';
import { createThreadSnapshot } from '@/lib/db/shares';

type RouteContext = {
  params: Promise<{ id: string }>;
};

// POST /api/v2/threads/[id]/share - Create a shareable link for a thread
export async function POST(request: NextRequest, context: RouteContext) {
  try {
    const authResult = await authenticateRequest(request);
    if ('error' in authResult) {
      return authResult.error;
    }

    const { user } = authResult;
    const { id: threadId } = await context.params;

    const share = await createThreadSnapshot(threadId, user.id);
    if (!share) {
      return createErrorResponse('Thread not found', 404);
    }

    // Return share URL
    const shareUrl = `/share/${share.id}`;

    return NextResponse.json({
      id: share.id,
      share_url: shareUrl,
      created_at: share.createdAt?.toISOString(),
    });
  } catch (error) {
    console.error('Share error:', error);
    return createErrorResponse('Failed to create share link', 500);
  }
}
