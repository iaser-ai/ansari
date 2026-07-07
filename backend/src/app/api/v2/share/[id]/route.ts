import { NextRequest, NextResponse } from 'next/server';
import { findShareById, createThreadSnapshot } from '@/lib/db/shares';
import { authenticateRequest, createErrorResponse } from '@/lib/auth/middleware';
import type { ContentBlock } from '@/db/schema/messages';

type RouteContext = {
  params: Promise<{ id: string }>;
};

// Format message content for API response
function formatMessageContent(content: ContentBlock[]): string | ContentBlock[] {
  if (content.length === 1 && content[0].type === 'text') {
    return content[0].text;
  }
  return content;
}

// GET /api/v2/share/[id] - Get shared thread content (public endpoint)
export async function GET(request: NextRequest, context: RouteContext) {
  try {
    const { id } = await context.params;

    const share = await findShareById(id);
    if (!share) {
      return createErrorResponse('Share not found', 404);
    }

    const snapshot = share.content;

    return NextResponse.json({
      id: share.id,
      thread_name: snapshot.threadName,
      messages: snapshot.messages.map((m) => ({
        role: m.role,
        content: formatMessageContent(m.content),
        created_at: m.createdAt,
      })),
      created_at: share.createdAt?.toISOString(),
    });
  } catch (error) {
    console.error('Get share error:', error);
    return createErrorResponse('Failed to get shared content', 500);
  }
}

// POST /api/v2/share/[id] - Create a shareable link for a thread
// Note: [id] here is the thread ID, not the share ID
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

    // Return share UUID (frontend expects share_uuid field)
    return NextResponse.json({
      share_uuid: share.id,
      created_at: share.createdAt?.toISOString(),
    });
  } catch (error) {
    console.error('Create share error:', error);
    return createErrorResponse('Failed to create share link', 500);
  }
}
