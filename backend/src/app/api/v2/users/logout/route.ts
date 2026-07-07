import { NextRequest, NextResponse } from 'next/server';
import { extractBearerToken } from '@/lib/auth/jwt';
import { deleteToken } from '@/lib/db/users';
import { createErrorResponse } from '@/lib/auth/middleware';

export async function POST(request: NextRequest) {
  try {
    const authHeader = request.headers.get('Authorization');
    const token = extractBearerToken(authHeader);

    if (!token) {
      return createErrorResponse('Not authenticated', 401);
    }

    // Delete the token from the database
    await deleteToken(token);

    return NextResponse.json({ message: 'Successfully logged out' });
  } catch (error) {
    console.error('Logout error:', error);
    return createErrorResponse('Logout failed', 500);
  }
}
