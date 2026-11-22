# Builder Thread - SPIR 360

**Started**: 2026-11-22 15:16:13
**Protocol**: SPIR
**Spec**: 360-whatsapp-non-streaming-answer-endpoint
**Phase**: 1 (Research & Design)

## Progress

### Phase 1: Research & Design (COMPLETED ✅)
- [x] 1.1 Research WhatsApp message components (completed)
  - [x] 1.1.1 Analyze existing WhatsApp formatting code
  - [x] 1.1.2 Research WhatsApp Business API formatting
  - [x] 1.1.3 Analyze tool call results format
  - [x] 1.1.4 Test edge cases
- [x] 1.2 Research LLM structured output (completed)
  - [x] 1.2.1 Test JSON Schema approach
  - [x] 1.2.2 Test Function Calling approach
  - [x] 1.2.3 Test Prompt Engineering approach
  - [x] 1.2.4 Compare approaches
- [x] 1.3 Research smart text splitting (completed)
  - [x] 1.3.1 Test `llm-chunk`
  - [x] 1.3.2 Test LangChain's `RecursiveCharacterTextSplitter`
  - [x] 1.3.3 Test `llm-splitter`
  - [x] 1.3.4 Test Custom Implementation
  - [x] 1.3.5 Compare approaches
- [x] 1.4 Research thread lifecycle (completed)
  - [x] 1.4.1 Analyze current thread logic
  - [x] 1.4.2 Design new thread lifecycle
  - [x] 1.4.3 Plan migration
  - [x] 1.4.4 Test edge cases
- [x] 1.5 Compile design document (completed)

### Phase 2: API Endpoint Implementation (COMPLETED ✅)
- [x] 2.1 Create WhatsApp-specific system prompt
- [x] 2.2 Update facilitator agent to support source parameter
- [x] 2.3 Create new API endpoint `/api/v2/chat/complete`
- [x] 2.4 Implement thread lifecycle management
- [x] 2.5 Code review and fixes
- [x] 2.6 Add tests
- [x] 2.7 Update API documentation

## Notes

**Phase 1 COMPLETED** ✅
All research tasks have been successfully completed. Research documents created in `codev/research/`:
1. **1.1-whatsapp-message-components.md** - WhatsApp formatting, components, edge cases
2. **1.2-llm-structured-output.md** - JSON Schema, function calling, prompt engineering
3. **1.3-smart-text-splitting.md** - Text splitting libraries and custom implementation
4. **1.4-thread-lifecycle.md** - Thread management, expiry, race conditions
5. **1.5-design-document.md** - Comprehensive design recommendations
6. **PHASE1-COMPLETION-SUMMARY.md** - Executive summary for stakeholders

**Phase 2 COMPLETED** ✅
Core API endpoint and supporting infrastructure implemented and TESTED END-TO-END:
- ✅ WhatsApp-specific system prompt created
- ✅ Facilitator agent updated to support source parameter
- ✅ New API endpoint `/api/v2/chat/complete` created
- ✅ Thread lifecycle management implemented (uses existing `updatedAt`, no schema change)
- ✅ Code review and fixes
- ✅ Mocked tests (27 tests, all passing)
- ✅ API documentation updated
- ✅ **Real end-to-end test run against live Gemini** (see below)

**Key Files Created/Modified:**
- `apps/api/lib/ai/prompts/facilitator-whatsapp.ts` (new)
- `apps/api/src/app/api/v2/chat/complete/route.ts` (new)
- `apps/api/scripts/test-whatsapp-endpoint.ts` (new — real E2E test script, **THROWAWAY / do not commit**)
- `apps/api/scripts/generate-test-jwt.ts` (new — JWT helper)
- `apps/api/lib/facilitator/agent.ts` (modified)
- `apps/api/lib/db/threads.ts` (modified)
- `apps/api/README.md` (modified)

**Real E2E test result (Phase 2):**
- Gemini DID return WhatsApp-formatted output (`*bold*`, `_italic_`, `•` bullets, Arabic + translation, `*Sources:*` section).
- Gemini wrapped the JSON in ```` ```json ```` code fences — endpoint now strips fences before `JSON.parse`.
- Tools: `search_quran` (Kalemat) WORKED; `search_hadith` (Kalemat) degraded (`invalid_body`); `search_mawsuah` (Usul) degraded (502). Gemini noted the Hadith outage gracefully in its answer.
- Latency ~40s for a 3-tool turn.

**TESTING METHODOLOGY (applies to all remaining phases):** see the "Testing Methodology" section at the bottom of `codev/plans/360-whatsapp-non-streaming-answer-endpoint.md`. Summary: every phase ends with BOTH mocked vitest tests (committed, CI-safe) AND a real end-to-end script in `scripts/` run against live dev servers (api on :3000 + auth on :3100, each with `.env` copied from main checkout). Mocked tests can't catch AI formatting quirks or tool degradation — only the real script can. **The real-test scripts are THROWAWAY: do NOT commit them, do NOT wire into CI (they cost money per run). Delete or leave untracked once their output is reviewed.**

**Next Steps:**
- Phase 3: Update WhatsApp service to call new endpoint
- Or: manual testing via Meta's "Ansari - Test" app + zrok

