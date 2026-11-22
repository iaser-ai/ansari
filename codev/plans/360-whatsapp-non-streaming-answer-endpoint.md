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