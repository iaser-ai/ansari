import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { authenticateRequest, createErrorResponse } from '@/lib/auth/middleware';
import { getPreferences, setPreference } from '@/lib/db/preferences';

// GET /api/v2/preferences - Get all user preferences
export async function GET(request: NextRequest) {
  try {
    const authResult = await authenticateRequest(request);
    if ('error' in authResult) {
      return authResult.error;
    }

    const { user } = authResult;
    const prefs = await getPreferences(user.id);

    // Convert to key-value object
    const prefsObject: Record<string, string> = {};
    for (const pref of prefs) {
      prefsObject[pref.key] = pref.value;
    }

    return NextResponse.json(prefsObject);
  } catch (error) {
    console.error('Get preferences error:', error);
    return createErrorResponse('Failed to get preferences', 500);
  }
}

const updatePreferencesSchema = z.record(z.string(), z.string());

// PUT /api/v2/preferences - Update user preferences
export async function PUT(request: NextRequest) {
  try {
    const authResult = await authenticateRequest(request);
    if ('error' in authResult) {
      return authResult.error;
    }

    const { user } = authResult;

    const body = await request.json();
    const parseResult = updatePreferencesSchema.safeParse(body);
    if (!parseResult.success) {
      return createErrorResponse('Invalid preferences format', 422);
    }

    const prefsToUpdate: Record<string, string> = parseResult.data;

    // Update each preference
    for (const [key, value] of Object.entries(prefsToUpdate)) {
      await setPreference(user.id, key, value as string);
    }

    // Return updated preferences
    const prefs = await getPreferences(user.id);
    const prefsObject: Record<string, string> = {};
    for (const pref of prefs) {
      prefsObject[pref.key] = pref.value;
    }

    return NextResponse.json(prefsObject);
  } catch (error) {
    console.error('Update preferences error:', error);
    return createErrorResponse('Failed to update preferences', 500);
  }
}
