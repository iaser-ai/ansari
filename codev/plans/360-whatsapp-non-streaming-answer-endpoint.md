# Implementation Plan: Non-streaming answer endpoint for WhatsApp

<!--
PLAN vs SPEC BOUNDARY:
This plan defines HOW and WHEN. The spec defines WHAT and WHY.
-->

## Overview

This plan implements the non-streaming answer endpoint for WhatsApp as specified in `codev/specs/360-whatsapp-non-streaming-answer-endpoint.md`.

**Goal**: Create `POST /api/v2/chat/complete` that returns a complete, WhatsApp-formatted answer as a list of pre-split messages.

## Architecture

```
WhatsApp Service (apps/whatsapp)
    ↓ HTTP POST with JWT
API Endpoint (apps/api/src/app/api/v2/chat/complete/route.ts)
    ↓
Thread Manager (find/create based on expiry)
    ↓
Facilitator (runFacilitator with WhatsApp formatting)
    ↓
Response Formatter (split into 4096-char chunks)
    ↓
JSON Response { messages: string[] }
```

## Phase 1: Research & Design (1-2 days)

### 1.1 WhatsApp Message Components Analysis
- [ ] Inspect current streaming response components (text, citations, footnotes, Quran/Hadith references)
- [ ] Document how each component should be formatted for WhatsApp
- [ ] Create mapping: web format → WhatsApp format

### 1.2 LLM Output Format Research
- [ ] Research various methods to get WhatsApp-formatted text from Gemini (function calling, response schema, prompt engineering, etc.)
- [ ] Evaluate whether structured output is worth the complexity vs. simple prompt instructions
- [ ] Test different approaches with various prompts
- [ ] Choose approach based on: reliability, simplicity, maintainability

### 1.3 Smart Text Splitting Research
- [ ] Evaluate various libraries and approaches (prioritize simpler solutions with fewer dependencies)
- [ ] Consider: `llm-chunk`, `llm-splitter`, custom regex/split logic, or no library at all
- [ ] Choose approach based on: ease of use, bundle size, TypeScript support, dependency count
- [ ] Write test cases for edge cases (long paragraphs, code blocks, lists)

### 1.4 Thread Lifecycle Design
- [ ] Design shared helper for thread find/create/delete
- [ ] Plan how to handle concurrent messages (race conditions)
- [ ] Design user preference storage (for future user-configurable expiry)

## Phase 2: API Endpoint Implementation (3-4 days)

### 2.1 Create Endpoint Skeleton
- [ ] Create `apps/api/src/app/api/v2/chat/complete/route.ts`
- [ ] Add request validation (Zod schema)
- [ ] Add authentication (requireUser)
- [ ] Add error handling

### 2.2 Thread Management
- [ ] Implement thread find/create logic (shared with streaming endpoint)
- [ ] Add expiry check (user-configurable, default 3 hours)
- [ ] Add thread deletion for expired threads
- [ ] Add tests for thread lifecycle

### 2.3 Facilitator Integration
- [ ] Integrate with existing facilitator (`runFacilitator`)
- [ ] Add WhatsApp-specific formatting instructions
- [ ] Implement structured output (function calling)
- [ ] Add tests for facilitator integration

### 2.4 Response Formatting
- [ ] Implement smart text splitting (using chosen library)
- [ ] Add WhatsApp formatting conversion (if needed)
- [ ] Add tests for text splitting
- [ ] Add tests for formatting conversion

### 2.5 Error Handling
- [ ] Implement error responses (HTTP status codes + JSON)
- [ ] Add Sentry integration
- [ ] Add tests for error scenarios

## Phase 3: WhatsApp Service Updates (2-3 days)

### 3.1 Update AnsariClient
- [ ] Add `processMessageComplete()` method to `AnsariClientReal`
- [ ] Implement HTTP call to new endpoint
- [ ] Add error handling
- [ ] Add tests

### 3.2 Update ConversationManager
- [ ] Replace streaming call with non-streaming call
- [ ] Remove thread lifecycle logic (moved to API layer)
- [ ] Update message sending logic (loop over messages array)
- [ ] Add tests

### 3.3 Remove Old Formatting/Splitting
- [ ] Remove `whatsappMessageFormatter.ts` (moved to API layer)
- [ ] Remove `messageSplitter.ts` (moved to API layer)
- [ ] Update imports
- [ ] Add tests

## Phase 4: Testing & Validation (2-3 days)

### 4.1 Unit Tests
- [ ] Test endpoint with various inputs
- [ ] Test thread lifecycle (create, reuse, expire)
- [ ] Test text splitting (various lengths, formats)
- [ ] Test error scenarios

### 4.2 Integration Tests
- [ ] Test WhatsApp service → API endpoint flow
- [ ] Test with real Meta webhooks (staging)
- [ ] Test with long answers (10k+ chars)
- [ ] Test with various content types (Quran, Hadith, code, lists)

### 4.3 Manual Testing
- [ ] Test on WhatsApp (staging number)
- [ ] Test with different message types
- [ ] Test with concurrent messages
- [ ] Test with expired JWT

## Phase 5: Documentation & Deployment (1-2 days)

### 5.1 Documentation
- [ ] Update API documentation
- [ ] Update WhatsApp service documentation
- [ ] Add comments to code
- [ ] Update spec with implementation notes

### 5.2 Deployment
- [ ] Deploy to staging
- [ ] Run smoke tests
- [ ] Deploy to production
- [ ] Monitor for issues

## Technical Decisions

### Text Splitting Library
**Choice**: TBD (will be determined in Phase 1.3 research)

**Criteria**:
- Prioritize simpler solutions with fewer dependencies
- Ease of use and TypeScript support
- Bundle size
- Ability to handle edge cases (long paragraphs, code blocks, lists)

### LLM Output Format
**Choice**: TBD (will be determined in Phase 1.2 research)

**Criteria**:
- Reliability in getting WhatsApp-formatted text
- Simplicity and maintainability
- Whether structured output is worth the complexity vs. simple prompt instructions

### Thread Management
**Choice**: Shared helper used by both streaming and non-streaming endpoints

**Reasoning**:
- Avoid code duplication
- Consistent behavior
- Easier to maintain

## Dependencies

- TBD (will be determined in Phase 1 research)
- Existing: `zod` (for validation)
- Existing: `@sentry/nextjs` (for error tracking)

## Risks & Mitigation

| Risk | Mitigation |
|------|------------|
| LLM doesn't follow WhatsApp format | Test with various prompts; fallback to plain text |
| Text splitting breaks content | Test edge cases; use smart splitting library |
| Thread race conditions | Use DB transactions; test concurrent messages |
| Performance issues | Monitor latency; optimize if needed |

## Timeline

- **Week 1**: Phase 1 (Research & Design)
- **Week 2**: Phase 2 (API Endpoint Implementation)
- **Week 3**: Phase 3 (WhatsApp Service Updates) + Phase 4 (Testing)
- **Week 4**: Phase 4 (Testing) + Phase 5 (Documentation & Deployment)

## Success Metrics

- [ ] Endpoint returns complete answer in < 5 seconds (for typical answers)
- [ ] Text splitting preserves words and sentences
- [ ] WhatsApp formatting renders correctly on device
- [ ] No increase in error rate
- [ ] Positive user feedback

## References

- Spec: `codev/specs/360-whatsapp-non-streaming-answer-endpoint.md`
- Issue: https://github.com/iaser-ai/ansari/issues/360
- Current streaming endpoint: `apps/api/src/app/api/v2/threads/[id]/chat/route.ts`
- WhatsApp service: `apps/whatsapp/src/services/ansariClient.ts`
- Facilitator: `apps/api/lib/facilitator/agent.ts`

---

## Testing Methodology (IMPORTANT — applies to EVERY phase)

**Established in Phase 2. Carry this forward to Phases 3, 4, 5.**

### The rule
Every phase ends with **BOTH**:
1. **Mocked unit/integration tests** (`tests/*.test.ts`, vitest) — free, deterministic, run in CI. These validate *our* logic (auth, validation, thread mgmt, error handling, response parsing).
2. **A real end-to-end script** (`scripts/*.ts`, run with `npx tsx`) — costs real API usage (Gemini, Kalemat, Usul) but validates the *actual* behavior of the AI and external tools. This is the only way to know Gemini really returns WhatsApp-formatted output, that tools really respond, etc.

### Why both (what we learned in Phase 2)
- Mocked tests **cannot** catch: Gemini wrapping JSON in ```` ```json ```` code fences, tools being degraded (Kalemat `invalid_body`, Usul 502), or whether the WhatsApp prompt actually produces `*bold*`/`_italic_`/Arabic formatting. All of these only surfaced in the real script run.
- The codebase convention confirms this split: `gemini.test.ts` explicitly mocks the SDK ("we can't make real API calls in tests"); `auth.integration.test.ts` uses real pglite (not mocks) for DB behavior; real external calls live in `scripts/` (e.g. `bench-documents.bench.ts`). Our `scripts/test-whatsapp-endpoint.ts` follows this exact pattern.

### The real-test script pattern (reuse for later phases)
`scripts/test-whatsapp-endpoint.ts` does the full real path:
1. Sign up a throwaway user at `AUTH_URL/api/auth/sign-up/email` (needs `Origin` header = `http://localhost:3000`).
2. Exchange the session token for a JWT at `AUTH_URL/api/auth/token` (GET, `Authorization: Bearer <sessionToken>`, `Origin` header).
3. POST to the endpoint under test with `Authorization: Bearer <jwt>`.
4. Print the raw response and parsed messages.

**These real-test scripts are THROWAWAY validation aids, NOT committed artifacts.** They exist only so the human can watch real output once and confirm the phase works. Do NOT commit them and do NOT wire them into CI — a real API call on every CI run costs money and is non-deterministic. Delete the script (or keep it untracked/`.gitignore`d) once its output has been reviewed. The committed, CI-safe signal is the mocked vitest suite; the script is the one-time human eyeball check on top of it.

**Prerequisites**: `apps/api` dev server running (`pnpm dev`, port 3000) **and** `apps/auth` dev server running (`pnpm dev`, port 3100), each with its `.env` copied from the main checkout (`apps/api/.env`, `apps/auth/.env`). The API verifies JWTs via the auth service's JWKS, so auth MUST be up or every request 401s.

### Checklist for each remaining phase
- [ ] Mocked tests written and passing (`pnpm test <file>`) — these get committed
- [ ] Real end-to-end script written/updated in `scripts/` (throwaway, NOT committed)
- [ ] Script run against live dev servers; raw AI output inspected (not just "it returned 200")
- [ ] Findings (tool degradation, formatting quirks, latency) recorded in `codev/research/`
- [ ] Real-test script deleted or left untracked once its output is reviewed

## Amendments (changes found after the phase plan was written)

These were not in the original phases. Each is recorded here with the phase that found it and the reason.

### A1. Thread history limit applied to the WhatsApp endpoint (found in Phase 2 review, issue #400)

- **What:** `POST /api/v2/chat/complete` now follows the same limit as the thread route. `chat/complete` is `src/app/api/v2/chat/complete/route.ts`.
  - An incoming message over the block threshold on its own is refused: the notice is the answer, nothing is stored, no model call.
  - A warn-level thread gets the warning as its own first item in `messages[]`. The answer itself is unchanged.
  - A block-level thread gets the notice as its only item, with no model call. The notice is stored as the assistant message, mirroring the thread route.
- **Why:** The source scan `history-limit-coverage` (upstream, issue #400) fails for any route that calls `runFacilitator` without the limit. Without this, a long WhatsApp thread would send unbounded history to the model.
- **Why the warning is not stored:** The thread route stores its warning because the web, Android and iOS apps are responsible for their own chat UI. They re-read the thread from our API after a reply, so an unstored warning would vanish on refresh. WhatsApp is different: Meta's WhatsApp app is responsible for the final chat UI and keeps the messages it received. Our endpoint is only asked for the answer, so storing the warning gains nothing and would add a little context to every later turn.
- **Why the oversized check is here too:** Meta documents the 4,096-character limit for outbound text only. The inbound text body has no documented maximum, so a WhatsApp user could send a message over the block threshold. The check is therefore not redundant for WhatsApp.
- **Open follow-up:** The block notice is stored, which by the same reasoning does not need to be. It is kept for parity with the thread route; revisit it in the PR review.

### A2. Source scans use `/` paths on Windows (found in Phase 2, test infrastructure)

- **What:** `apps/api/tests/source-scan/scan.ts` gained `toPosixPath`, which converts `\` to `/` only when `process.platform === 'win32'`. It is applied in `sourceFiles` and `railwayScanDirs`.
- **Why:** The scans compare repo-relative paths with `/` literals. On Windows, `path.join` returns `\`, so the RAILWAY scan's directory check failed on every Windows machine. The fix changes no behaviour on Linux or macOS. It has been run on Windows only; Linux/macOS is untested from this machine.
- **Also:** `history-limit-coverage.test.ts` lists the new route as a route that applies the limit.
- **Not in the spec:** This is test infrastructure, so it is recorded here only.

### Follow-up after all phases (not in scope here)

- **Backfill old WhatsApp messages.** Until Phase 3 ships, the WhatsApp service writes its messages through the generic thread route, which labels them `source: 'web'`. Once every phase is done, run a SQL update on staging and prod to set `source = 'whatsapp'` on messages whose thread has `source = 'whatsapp'` and whose `source` is `web`. Run it as a read-only count first, then the update. No rush.