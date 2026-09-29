import { NextRequest, NextResponse } from 'next/server';
import { findShareById } from '@/lib/db/shares';
import { createErrorResponse } from '@/lib/auth/middleware';

type RouteContext = {
  params: Promise<{ id: string }>;
};

// GET /api/v2/share/[id]/documents - Citable sources behind a shared thread's answers (spec 168).
// Public, like share GET. Reads ONLY the snapshot, where the documents were
// copied at share creation — never the stored tool records. `message_index` is the
// message's position in share GET's `messages` array.
export async function GET(request: NextRequest, context: RouteContext) {
  try {
    const { id } = await context.params;

    const share = await findShareById(id);
    if (!share) {
      return createErrorResponse('Share not found', 404);
    }

    const messages = share.content.messages.flatMap((m, index) =>
      Array.isArray(m.documents) && m.documents.length > 0
        ? [{ message_index: index, documents: m.documents }]
        : []
    );

    return NextResponse.json({ id: share.id, messages });
  } catch (error) {
    const e = error as { name?: string; code?: string };
    console.error('Get share documents error:', { name: e?.name, code: e?.code });
    return createErrorResponse('Failed to get shared documents', 500);
  }
}
