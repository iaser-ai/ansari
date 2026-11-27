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

## Baseline (before implementation)

- `apps/api` provides `POST /api/v2/threads/[id]/chat` — SSE streaming endpoint used by web/mobile
- `apps/whatsapp` (TypeScript, in `feat/358-whatsapp-typescript` branch) consumes this stream via `AnsariClientReal.processMessage()`
- The WhatsApp service manages thread lifecycle: one thread per user, replaced after 3 hours of inactivity (configurable via `WHATSAPP_CHAT_RETENTION_HOURS`)
- Authentication: WhatsApp service exchanges BSUID for JWT via `apps/auth`'s `/api/whatsapp/session`, then calls `apps/api` with that JWT
- WhatsApp formatting is done in `apps/whatsapp/src/formatting/whatsappMessageFormatter.ts` — converts markdown to WhatsApp syntax (`*bold*`, `_italic_`, `~strikethrough~`, `` `monospace` ``)
- Message splitting is in `apps/whatsapp/src/formatting/messageSplitter.ts` — splits at paragraph boundaries, adds continuation markers like " (1/3)"

## Implemented Contract

- `apps/api` provides `POST /api/v2/chat/complete`, returning a complete answer in one JSON response
- WhatsApp service calls this endpoint instead of the streaming one
- The endpoint handles thread creation/reuse internally (following the same expiry logic)
- **Thread expiry is user-configurable** (0-24 hours, where 0 = new thread per message), passed from WhatsApp layer. Default: 3 hours.
- WhatsApp Gemini calls use JSON response mode with a schema requiring `messages: string[]`; the API parses and validates a non-empty array of non-empty strings before returning it
- The API stores an assistant answer only after that JSON/schema validation succeeds; the inbound user message remains stored if generation or validation fails
- Each array entry is intended to be one WhatsApp message. There is no deterministic server-side splitter or per-entry length check; the prompt asks the model to keep each entry under 4,096 characters
- The WhatsApp service sends returned entries in order, without formatting or splitting them again
- No streaming assembly remains in the WhatsApp service

The API also applies the thread-history limits described in plan amendment A1. `/expiry` is a WhatsApp chat command that causes the service to send a Meta interactive list; it is not an API endpoint.

## Success Criteria

- [x] WhatsApp service calls the single endpoint and sends its `messages` in order
- [x] Thread lifecycle supports create, reuse, expiry and expiry zero; unit and PGlite-backed checks pass
- [x] The endpoint uses the existing JWT authentication flow
- [x] A real local request returned a complete answer in the expected JSON shape
- [x] Gemini is prompted for WhatsApp-formatted JSON messages
- [x] WhatsApp Gemini calls enforce the JSON response schema, and the API validates it before persisting the assistant answer
- [ ] Long answers have not yet been checked to confirm every generated message stays within WhatsApp's 4,096-character limit; there is no deterministic splitter or length guard
- [x] Error responses use HTTP status codes and JSON bodies
- [x] WhatsApp answer retrieval no longer uses SSE
- [x] Endpoint and client unit tests pass; the real WhatsApp/Meta staging flow remains pending

## Constraints

**Baked Decisions (from issue #360 and #321; fixed for this spec):**

- **Architecture:** Separate WhatsApp service in monorepo (`apps/whatsapp`) calling `apps/api` over HTTP
- **User identity:** BSUID exchanged for JWT via `apps/auth` `/api/whatsapp/session`; `apps/api` identifies user by GUID in JWT
- **Thread lifecycle:** One thread per user, replaced after 3 hours inactivity (global `WHATSAPP_CHAT_RETENTION_HOURS`)
- **Answer format:** The API prompts Gemini to return WhatsApp-formatted `messages[]`; the WhatsApp service sends those strings as-is. The API does not deterministically split or enforce the per-message character limit.
- **Authentication:** Same JWT flow as streaming endpoint

**Decisions made during design and implementation:**
- Endpoint path: `POST /api/v2/chat/complete` (no thread ID in path — thread managed internally)
- Response format: `{ messages: string[] }` — model-generated message strings, with no threadId needed by the WhatsApp layer
- Thread handling: Auto-create/reuse based on user's last thread and expiry (moved to API layer)
- **Thread expiry**: User-configurable (0-24 hours, where 0 = new thread per message), passed from WhatsApp layer to API endpoint. Default: 3 hours.
- **Expiry UX (decided in Phase 3):** a user sends `/expiry` and picks from an interactive list of 0, 1, 2, 3, 6, 12 or 24 hours (Meta allows at most 10 rows, so not every hour is offered). The choice is stored in the existing per-user `preferences` table under `whatsapp.chat_retention_hours`, with no schema change. Users who never chose get the global `WHATSAPP_CHAT_RETENTION_HOURS` (default 3). The plan (A3) has the details.
- **Thread lifecycle and formatting move to apps/api (Phase 3):** the WhatsApp service no longer creates, reads or deletes threads, and it no longer formats or splits answers (plan A4). It sends the `messages[]` it receives.
- LLM output: WhatsApp Gemini calls set `responseMimeType: application/json` and a response schema requiring `messages` to be an array of strings; the prompt still supplies the formatting and message-length guidance
- **Assistant persistence:** The API persists the inbound user message before generation, but persists the assistant answer only after JSON parsing and response-shape validation. This is still before returning the API response; it does not wait for Meta to accept or deliver the outbound WhatsApp message.
- Text splitting: No deterministic splitter is used. Gemini is asked to return one WhatsApp-sized message per array entry; the endpoint does not enforce the character limit.
- No usage/token info in response (not needed by WhatsApp layer)
- **Thread history limit (added at Phase 2 review, issue #400):** the endpoint applies the same limit as the thread route. A message over the block threshold on its own is refused and not stored; a warn-level thread gets the warning as its own first `messages` item; a block-level thread gets the notice as its answer with no model call. Both notices are stored, as on the thread route, for consistency (see plan, Amendments A1).

## Assumptions

- `apps/auth` `/api/whatsapp/session` endpoint exists and works (spec 329)
- The AI model (Gemini) can run to completion without streaming
- **Thread expiry is user-configurable** (0-24 hours), stored in user preferences, passed from WhatsApp layer to API endpoint. Default: 3 hours.
- The prompt asks Gemini to follow WhatsApp's formatting and 4,096-character limit. The API does not enforce the per-message limit, so long-answer validation remains necessary.
- The new endpoint coexists with the streaming endpoint — both serve different clients
- WhatsApp Gemini calls use JSON response mode and a schema; the API strips optional code fences and validates the parsed response shape.
- A dedicated text-splitting library is not used; Gemini supplies message boundaries.

**Note on terminology**: In this spec, "the AI model" or "Gemini" refers to the language model that generates answers. The codebase currently calls the orchestration layer that wraps Gemini the "facilitator" (see `apps/api/lib/facilitator/agent.ts`). This spec uses "the AI model" or "Gemini" for simplicity, but the implementation will use the existing facilitator code.

## Solution Approaches

### Approach 1: New dedicated endpoint `/api/v2/chat/complete` (Recommended)

A new endpoint that:
- Accepts `{ message: string, expiryHours: number }` in body (expiryHours: 0-24, where 0 = new thread per message, default 3)
- Uses JWT from Authorization header to identify user
- Finds or creates thread based on user-configurable expiry (passed from WhatsApp layer)
- Runs the AI model (Gemini via facilitator) to completion with WhatsApp-specific formatting instructions
- Instructs the AI model to return WhatsApp-formatted JSON with a `messages` array
- Asks the model to keep each message under 4,096 characters; the API does not enforce this with a deterministic splitter or length check
- Returns `{ messages: string[] }`

**Pros:**
- Clean separation from streaming endpoint
- Simple request/response — no SSE complexity
- Thread management encapsulated in one place (moved from WhatsApp layer)
- User-configurable expiry (0-24 hours, default 3) set by WhatsApp layer
- LLM returns WhatsApp-formatted text directly (no conversion needed in WhatsApp layer)
- A list of WhatsApp message strings — WhatsApp layer sends each entry in order
- Easy to test and debug
- Follows REST conventions for "complete" operations

**Cons:**
- New endpoint to maintain
- No deterministic splitter means an overlong model response can still be rejected by Meta
- LLM must be instructed for WhatsApp format (requires prompt engineering)

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

**Recommended: Approach 1** — Clean separation, simple client code, API-owned thread management, and model-generated WhatsApp-formatted message strings.

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

## Design Decisions

- **WhatsApp response shape:** Gemini's JSON response mode and response schema require a `messages` array. The API also strips optional code fences and validates that it contains at least one non-empty string before persisting or returning it; the WhatsApp service sends each returned string in order.
- **Assistant persistence:** Save assistant output only after that parse and schema validation succeeds. Do not wait for Meta delivery acknowledgment in this change; comparing that alternative is deferred to a separate issue draft.
- **Formatting and splitting:** The prompt asks Gemini to use WhatsApp formatting and keep each message under 4,096 characters. No deterministic conversion or splitting layer remains in the WhatsApp service, and the API does not enforce the character limit. A real long-answer check is still required.
- **Thread lifecycle:** `POST /api/v2/chat/complete` finds, reuses, expires, or replaces the user's WhatsApp thread in the API layer. The existing per-user preferences API stores the selected expiry.
- **Expiry UX:** A user sends `/expiry` in WhatsApp and chooses from a Meta interactive list with 0, 1, 2, 3, 6, 12, or 24 hours. This is a chat command, not a backend route; details are recorded in plan amendment A3.
- **History limits:** The endpoint mirrors the thread route's oversized-message, warning, and block behavior; details and rationale are recorded in plan amendment A1.

## Test Scenarios

- **First message from user:** Creates new thread, returns answer as list of messages
- **Second message within expiry time (default 3 hours):** Reuses existing thread, returns answer as list of messages
- **Message after expiry time:** Deletes old thread/messages, creates new thread, returns answer as list of messages
- **Expiry = 0 (new thread per message):** Always creates new thread, deletes old one
- **Empty answer from AI model:** Returns appropriate error (not empty list)
- **Malformed JSON or invalid `messages` shape:** Returns an error and does not persist an assistant answer; the inbound user message remains stored
- **AI model error:** Returns 5xx with error JSON
- **Invalid/expired JWT:** Returns 401
- **Missing message in body:** Returns 422
- **Concurrent messages:** The lifecycle uses a transaction and row-level locking; verification with concurrent requests against staging PostgreSQL remains pending
- **Long answer (10k+ chars):** Pending real validation; Gemini is prompted to return multiple messages, each ≤4096 characters, but the API does not enforce this.
- **Answer with markdown:** AI model returns WhatsApp-formatted text (`*bold*`, `_italic_`, etc.)
- **Answer with citations/footnotes:** Properly formatted for WhatsApp
- **Answer with Quran/Hadith references:** Properly formatted for WhatsApp
- **Code blocks in answer:** Handled appropriately (monospace or split)
- **Lists in answer:** Converted to WhatsApp-compatible format

## Risks and Mitigation

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| AI model returns invalid JSON or messages over WhatsApp's limit | Medium | Medium | Parse/shape tests plus real long-answer checks; no deterministic length guard exists |
| Thread race condition (concurrent first messages) | Medium | High | Transactional thread lifecycle and row locking; verify concurrent requests against staging PostgreSQL |
| JWT expires mid-request (15 min) | Low | Medium | Same as streaming — 401 triggers re-exchange in WhatsApp service |
| Answer too large for single response | Medium | Medium | Model is prompted to return multiple entries under 4,096 characters, but the API does not enforce this; test long answers |
| LLM doesn't follow WhatsApp format instructions | Medium | Medium | Structured-output constraint and API-side validation; test varied real responses |
| WhatsApp formatting not supported for some content | Low | Low | Document limitations; fallback to plain text |

## References

- Issue iaser-ai/ansari#360 — "apps/api: add answer endpoints that don't stream, for WhatsApp"
- Spec 321 — WhatsApp support in the monorepo (architecture, identity, thread lifecycle)
- Spec 329 — apps/auth service API keys / WhatsApp exchange (JWT contract)
- Branch `feat/360-whatsapp-chat-complete` — WhatsApp migration based on the merged TypeScript service
- `apps/api/src/app/api/v2/chat/complete/route.ts` — Non-streaming endpoint and API-owned thread lifecycle
- `apps/api/lib/ai/prompts/facilitator-whatsapp.ts` — WhatsApp-specific prompt and JSON response contract
- `apps/whatsapp/src/services/ansariClient.ts` — Non-streaming client and preference calls
- `apps/whatsapp/src/conversationManager.ts` — `/expiry`, list-reply handling, and delivery of API-provided messages
- WhatsApp Business API limits: 4,096 chars/message, limited markdown (`*bold*`, `_italic_`, `~strikethrough~`, `` `monospace` ``)