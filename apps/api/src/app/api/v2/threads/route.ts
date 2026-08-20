import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { authenticateRequest, createErrorResponse } from '@/lib/auth/middleware';
import { findThreadsByUser, createThread } from '@/lib/db/threads';
import { getClientId } from '@/lib/attribution';

// GET /api/v2/threads - List user's threads
export async function GET(request: NextRequest) {
  try {
    const authResult = await authenticateRequest(request);
    if ('error' in authResult) {
      return authResult.error;
    }

    const { user } = authResult;
    const threads = await findThreadsByUser(user.id);

    // Return in Ansari's format (frontend expects thread_id and thread_name)
    return NextResponse.json(
      threads.map((t) => ({
        thread_id: t.id,
        thread_name: t.name,
        source: t.source,
        created_at: t.createdAt?.toISOString(),
        updated_at: t.updatedAt?.toISOString(),
      }))
    );
  } catch (error) {
    console.error('List threads error:', error);
    return createErrorResponse('Failed to list threads', 500);
  }
}

const createThreadSchema = z.object({
  name: z.string().optional(),
  source: z.string().optional(),
});

// POST /api/v2/threads - Create a new thread
export async function POST(request: NextRequest) {
  try {
    const authResult = await authenticateRequest(request);
    if ('error' in authResult) {
      return authResult.error;
    }

    const { user } = authResult;

    let body = {};
    try {
      body = await request.json();
    } catch {
      // Empty body is fine
    }

    const parseResult = createThreadSchema.safeParse(body);
    if (!parseResult.success) {
      const errors = parseResult.error.issues.map((i) => i.message);
      return createErrorResponse(errors.join(', '), 422);
    }

    const { name, source } = parseResult.data;

    // Per-client attribution from the X-Ansari-Client header (spec 56). `source`
    // (body) and `client` (header) are independent axes; leave `source` as-is.
    const client = getClientId(request);

    const thread = await createThread({
      userId: user.id,
      name,
      source,
      client,
    });

    // Return in Ansari's format (frontend expects thread_id)
    return NextResponse.json({
      thread_id: thread.id,
      thread_name: thread.name,
      source: thread.source,
      created_at: thread.createdAt?.toISOString(),
      updated_at: thread.updatedAt?.toISOString(),
    });
  } catch (error) {
    console.error('Create thread error:', error);
    return createErrorResponse('Failed to create thread', 500);
  }
}
