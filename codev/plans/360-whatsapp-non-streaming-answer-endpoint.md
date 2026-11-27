# Implementation Plan: Non-streaming answer endpoint for WhatsApp

<!--
PLAN vs SPEC BOUNDARY:
This plan defines HOW and WHEN. The spec defines WHAT and WHY.
-->

## Overview

This plan implements the non-streaming answer endpoint for WhatsApp as specified in `codev/specs/360-whatsapp-non-streaming-answer-endpoint.md`.

**Goal**: Have the TypeScript WhatsApp service use `POST /api/v2/chat/complete` and send the API's WhatsApp-formatted `messages[]` response without SSE assembly or client-side formatting/splitting.

**Status (2026-11-27)**: Phases 1-4 are complete for this PR. Phase 3 is implemented; WhatsApp Gemini calls request schema-constrained JSON, and the API validates before assistant persistence. The owner checked the long-answer message lengths and the 3-hour expiry reuse, and confirmed a local `!d` roundtrip through the Test app callback and reserved zrok. Deployment and staging validation happen after the PR is accepted (see *Follow-up after the PR is accepted*).

## Architecture

```
WhatsApp Service (apps/whatsapp)
    ↓ HTTP POST with JWT and expiryHours
API Endpoint (apps/api/src/app/api/v2/chat/complete/route.ts)
    ↓
Thread lifecycle + history limits
    ↓
Facilitator (WhatsApp-specific prompt)
    ↓
JSON Response { messages: string[] }
    ↓
WhatsApp Service sends each string in order
```

Gemini supplies message boundaries and is prompted to keep each string under 4,096 characters. The API parses the response shape but does not deterministically split or enforce the per-message limit.

## Phase 1: Research & Design (1-2 days)

### 1.1 WhatsApp Message Components Analysis
- [x] Inspect the existing answer and WhatsApp formatting paths
- [x] Choose WhatsApp formatting instructions in the facilitator prompt
- [x] Decide that the API returns message strings and the WhatsApp service sends them without a second formatting pass

### 1.2 LLM Output Format Research
- [x] Choose the WhatsApp-specific prompt's JSON `{ "messages": string[] }` response contract
- [x] Parse the model response in the API and test its success/error paths
- [x] Confirm one real local answer parses successfully (see Phase 3.5)

### 1.3 Response Size and Message Boundaries
- [x] Choose model-generated `messages[]` boundaries; no text-splitting dependency or client-side splitter is used
- [x] Remove the old WhatsApp formatter/splitter rather than transforming API-formatted output twice
- [x] Validate long answers in Phase 4 (owner-checked 2026-11-27); the API does not enforce the 4,096-character limit

### 1.4 Thread Lifecycle Design
- [x] Move thread selection/replacement to the API's existing transactional helper
- [x] Store the user's expiry in the existing preferences API; no schema change is needed
- [x] Cover create/reuse/expiry-zero behavior with unit tests and lifecycle behavior with PGlite

## Phase 2: API Endpoint Implementation (3-4 days)

### 2.1 Create Endpoint Skeleton
- [x] Create `apps/api/src/app/api/v2/chat/complete/route.ts`
- [x] Add request validation (Zod schema)
- [x] Add authentication (`requireUser`)
- [x] Add error handling and Sentry reporting

### 2.2 Thread Management
- [x] Implement thread find/create logic in the API
- [x] Add expiry handling (user-configurable, default 3 hours)
- [x] Replace the expired thread and its messages atomically
- [x] Add unit and PGlite-backed lifecycle tests

### 2.3 Facilitator Integration
- [x] Integrate with the existing facilitator (`runFacilitator`)
- [x] Add WhatsApp-specific formatting instructions
- [x] Request schema-constrained JSON containing a `messages` array on WhatsApp Gemini calls
- [x] Add tests for facilitator integration and malformed output
- [x] Persist an assistant answer only after JSON parsing and response-shape validation

### 2.4 Response Formatting
- [x] Use the facilitator's WhatsApp prompt and Gemini response schema to produce formatted message strings
- [x] Do not add a deterministic splitter or another WhatsApp formatting pass
- [x] Test JSON parsing and require a non-empty array of non-empty strings
- [x] Keep invalid model output out of assistant thread history while preserving the inbound user message
- [x] Validate long-answer length and formatting with real model responses (owner-checked 2026-11-27)

### 2.5 Error Handling
- [x] Implement error responses (HTTP status codes + JSON)
- [x] Add Sentry integration
- [x] Add tests for error scenarios

## Phase 3: WhatsApp Service Updates (2-3 days)

### 3.1 Update AnsariClient
- [x] Replace streaming `processMessage()` with `completeChat(token, { message, expiryHours })` for `POST /api/v2/chat/complete`
- [x] Remove WhatsApp-side thread lifecycle calls; the API owns the thread
- [x] Add preference reads/writes for `whatsapp.chat_retention_hours`
- [x] Remove unused SSE-only helpers and their tests
- [x] Keep the mock client on the same interface
- [x] Cover success, empty messages, 401, 422, 5xx, network faults, and malformed JSON

### 3.2 Update ConversationManager
- [x] Remove `#resolveThread` and thread-lifecycle notices
- [x] Read the user's expiry (defaulting to `WHATSAPP_CHAT_RETENTION_HOURS`) and pass it as `expiryHours`
- [x] Send each returned `messages[]` string in order without reformatting or splitting
- [x] Preserve the empty-answer notice
- [x] Add `/expiry` and the 0, 1, 2, 3, 6, 12, 24-hour choices
- [x] Save list replies, confirm valid choices, and reject unknown choices
- [x] Add branch coverage in the conversation manager tests

### 3.3 Webhook and Meta send
- [x] `metaApiService`: send an interactive list message (max 10 rows, row title max 24 characters)
- [x] `parseWebhook` already passes an interactive body through unchanged, so no parser change was needed. The routing is in `conversationManager` (`listReplyId`, `routeByPrefix`, `triage`), where a list reply is answered only by the environment named in its row id (`expiry:<hours>:<environment>`)
- [x] Add tests for both (`metaApiService.test.ts`: interactive lists; `conversationManager.test.ts`: the list reply and its routing)

### 3.4 Remove Old Formatting/Splitting (A4)
- [x] Remove `apps/whatsapp/src/formatting/` and its tests
- [x] Remove unused `utils/pythonText.ts` and its test
- [x] Update imports and the README

### 3.5 Local auth/API smoke checks (throwaway, not committed; not Meta E2E)
- [x] Exercise the expiry preference flow against local auth/API and a real local database; the outbound Meta sender was a mock, not WhatsApp or zrok
- [x] Make one real local `AnsariClientReal` request through apps/auth and apps/api. It returned one 2,631-character message in 13.69 seconds, below the 4,096-character limit. At that time, the request used the production API key because no Gemini API key was present on staging; this was a local model smoke test, not staging validation.
- [x] Show the raw model output to the user and remove the temporary chat-completion harness afterward
- [x] Validate long answers (10k+) and expiry-three-hour reuse; the owner checked them on 2026-11-27 (all message lengths were within the limit)
- [ ] Keep the expiry harness only until its output is reviewed; it uses a mock Meta sender and must not be presented as a live WhatsApp test

## Phase 4: Testing & Validation (2-3 days)

### 4.1 Unit Tests
- [x] Test endpoint inputs, authentication, response shape, history limits, and error scenarios (`whatsapp-chat-complete.test.ts`)
- [x] Verify malformed JSON and invalid message shapes do not persist an assistant answer
- [x] Verify WhatsApp facilitator calls carry the JSON MIME type and response schema
- [x] Test thread create/reuse/expiry behavior (`thread-lifecycle.test.ts` and the PGlite-backed `thread-lifecycle.integration.test.ts`)
- [x] Confirm text splitting is not a service responsibility; the model supplies `messages[]` boundaries, so there is no splitter to unit-test
- [x] Test the WhatsApp client and conversation manager branches in the WhatsApp suite

### 4.2 Integration Tests
- [x] Exercise `AnsariClientReal` against local auth/API with one real model answer (Phase 3.5); this did not run the full webhook/Meta delivery path
- [x] Make one direct local `POST /api/v2/chat/complete` request with the structured-output change; it returned HTTP 200 with one valid `messages` string (1,061 characters). This exercised local auth/API and the configured staging Vertex credentials, not the WhatsApp webhook or Meta delivery path.
- [x] Owner confirmed one successful local `!d` roundtrip through the Test app callback and reserved zrok; the response arrived (2026-11-26). This is not a deployed-staging test.
- [x] Test a real answer over 10k characters and inspect every returned message length; the owner checked this on 2026-11-27. The API still relies on the model prompt for the 4,096-character limit (see Risks)

### 4.3 Manual Testing
- [x] Owner verified one local `!d` message through the TypeScript WhatsApp service via the Test app and reserved zrok, and confirmed the response was received (2026-11-26)
- [x] Owner ran the 15,000-character WhatsApp prompt: splitting and formatting were good. The `---` divider lines were then addressed by a prompt rule only (A5); the owner decided not to re-test them.

## Phase 5: Documentation & Deployment (1-2 days)

### 5.1 Documentation
- [x] Update API documentation (`apps/api/README.md`: new "`POST /api/v2/chat/complete`" section with request, response, errors and persistence)
- [x] Update WhatsApp service documentation (README)
- [x] Record implementation decisions and validation status in this plan and the spec
- [x] Add/retain comments where they explain non-obvious behavior

### 5.2 Deployment

Moved to *Follow-up after the PR is accepted*. Deployment is not required for Phases 1-5 of this PR.

## Technical Decisions

### Text Splitting
**Choice**: No deterministic splitting library. Gemini is prompted to return `messages[]`, with each entry under 4,096 characters; the API parses the response but does not validate entry lengths.

**Reasoning**:
- Avoids reformatting or splitting the already WhatsApp-formatted response in the service
- Keeps message boundaries with the model's answer structure
- Leaves a known risk: a non-conforming or long answer can exceed Meta's limit; Phase 4 must test this

### LLM Output Format
**Choice**: WhatsApp Gemini calls set `responseMimeType: application/json` and a response schema requiring `{ "messages": string[] }`. The prompt continues to define WhatsApp formatting and message-length guidance; the API removes optional Markdown code fences and independently validates a non-empty array of non-empty strings.

**Persistence**: The inbound user message is stored before model generation. The assistant answer is stored only after JSON parsing and shape validation succeed, but before the API response is returned. The endpoint does not wait for Meta send acknowledgment; that comparison is deferred to a separate issue draft.

**Validation**: API tests cover parsing, invalid output, and persistence behavior. One direct local request returned the expected `messages: string[]` response; the one generated part was under 4,096 characters. This does not establish long-answer, multi-part, or WhatsApp delivery behavior.

### Thread Management
**Choice**: The non-streaming endpoint calls the API's transactional `getOrCreateThread` helper, scoped to the user's `whatsapp` threads.

**Reasoning**:
- Keep thread creation, reuse, and expiry inside the API
- Existing thread-level row locking and PGlite lifecycle tests cover schema-backed lifecycle behavior

## Dependencies

- Existing: `zod` (for validation)
- Existing: `@sentry/nextjs` (for error tracking)
- Existing test dependency: `@electric-sql/pglite` (for PostgreSQL-backed thread lifecycle tests)

## Risks & Mitigation

| Risk | Mitigation |
|------|------------|
| Model returns invalid JSON or a part over 4,096 characters | Validate JSON/error paths in unit tests; inspect real long answers in Phase 4. No deterministic length guard exists. |
| Thread lifecycle race conditions | Transaction and row-lock implementation plus PGlite lifecycle tests. |
| Latency exceeds target | Measure real responses; one local model smoke test took 13.69 seconds, so the <5-second target is not yet met. |

## Timeline

- **Week 1**: Phase 1 (Research & Design)
- **Week 2**: Phase 2 (API Endpoint Implementation)
- **Week 3**: Phase 3 (WhatsApp Service Updates) + Phase 4 (Testing)
- **Week 4**: Phase 4 (Testing) + Phase 5 (Documentation & Deployment)

## Success Metrics

- [x] Endpoint returns a typical answer in < 5 seconds (checked 2026-11-27: shorter answers pass; one long local answer took 13.69 seconds)
- [x] Every generated message stays within 4,096 characters on long-answer tests (owner-checked, 2026-11-27)
- [x] WhatsApp formatting renders correctly on device (owner's 15,000-character test; the divider rule is prompt-only, see A5 and not re-verified)
- [ ] No increase in error rate (after deployment; follow-up scope)
- [ ] Positive user feedback (after deployment; follow-up scope)

## References

- Spec: `codev/specs/360-whatsapp-non-streaming-answer-endpoint.md`
- Issue: https://github.com/iaser-ai/ansari/issues/360
- Current streaming endpoint: `apps/api/src/app/api/v2/threads/[id]/chat/route.ts`
- WhatsApp service: `apps/whatsapp/src/services/ansariClient.ts`
- WhatsApp prompt: `apps/api/lib/ai/prompts/facilitator-whatsapp.ts`
- Facilitator: `apps/api/lib/facilitator/agent.ts`

---

## Testing Methodology (IMPORTANT — applies to EVERY phase)

**Established in Phase 2. Carry this through Phase 4 and any later validation.**

Direct API smoke tests do not exercise the WhatsApp webhook, Meta send, or delivery-acknowledgment path.

### The rule
Every phase ends with **BOTH**:
1. **Mocked unit/integration tests** (`tests/*.test.ts`, vitest) — free, deterministic, run in CI. These validate *our* logic (auth, validation, thread mgmt, error handling, response parsing).
2. **A real, one-off model-backed API smoke test** (`scripts/*.ts`, run with `tsx`) — costs real API usage (Gemini, Kalemat, Usul) but validates the *actual* behavior of the AI and external tools. It is not a full WhatsApp/Meta end-to-end test: it does not exercise the webhook, Meta send, or delivery acknowledgment. Keep these scripts untracked and out of CI; show the output for human review, then remove the script or keep it ignored only while its output still needs review.

### Why both (what we learned in Phase 2)
- Mocked tests **cannot** catch: Gemini wrapping JSON in ```` ```json ```` code fences, tools being degraded (Kalemat `invalid_body`, Usul 502), or whether the WhatsApp prompt actually produces `*bold*`/`_italic_`/Arabic formatting. All of these only surfaced in the real script run.
- The codebase convention confirms this split: `gemini.test.ts` explicitly mocks the SDK ("we can't make real API calls in tests"); `auth.integration.test.ts` uses real pglite (not mocks) for DB behavior; real external calls live in `scripts/` (e.g. `bench-documents.bench.ts`). Our `scripts/test-whatsapp-endpoint.ts` follows this exact pattern.

### The direct API test pattern (reuse for later phases)
`scripts/test-whatsapp-endpoint.ts` exercises the real auth/API path:
1. Sign up a throwaway user at `AUTH_URL/api/auth/sign-up/email` (needs `Origin` header = `http://localhost:3000`).
2. Exchange the session token for a JWT at `AUTH_URL/api/auth/token` (GET, `Authorization: Bearer <sessionToken>`, `Origin` header).
3. POST to the endpoint under test with `Authorization: Bearer <jwt>`.
4. Print the raw response and parsed messages.

**These real-test scripts are THROWAWAY validation aids, NOT committed artifacts.** They exist only so the human can watch real output once and confirm the phase works. Do NOT commit them and do NOT wire them into CI — a real API call on every CI run costs money and is non-deterministic. Delete a script once its output has been reviewed. The committed, CI-safe signal is the mocked vitest suite; the script is the one-time human eyeball check on top of it.

**Prerequisites**: `apps/api` dev server running (`pnpm dev`, port 3000) **and** `apps/auth` dev server running (`pnpm dev`, port 3100), each with its `.env` copied from the main checkout (`apps/api/.env`, `apps/auth/.env`). The API verifies JWTs via the auth service's JWKS, so auth MUST be up or every request 401s.

### Checklist for each remaining phase
- [x] Mocked tests written and passing; keep them committed and CI-safe
- [x] One local real-model answer was exercised and shown to the user; its temporary chat-only harness was then removed
- [x] One direct local API request returned schema-valid JSON after the structured-output change; no WhatsApp webhook or Meta send was simulated
- [ ] Run the deployed staging WhatsApp/Meta flow (follow-up after the PR; see *Follow-up after the PR is accepted*); the direct local API smoke test used staging Vertex credentials but does not validate the deployed webhook or delivery path
- [ ] User reviews the separate expiry-flow harness output before that throwaway script is removed

### Phase 4 verification record (2026-11-26)

- API focused tests: `pnpm exec vitest run tests/whatsapp-chat-complete.test.ts tests/thread-lifecycle.test.ts tests/thread-lifecycle.integration.test.ts tests/source-scan/history-limit-coverage.test.ts` — **40 passed**.
- WhatsApp tests: the initial parallel `pnpm test` had one timing-sensitive typing-indicator failure (850/851); the isolated test passed, then `pnpm exec vitest run --maxWorkers=1` passed **851/851**.
- Typechecks passed: `apps/api` `pnpm typecheck`; `apps/whatsapp` `pnpm typecheck`.
- Lint passed: both packages' `pnpm lint`; API lint reports five existing unused-variable warnings and no errors.
- Real answer smoke test: local auth/API plus `AnsariClientReal` returned one 2,631-character answer in 13.69 seconds. It used the production API key temporarily because staging had no key; the local `.env` was then restored to its prior active key. This does not count as staging validation.
- The expiry-flow script uses real local auth/API and a real model client with a recording Meta mock. It does **not** make a real Meta request, receive a real webhook, or test zrok.

### Phase 4 verification record (2026-11-27)

- WhatsApp suite: 851/851 passed after the row-title change; ESLint clean on the changed files; `tsc` passed.
- Owner checks: long-answer message lengths, the 3-hour expiry reuse, and the 15,000-character formatting run.
- Conversational commands: one approved write to the production number (A6), and a replace-behaviour experiment on the Test number, which was cleared afterwards.

## Amendments (changes found after the phase plan was written)

These were not in the original phases. Each is recorded here with the phase that found it and the reason.

### A1. Thread history limit applied to the WhatsApp endpoint (found in Phase 2 review, issue #400)

- **What:** `POST /api/v2/chat/complete` now follows the same limit as the thread route. `chat/complete` is `src/app/api/v2/chat/complete/route.ts`.
  - An incoming message over the block threshold on its own is refused: the notice is the answer, nothing is stored, no model call.
  - A warn-level thread gets the warning as its own first item in `messages[]`, and the same warning is stored ahead of the answer. The answer itself is unchanged.
  - A block-level thread gets the notice as its only item, with no model call. The notice is stored as the assistant message.
- **Why:** The source scan `history-limit-coverage` (upstream, issue #400) fails for any route that calls `runFacilitator` without the limit. Without this, a long WhatsApp thread would send unbounded history to the model.
- **Why both notices are stored (decided at the owner's request, for consistency):** The thread route stores its notices so the web, Android and iOS apps show the same transcript on reload. For WhatsApp that is redundant, because no UI of ours reads these threads: WhatsApp users are separate accounts from web users (keyed on the BSUID, with no credential), and Meta's WhatsApp app keeps the chat. We store the notices anyway so both routes behave the same way, and so the behaviour can be reused if a WhatsApp thread is ever shown in our apps.
- **What the stored notices cost:** Replay uses `rawPayload` for every model turn, so a stored warning never reaches the model. A block notice never reaches the model either, because a blocked thread never calls the model again. So the stored notices add no model context.
- **Why the oversized check is here too:** Meta documents the 4,096-character limit for outbound text only. I found no documented maximum for inbound text, so a WhatsApp user could send a message over the block threshold. The check is therefore not redundant for WhatsApp, and it mirrors the thread route, which also refuses that message before storing it.

### A2. Source scans use `/` paths on Windows (found in Phase 2, test infrastructure)

- **What:** `apps/api/tests/source-scan/scan.ts` gained `toPosixPath`, which converts `\` to `/` only when `process.platform === 'win32'`. It is applied in `sourceFiles` and `railwayScanDirs`.
- **Why:** The scans compare repo-relative paths with `/` literals. On Windows, `path.join` returns `\`, so the RAILWAY scan's directory check failed on every Windows machine. The fix changes no behaviour on Linux or macOS. It has been run on Windows only; Linux/macOS is untested from this machine.
- **Also:** `history-limit-coverage.test.ts` lists the new route as a route that applies the limit.
- **Not in the spec:** This is test infrastructure, so it is recorded here only.

### A3. User-configurable expiry with a `/expiry` picker (decided in Phase 3; the spec's Research item 5 left the UX open)

- **What:** A WhatsApp user sends `/expiry` and gets an interactive list with 0, 1, 2, 3, 6, 12 and 24 hours (0 = a new session for every message). The choice is stored and used as `expiryHours` on every later message. Users who never chose get `WHATSAPP_CHAT_RETENTION_HOURS` (default 3).
- **Where it is stored:** the existing `preferences` key/value table (`apps/api/db/schema/preferences.ts`), key `whatsapp.chat_retention_hours`, written through the existing `PUT /api/v2/preferences`. **No schema change and no migration**, so the deploy migration rule does not apply.
- **Why only 7 values:** Meta's interactive list allows at most 10 rows. The spec's 0-24 range cannot be one row per hour, so the picker offers the common values. The API still accepts any value from 0 to 24.
- **Validation:** the generic `PUT /api/v2/preferences` accepts any key and value. The WhatsApp service is therefore the only writer of this key and validates the value (an integer from 0 to 24) before writing and before using it. A stored value that fails validation falls back to the env default.
- **Why `/expiry` and not `/`:** a message that is only `/` is a plausible user message, and a command word is easier to remember.
- **Cost:** each message reads the preference once (one extra `GET /api/v2/preferences`). Acceptable for WhatsApp traffic.

### A4. Formatter and splitter removed from the WhatsApp service (decided in Phase 3)

- **What:** `apps/whatsapp/src/formatting/` is deleted. The WhatsApp service sends the strings of `messages[]` as the API returns them.
- **Why:** The API's WhatsApp prompt asks Gemini to return formatted `messages[]`. Running the old formatter over that output again could change it (for example, `*bold*` is rewritten). Keeping both would double the work and hide which side is responsible. The API does not deterministically split or enforce the per-message character limit; that remains a validation risk.
- **Risk:** if the model ever returns a message over Meta's 4,096-character limit, the send will fail. The Phase 3 real check (3.5) looks at the message lengths. The API prompt and tests are the first line of defence.
- **Known consequence:** the thread title (`pythonSplitWords`) moved with the thread lifecycle, so `utils/pythonText.ts` goes too.

### A5. Divider lines are discouraged by the WhatsApp prompt only (found in the owner's 15,000-character WhatsApp test, 2026-11-27)

- **What:** The owner's test showed `---` divider lines in a returned message, and WhatsApp shows them as literal dashes. The fix is a prompt rule in `apps/api/lib/ai/prompts/facilitator-whatsapp.ts` that forbids horizontal rules and divider lines. The API does not rewrite the model's messages.
- **Why no code cleanup:** A post-processing step was tried and then removed, because the prompt rule is considered sufficient. Nothing in the API now removes dividers.
- **Not re-verified:** the owner decided not to re-run the 15,000-character test after the prompt change, so the rule has not been checked against a real model answer since it was added.

### A6. `/expiry` command must be configured on each business phone number (found 2026-11-27, manual setup)

- **What:** WhatsApp's `/` popup shows commands configured on a business phone number through Meta's Conversational Automation API, or in WhatsApp Manager (Automations → Conversational Components). No code in this repo calls it, so deploying does not set it.
- **Scope:** per phone number. Staging and production share the production number, so one setup covers both. The Test-app number has its own setup.
- **How:** `POST /{Version}/{Phone-Number-ID}/conversational_automation` with `{"commands":[{"command_name":"expiry","command_description":"Choose how long sessions are kept"}]}`. Reference: [Conversational Automation API](https://developers.facebook.com/documentation/business-messaging/whatsapp/reference/whatsapp-business-account/conversational-automation-api). UI steps and limits: [Conversational Components](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-phone-numbers/conversational-components).
- **Limits (Meta):** up to 30 commands; name up to 32 characters, without the leading slash; description up to 256 characters; no emojis.
- **Findings (2026-11-27):**
  - Each POST replaces the whole list: after posting `beta` following `alpha` on the Test number, only `beta` remained.
  - Read back with `GET /{Phone-Number-ID}?fields=conversational_automation`.
  - The permission error (subcode 1349174) did not occur.
  - A POST sent through Windows PowerShell 5.1 `curl.exe -d` returned `success: true` but stored nothing, because PowerShell strips the JSON double quotes. Send the body with `Invoke-RestMethod`, and read it back.
- **Done:** the production number lists `expiry` (read back 2026-11-27, display number `+1 650-656-3971`); the Test number's list was cleared.
- **Where it shows:** the owner confirmed on 2026-11-27 that the production number's Automations page (Conversational Components) lists `expiry`. WhatsApp Manager's phone-number list does not show commands, so do not use it to check.
- **Still open:** the `/` popup did not appear in the existing chat with the production number on 2026-11-27. The owner chose to wait for the change to propagate, or to try a new chat, rather than delete the existing one. Candidates: the chat thread was opened before the command was set, or the client has not refreshed. The command was written with the system-user token of the "Ansari - Test" app (the only token in `meta.env` that can write it), and the API reads it back. App tokens cannot read the field.
- **Routing note:** a plain `/expiry` (no `!d`/`!s`) is answered by production only. Staging and development need `!s` or `!d` typed before the command, because the popup inserts the command text on its own.

### PR body notes (design choices to carry into the PR description)

- WhatsApp users are separate accounts from web users: they are keyed on the BSUID and have no credential. A WhatsApp thread therefore never appears in a web or mobile sidebar. The two flows share code and tables, not user data.
- The history limit (A1) is applied on the WhatsApp endpoint because the upstream source scan requires it.
- Both notices are stored for consistency with the thread route, even though no UI reads WhatsApp threads (A1 explains the reasoning and cost).
- The oversized-message refusal is kept because Meta documents a limit only for outbound text.
- The Windows-safe source-scan paths (A2) are test infrastructure, unrelated to WhatsApp.

### Follow-up after the PR is accepted (separate scope)

- Deploy to staging, and run smoke tests there (moved from Phase 5.2).
- Test the deployed service with real Meta webhooks on the staging number.
- Deploy to production, monitor for issues, then check the error-rate and feedback metrics.
- Configure the `/expiry` command on any other business phone number (A6).

### Other follow-ups

- **Publish the persistence comparison issue after this work's PR merges.** The unpublished draft is at `tmp/issue-360-persistence-comparison.md`; it compares saving the assistant answer after validation with waiting for WhatsApp send acknowledgment. This is a reminder only; do not publish before the PR merges.
- **Backfill old WhatsApp messages.** Until Phase 3 ships, the WhatsApp service writes its messages through the generic thread route, which labels them `source: 'web'`. Once every phase is done, run a SQL update on staging and prod to set `source = 'whatsapp'` on messages whose thread has `source = 'whatsapp'` and whose `source` is `web`. Run it as a read-only count first, then the update. No rush.