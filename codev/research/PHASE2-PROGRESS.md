# Phase 2 Progress Summary: API Endpoint Implementation

**Date**: 2026-11-22
**Protocol**: SPIR
**Spec**: 360-whatsapp-non-streaming-answer-endpoint
**Phase**: 2 (API Endpoint Implementation)
**Status**: IN PROGRESS

## Overview

Phase 2 is in progress. The core API endpoint and supporting infrastructure have been implemented. The next steps are to add tests and update documentation.

## Completed Tasks

### 2.1 WhatsApp-Specific System Prompt ✅

**File**: `apps/api/lib/ai/prompts/facilitator-whatsapp.ts`

**What was done:**
- Created a new WhatsApp-specific system prompt based on the existing `FACILITATOR_SYSTEM_PROMPT`
- Added WhatsApp formatting rules:
  - `*bold*` instead of `**bold**`
  - `_italic_` instead of `*italic*`
  - `~strikethrough~` instead of `~~strikethrough~~`
  - `` `monospace` `` instead of ` ```code``` `
  - `•` for bullet points
  - `1. 2. 3.` for numbered lists
  - No headings, tables, or complex formatting
- Added WhatsApp-specific citation format:
  - `*Sources:*` instead of `**Citations**:`
  - Inline citations with `[1]`, `[2]`, etc.
- Added text splitting instructions:
  - Keep each message under 4096 characters
  - Split at paragraph → sentence → word boundaries
  - Add continuation markers like " (1/3)"
- Configured Gemini to return JSON with `messages` array

**Key Features:**
- Leverages existing Islamic scholarship instructions
- WhatsApp-specific formatting rules
- Clear separation from web/mobile prompts
- Easy to maintain and update

### 2.2 Update Facilitator Agent ✅

**File**: `apps/api/lib/facilitator/agent.ts`

**What was done:**
- Added import for `WHATSAPP_FACILITATOR_SYSTEM_PROMPT`
- Created `getSystemPrompt(source?: string)` helper function:
  - Returns `WHATSAPP_FACILITATOR_SYSTEM_PROMPT` if `source === 'whatsapp'`
  - Returns `FACILITATOR_SYSTEM_PROMPT` otherwise
- Updated `runFacilitator` function signature to include `source?: string` parameter
- Updated all system prompt references to use `getSystemPrompt(options?.source)`
- Updated synthesis pass to use dynamic system prompt

**Key Features:**
- Backward compatible (existing code continues to work)
- Clean separation of concerns
- Easy to extend for other clients in the future

### 2.3 Create New API Endpoint ✅

**File**: `apps/api/src/app/api/v2/chat/complete/route.ts`

**What was done:**
- Created new endpoint: `POST /api/v2/chat/complete`
- Request schema:
  ```typescript
  {
    message: string;        // Required
    expiryHours?: number;   // Optional, 0-24, default 3
  }
  ```
- Response schema:
  ```typescript
  {
    messages: string[];     // Array of WhatsApp-formatted messages
  }
  ```
- Authentication: JWT from Authorization header
- Error handling:
  - `401 Unauthorized`: Invalid or expired JWT
  - `422 Unprocessable Entity`: Missing or invalid message
  - `500 Internal Server Error`: AI model or database error

**Key Features:**
- Non-streaming endpoint (returns complete response)
- WhatsApp-specific formatting
- Thread lifecycle management
- Error handling and logging
- Sentry integration

### 2.4 Implement Thread Lifecycle Management ✅

**Files**: 
- `apps/api/db/schema/threads.ts` (schema update)
- `apps/api/lib/db/threads.ts` (new functions)
- `apps/api/drizzle/0011_whatsapp_thread_expiry.sql` (migration)

**What was done:**

1. **Schema Update:**
   - Added `lastMessageAt` field to `threads` table
   - Added index `idx_threads_source_lastmessage` for efficient queries

2. **New Functions:**
   - `isThreadExpired(thread: Thread, expiryHours: number): boolean`
     - Checks if thread has expired based on `lastMessageAt` and `expiryHours`
     - `expiryHours = 0` means always create new thread
   
   - `getOrCreateThread(userId: string, source: string, expiryHours: number): Promise<Thread>`
     - Gets existing thread or creates new one
     - Uses database transaction with row-level locking
     - Deletes expired thread first, then creates new one (atomic)
     - Prevents race conditions with concurrent messages
   
   - `updateThreadLastMessage(threadId: string): Promise<void>`
     - Updates thread's `lastMessageAt` timestamp
     - Called after storing user message

3. **Migration:**
   - Created manual migration: `0011_whatsapp_thread_expiry.sql`
   - Adds `last_message_at` column to `threads` table
   - Creates index for efficient queries
   - Updates existing threads to set `last_message_at = updated_at`

**Key Features:**
- Thread expiry is user-configurable (0-24 hours, default 3)
- Atomic delete + create operations
- Race condition prevention
- Backward compatible with existing threads

### 2.5 Update WhatsApp Endpoint ✅

**File**: `apps/api/src/app/api/v2/chat/complete/route.ts`

**What was done:**
- Integrated thread lifecycle management:
  - Calls `getOrCreateThread(user.id, 'whatsapp', expiryHours)`
  - Calls `updateThreadLastMessage(threadId)` after storing user message
- Passes `source: 'whatsapp'` to `runFacilitator`
- Handles WhatsApp-formatted response:
  - Parses JSON response from Gemini
  - Validates `messages` array structure
  - Returns `{ messages: string[] }` to client

**Key Features:**
- Complete end-to-end flow
- Thread reuse based on expiry
- WhatsApp-specific formatting
- Error handling

## Remaining Tasks

### 2.6 Add Tests ⏳

**What needs to be done:**
- Unit tests for thread lifecycle functions
- Integration tests for the new endpoint
- Test thread expiry logic
- Test race condition handling
- Test WhatsApp formatting
- Test error cases

### 2.7 Update API Documentation ⏳

**What needs to be done:**
- Document the new endpoint
- Update API reference
- Add examples
- Document error responses
- Document thread lifecycle

## Next Steps

1. **Add Tests**: Write comprehensive tests for the new functionality
2. **Update Documentation**: Document the new endpoint and thread lifecycle
3. **Deploy to Staging**: Test in staging environment
4. **Update WhatsApp Service**: Modify WhatsApp service to call new endpoint
5. **Monitor**: Monitor for issues and iterate

## Files Created/Modified

### Created:
- `apps/api/lib/ai/prompts/facilitator-whatsapp.ts` - WhatsApp-specific system prompt
- `apps/api/src/app/api/v2/chat/complete/route.ts` - New API endpoint
- `apps/api/drizzle/0011_whatsapp_thread_expiry.sql` - Database migration

### Modified:
- `apps/api/lib/facilitator/agent.ts` - Added source parameter and prompt selection
- `apps/api/db/schema/threads.ts` - Added lastMessageAt field and index
- `apps/api/lib/db/threads.ts` - Added thread lifecycle management functions

## Testing Checklist

- [ ] Unit tests for `isThreadExpired`
- [ ] Unit tests for `getOrCreateThread`
- [ ] Unit tests for `updateThreadLastMessage`
- [ ] Integration test for new endpoint
- [ ] Test thread expiry (0 hours, 1 hour, 24 hours)
- [ ] Test thread reuse
- [ ] Test thread creation
- [ ] Test race conditions
- [ ] Test WhatsApp formatting
- [ ] Test error cases (401, 422, 500)
- [ ] Test with real Gemini API
- [ ] Test with real WhatsApp Business API

## Deployment Checklist

- [ ] Run migration on staging database
- [ ] Deploy to staging
- [ ] Test in staging environment
- [ ] Run migration on production database
- [ ] Deploy to production
- [ ] Monitor for issues
- [ ] Update WhatsApp service to use new endpoint

## Notes

- The existing WhatsApp formatter in `apps/whatsapp` is kept on standby until we test Gemini's output
- If Gemini consistently returns correct WhatsApp format, we can remove the formatter code
- If Gemini needs help, we can activate the fallback formatter
- Thread lifecycle is now managed in the API layer, not the WhatsApp layer
- Thread expiry is user-configurable (0-24 hours, default 3 hours)

---

**Last Updated**: 2026-11-22 15:50
**Next Review**: After tests are added