import { NextRequest, NextResponse } from 'next/server';
import { and, eq, isNull } from 'drizzle-orm';
import { requireUser, bearerToken } from '@/lib/auth/require-user';
import { db } from '@/lib/db/index';
import { deletedUsers, users } from '@/db/schema';
import { AuthServiceUnavailableError, deleteAuthUser } from '@/lib/auth-service/client';
import { createErrorResponse } from '@/lib/error-response';
import { safeErrorMeta } from '@/lib/log';

export async function GET(request: NextRequest) {
  try {
    const authResult = await requireUser(request);
    if ('error' in authResult) return authResult.error;

    const { user } = authResult;
    return NextResponse.json({
      id: user.id,
      email: user.email,
      first_name: user.firstName,
      last_name: user.lastName,
      source: user.source,
      created_at: user.createdAt?.toISOString(),
      updated_at: user.updatedAt?.toISOString(),
    });
  } catch (error) {
    console.error('Get user error:', safeErrorMeta(error));
    return createErrorResponse('Failed to get user info', 500);
  }
}

/**
 * Account deletion (spec 300, "Two databases" rule 5):
 * 1. A system account is refused before anything is touched.
 * 2. ONE app-database transaction deletes the row (threads, preferences and
 *    feedback cascade) and writes the tombstone. Both in one transaction is
 *    what keeps resolve-user's first-use path from resurrecting the account.
 * 3. apps/auth deletes the auth user and its sessions, asked with the user's
 *    own JWT (its account endpoint), and the tombstone is marked done. If that fails, the next
 *    request carrying this `sub`, a retry, or the operator script finishes it;
 *    the account is refused in the meantime, so the answer is still success.
 */
export async function DELETE(request: NextRequest) {
  try {
    const authResult = await requireUser(request);
    if ('error' in authResult) return authResult.error;

    const { user } = authResult;
    if (user.systemKey) return createErrorResponse('System accounts cannot be deleted', 403);

    await db.transaction(async (tx) => {
      await tx.delete(users).where(eq(users.id, user.id));
      await tx.insert(deletedUsers).values({ id: user.id }).onConflictDoNothing();
    });

    try {
      await deleteAuthUser(user.id, bearerToken(request.headers.get('Authorization')) as string);
      await db
        .update(deletedUsers)
        .set({ authDeletedAt: new Date() })
        .where(and(eq(deletedUsers.id, user.id), isNull(deletedUsers.authDeletedAt)));
    } catch (error) {
      const status = error instanceof AuthServiceUnavailableError ? error.status : null;
      console.warn('auth delete pending after account deletion', {
        userId: user.id,
        status,
        ...safeErrorMeta(error),
      });
    }

    return NextResponse.json({ message: 'Account successfully deleted' });
  } catch (error) {
    console.error('Delete user error:', safeErrorMeta(error));
    return createErrorResponse('Failed to delete account', 500);
  }
}
