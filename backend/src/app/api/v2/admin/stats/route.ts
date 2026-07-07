import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/admin';
import { createErrorResponse } from '@/lib/auth/middleware';
import {
  getSummaryStats,
  getUsersPerDay,
  getThreadsPerDay,
  getMessagesPerDay,
  getRecentMessages,
  getFeedbackSummary,
} from '@/lib/db/stats';

export async function GET(request: NextRequest) {
  const authResult = await requireAdmin(request);
  if ('error' in authResult) return authResult.error;

  const { searchParams } = new URL(request.url);
  const rawDays = searchParams.get('days');
  const rawLimit = searchParams.get('limit');

  if (rawDays !== null && (isNaN(Number(rawDays)) || rawDays.trim() === '')) {
    return createErrorResponse('Invalid days parameter', 400);
  }
  if (rawLimit !== null && (isNaN(Number(rawLimit)) || rawLimit.trim() === '')) {
    return createErrorResponse('Invalid limit parameter', 400);
  }

  const parsedDays = rawDays !== null ? parseInt(rawDays, 10) : 30;
  const parsedLimit = rawLimit !== null ? parseInt(rawLimit, 10) : 50;
  const days = Math.min(Math.max(parsedDays || 1, 1), 365);
  const limit = Math.min(Math.max(parsedLimit || 1, 1), 200);

  try {
    const [summary, usersPerDay, threadsPerDay, messagesPerDay, recentMessages, feedbackSummary] =
      await Promise.all([
        getSummaryStats(),
        getUsersPerDay(days),
        getThreadsPerDay(days),
        getMessagesPerDay(days),
        getRecentMessages(limit),
        getFeedbackSummary(),
      ]);

    return NextResponse.json({
      summary,
      time_series: {
        users_per_day: usersPerDay,
        threads_per_day: threadsPerDay,
        messages_per_day: messagesPerDay,
      },
      recent_messages: recentMessages,
      feedback_summary: feedbackSummary,
      generated_at: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Admin stats error:', error);
    return createErrorResponse('Internal server error', 500);
  }
}
