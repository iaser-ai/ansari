import { NextResponse } from 'next/server';

/**
 * The `{ detail }` error response, Ansari's one error shape (and the frozen
 * legacy contract's: spec 300 phase 1).
 */
export function createErrorResponse(
  detail: string,
  status: number = 400,
  headers?: HeadersInit
): NextResponse {
  return NextResponse.json({ detail }, { status, headers });
}
