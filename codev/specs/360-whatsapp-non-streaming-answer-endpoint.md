# Specification: Non-streaming answer endpoint for WhatsApp

<!--
SPEC vs PLAN BOUNDARY:
This spec defines WHAT and WHY. The plan defines HOW and WHEN.
-->

## Problem Statement

The WhatsApp service (`apps/whatsapp`) currently calls `POST /api/v2/threads/[id]/chat` which returns a Server-Sent Events (SSE) stream. The service must:
1. Collect all `text` events from the stream
2. Wait for the `done` event
3. Handle errors mid-stream
4. Aggregate the complete answer before formatting/splitting for WhatsApp

This streaming assembly is fragile around:
- Formatting edge cases (markdown that doesn't render properly on WhatsApp)
- Long answers that need splitting at logical boundaries
- Mid-stream errors that leave partial answers
- Connection drops during streaming

WhatsApp needs a finished, complete answer in one response so it can:
- Apply WhatsApp-specific formatting (convert markdown to WhatsApp's limited syntax)
- Split at paragraph/sentence boundaries respecting the 4,096 character limit
- Send multiple messages in order with continuation markers

## Current State

- `apps/api` provides `POST /api/v2/threads/[id]/chat` — SSE streaming endpoint used by web/mobile
- `apps/whatsapp` (TypeScript, in `feat/358-whatsapp-typescript` branch) consumes this stream via `AnsariClientReal.processMessage()`
- The WhatsApp service manages thread lifecycle: one thread per user, replaced after 3 hours of inactivity (configurable via `WHATSAPP_CHAT_RETENTION_HOURS`)
- Authentication: WhatsApp service exchanges BSUID for JWT via `apps/auth`'s `/api/whatsapp/session`, then calls `apps/api` with that JWT
- WhatsApp formatting is done in `apps/whatsapp/src/formatting/whatsappMessageFormatter.ts` — converts markdown to WhatsApp syntax (`*bold*`, `_italic_`, `~strikethrough~`, `` `monospace` ``)
- Message splitting is in `apps/whatsapp/src/formatting/messageSplitter.ts` — splits at paragraph boundaries, adds continuation markers like " (1/3)"

## Desired State

- `apps/api` provides a new non-streaming endpoint that returns a complete answer in one JSON response
- WhatsApp service calls this endpoint instead of the streaming one
- The endpoint handles thread creation/reuse internally (following the same expiry logic)
- **Thread expiry is user-configurable** (0-24 hours, where 0 = new thread per message), passed from WhatsApp layer. Default: 3 hours.
- Response includes the complete answer text as a **list of strings** (pre-split messages), ready for WhatsApp to send one by one
- The LLM (Gemini) is instructed to return WhatsApp-formatted text (using structured output/function calling)
- No streaming assembly needed in the WhatsApp service

## Success Criteria

- [ ] WhatsApp service can call a single endpoint and get a complete answer as a list of messages
- [ ] Thread lifecycle (create/reuse based on user-configurable expiry, default 3 hours) works correctly
- [ ] Authentication uses the same JWT flow (BSUID → apps/auth → JWT → apps/api)
- [ ] Answer text is complete and identical to what streaming would produce
- [ ] LLM (Gemini) returns WhatsApp-formatted text (using structured output/function calling)
- [ ] Response is split into WhatsApp-sized chunks (4096 chars) at paragraph/sentence boundaries
- [ ] Errors are returned as HTTP status codes with JSON error bodies
- [ ] No streaming logic remains in WhatsApp service for answer retrieval
- [ ] Unit and integration tests cover the new endpoint

## Constraints

**Baked Decisions (from issue #360 and #321; fixed for this spec):**

- **Architecture:** Separate WhatsApp service in monorepo (`apps/whatsapp`) calling `apps/api` over HTTP
- **User identity:** BSUID exchanged for JWT via `apps/auth` `/api/whatsapp/session`; `apps/api` identifies user by GUID in JWT
- **Thread lifecycle:** One thread per user, replaced after 3 hours inactivity (global `WHATSAPP_CHAT_RETENTION_HOURS`)
- **Answer format:** Complete text returned; WhatsApp service handles formatting/splitting
- **Authentication:** Same JWT flow as streaming endpoint

**Self-made decisions (open to comments):**
- Endpoint path: `POST /api/v2/chat/complete` (no thread ID in path — thread managed internally)
- Response format: `{ messages: string[] }` — list of pre-split messages (no threadId needed by WhatsApp layer)
- Thread handling: Auto-create/reuse based on user's last thread and expiry (moved to API layer)
- **Thread expiry**: User-configurable (0-24 hours, where 0 = new thread per message), passed from WhatsApp layer to API endpoint. Default: 3 hours.
- LLM output: Instructed to return WhatsApp-formatted text via structured output/function calling
- Text splitting: Smart splitting at paragraph/sentence boundaries (not hard character cuts)
- No usage/token info in response (not needed by WhatsApp layer)

## Assumptions

- `apps/auth` `/api/whatsapp/session` endpoint exists and works (spec 329)
- The AI model (Gemini) can run to completion without streaming
- **Thread expiry is user-configurable** (0-24 hours), stored in user preferences, passed from WhatsApp layer to API endpoint. Default: 3 hours.
- WhatsApp's 4,096 character limit and formatting constraints are handled by the API endpoint
- The new endpoint coexists with the streaming endpoint — both serve different clients
- Gemini supports structured output via function calling (confirmed in research)
- Smart text splitting libraries exist (e.g., `llm-chunk`, LangChain's `RecursiveCharacterTextSplitter`)

**Note on terminology**: In this spec, "the AI model" or "Gemini" refers to the language model that generates answers. The codebase currently calls the orchestration layer that wraps Gemini the "facilitator" (see `apps/api/lib/facilitator/agent.ts`). This spec uses "the AI model" or "Gemini" for simplicity, but the implementation will use the existing facilitator code.

## Solution Approaches

### Approach 1: New dedicated endpoint `/api/v2/chat/complete` (Recommended)

A new endpoint that:
- Accepts `{ message: string, expiryHours: number }` in body (expiryHours: 0-24, where 0 = new thread per message, default 3)
- Uses JWT from Authorization header to identify user
- Finds or creates thread based on user-configurable expiry (passed from WhatsApp layer)
- Runs the AI model (Gemini via facilitator) to completion with WhatsApp-specific formatting instructions
- Instructs the AI model to return WhatsApp-formatted text via structured output/function calling
- Splits the answer into WhatsApp-sized chunks (4096 chars) at paragraph/sentence boundaries
- Returns `{ messages: string[] }`

**Pros:**
- Clean separation from streaming endpoint
- Simple request/response — no SSE complexity
- Thread management encapsulated in one place (moved from WhatsApp layer)
- User-configurable expiry (0-24 hours, default 3) set by WhatsApp layer
- LLM returns WhatsApp-formatted text directly (no conversion needed in WhatsApp layer)
- Pre-split messages — WhatsApp layer just loops and sends
- Easy to test and debug
- Follows REST conventions for "complete" operations

**Cons:**
- New endpoint to maintain
- Thread logic duplicated from streaming endpoint (mitigated by shared helper)
- LLM must be instructed for WhatsApp format (requires prompt engineering)
- Text splitting logic needed in API layer (but libraries exist)

### Approach 2: Add `?stream=false` to existing endpoint

**Pros:**
- Single endpoint
- Shared thread logic

**Cons:**
- Mixes streaming and non-streaming in one route
- SSE response vs JSON response based on query param is non-standard
- Harder to test and document
- Still requires WhatsApp layer to handle formatting/splitting

### Approach 3: New endpoint at `/api/v2/threads/[id]/chat/complete`

**Pros:**
- Explicit thread in path
- Clear relationship to streaming endpoint

**Cons:**
- Requires client to know thread ID upfront
- WhatsApp service would need to call `GET /api/v2/threads` first
- More round trips
- Thread lifecycle still in WhatsApp layer

**Recommended: Approach 1** — Cleanest separation, simplest client code, thread management internalized, LLM returns WhatsApp-formatted text, pre-split messages.

## Open Questions

**Critical**
- None — authentication and thread lifecycle are settled by prior specs

**Important**
- Should the endpoint support `source` and `client` attribution like the streaming endpoint? (Currently WhatsApp uses `source: 'whatsapp'` and `client: 'askansari-whatsapp'`) — **User confirmed: Yes**
- How should the endpoint handle the `rawPayload` for multi-turn conversations? The streaming endpoint stores the final model turn's `rawPayload` on the assistant message. — **User confirmed: Yes**

**Explanation of `rawPayload` for multi-turn conversations:**

In simple terms: When you chat with the AI and it needs to search for information (like searching Quran/Hadith), it makes multiple "turns":
- **Turn 1**: You ask "What does the Quran say about patience?"
- **Turn 2**: The AI searches the Quran (tool call), gets results, then answers based on those results

The `rawPayload` is the AI's internal "memory" of what tools it called and what results it got. Without it, on the next message in the same conversation, the AI would "forget" what it searched for and might give inconsistent answers.

**Example scenario:**
1. User: "What does the Quran say about patience?"
2. AI searches Quran (tool call), gets verse 2:153
3. AI answers: "The Quran says in verse 2:153..."
4. User: "What about in the Hadith?"
5. AI needs to remember it already searched Quran, so it searches Hadith next

The `rawPayload` stores step 2-3's tool call history so step 5 can build on it.

**Nice-to-know**
- Whether the AI model's non-streaming path has any behavioral differences from streaming
- Performance comparison: single request vs streaming (latency, memory)

## Research Required

### 1. WhatsApp Message Components Analysis
Before implementing, we need to inspect what makes up the final response message in the streaming scenario:
- Text content
- Citations/footnotes
- Quran/Hadith references
- Tool call results
- Any other components

Then determine how each component should be formatted for WhatsApp's limited markdown:
- `*bold*` (not `**bold**`)
- `_italic_` (not `*italic*`)
- `~strikethrough~`
- `` `monospace` ``
- No headings, tables, or complex formatting
- URLs auto-linked

**Note**: Suggestions mentioned here are just suggestions, but further online research (via GitHub, Reddit, Facebook WhatsApp dev forums, etc.) will be necessary as well.

### 2. LLM Structured Output for WhatsApp Format
Research how to instruct the AI model (Gemini) to return WhatsApp-formatted text:
- Gemini supports function calling with JSON Schema (confirmed)
- Can use `responseMimeType: 'application/json'` with schema
- Or use function calling with a "format_whatsapp_message" function
- Need to define schema for WhatsApp-formatted response

**Note**: Suggestions mentioned here are just suggestions, but further online research (via GitHub, Reddit, etc.) will be necessary as well.

### 3. Smart Text Splitting
Research libraries/approaches for splitting text at paragraph/sentence boundaries:
- `llm-chunk` — simple, fast, splits by paragraph/sentence
- LangChain's `RecursiveCharacterTextSplitter` — splits by paragraphs → sentences → words
- `llm-splitter` — fast, lightweight, supports paragraph/sentence strategies
- Regex-based splitting as fallback
- Need to handle edge cases: long paragraphs, code blocks, lists

**Note**: Suggestions mentioned here are just suggestions, but further online research (via GitHub, Reddit, etc.) will be necessary as well.

### 4. Thread Lifecycle in API Layer
Current WhatsApp layer logic (in `conversationManager.ts`):
- Check if user has thread with `source='whatsapp'`
- If last message > expiry time ago, delete old thread and create new
- Otherwise reuse existing thread

This needs to move to the API endpoint. Questions:
- Should this logic be in a shared helper used by both streaming and non-streaming endpoints?
- How to handle concurrent messages (race conditions)?
- Should thread expiry be checked at the start of the request?

### 5. User-Configurable Expiry
Research Meta's WhatsApp Business API for user-configurable settings:
- Can users set preferences via "/" commands?
- How to present options (selection list, etc.)?
- How to store user preferences (0-24 hours, where 0 = new thread per message)?
- UI/UX for explaining expiry logic to users

**Default behavior**: 3 hours (current global setting). Users can override via "/" command to set 0-24 hours, where 0 = new thread per message.

## Test Scenarios

- **First message from user:** Creates new thread, returns answer as list of messages
- **Second message within expiry time (default 3 hours):** Reuses existing thread, returns answer as list of messages
- **Message after expiry time:** Deletes old thread/messages, creates new thread, returns answer as list of messages
- **Expiry = 0 (new thread per message):** Always creates new thread, deletes old one
- **Empty answer from AI model:** Returns appropriate error (not empty list)
- **AI model error:** Returns 5xx with error JSON
- **Invalid/expired JWT:** Returns 401
- **Missing message in body:** Returns 422
- **Concurrent messages:** Thread operations are atomic (no duplicate threads)
- **Long answer (10k+ chars):** Returns multiple messages in list, each ≤4096 chars, split at paragraph/sentence boundaries
- **Answer with markdown:** AI model returns WhatsApp-formatted text (`*bold*`, `_italic_`, etc.)
- **Answer with citations/footnotes:** Properly formatted for WhatsApp
- **Answer with Quran/Hadith references:** Properly formatted for WhatsApp
- **Code blocks in answer:** Handled appropriately (monospace or split)
- **Lists in answer:** Converted to WhatsApp-compatible format

## Risks and Mitigation

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| AI model non-streaming path differs from streaming | Low | Medium | Test both paths produce identical text |
| Thread race condition (concurrent messages) | Medium | High | Use DB transaction for thread find/create/delete |
| JWT expires mid-request (15 min) | Low | Medium | Same as streaming — 401 triggers re-exchange in WhatsApp service |
| Answer too large for single response | Low | Low | HTTP handles large bodies; pre-split into list anyway |
| LLM doesn't follow WhatsApp format instructions | Medium | Medium | Use structured output/function calling; test with various prompts |
| Text splitting breaks words/sentences | Medium | Medium | Use smart splitting library (llm-chunk, LangChain); test edge cases |
| WhatsApp formatting not supported for some content | Low | Low | Document limitations; fallback to plain text |
| Thread lifecycle logic duplicated | Low | Low | Extract to shared helper used by both endpoints |
| User-configurable expiry not in Meta API | Medium | Low | Use default 3 hours initially; add user preferences later |

## References

- Issue iaser-ai/ansari#360 — "apps/api: add answer endpoints that don't stream, for WhatsApp"
- Spec 321 — WhatsApp support in the monorepo (architecture, identity, thread lifecycle)
- Spec 329 — apps/auth service API keys / WhatsApp exchange (JWT contract)
- Branch `feat/358-whatsapp-typescript` — Current WhatsApp TypeScript implementation
- `apps/whatsapp/src/services/ansariClient.ts` — Current streaming client
- `apps/whatsapp/src/conversationManager.ts` — Thread lifecycle logic (to be moved to API layer)
- `apps/whatsapp/src/formatting/` — WhatsApp formatting and splitting (to be moved to API layer)
- WhatsApp Business API limits: 4,096 chars/message, limited markdown (`*bold*`, `_italic_`, `~strikethrough~`, `` `monospace` ``)
- Gemini API structured output: function calling with JSON Schema, `responseMimeType: 'application/json'`
- Text splitting libraries: `llm-chunk`, LangChain `RecursiveCharacterTextSplitter`, `llm-splitter`
- Meta WhatsApp Business API docs: https://developers.facebook.com/docs/whatsapp/business-management-api/ (for future user-configurable expiry research)