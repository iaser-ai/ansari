import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, createErrorResponse } from '@/lib/auth/middleware';
import { deleteUser, deleteUserTokens } from '@/lib/db/users';

export async function GET(request: NextRequest) {
  try {
    const authResult = await authenticateRequest(request);
    if ('error' in authResult) {
      return authResult.error;
    }

    const { user } = authResult;

    // Return user info in Ansari's format
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
    console.error('Get user error:', error);
    return createErrorResponse('Failed to get user info', 500);
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const authResult = await authenticateRequest(request);
    if ('error' in authResult) {
      return authResult.error;
    }

    const { user } = authResult;

    // Delete all user tokens first
    await deleteUserTokens(user.id);

    // Delete the user (cascade will handle related records)
    const deleted = await deleteUser(user.id);
    if (!deleted) {
      return createErrorResponse('Failed to delete user', 500);
    }

    return NextResponse.json({ message: 'Account successfully deleted' });
  } catch (error) {
    console.error('Delete user error:', error);
    return createErrorResponse('Failed to delete account', 500);
  }
}
