# Builder thread — pir-70 (Issue #70: Gemini history fidelity)

## 2026-08-29 — Plan phase

Investigated both bugs. Key findings beyond the issue text:

- **Bug 1 mechanism confirmed in code** (`apps/api/lib/ai/gemini-client.ts:535-570`): the
  repetition-guard `break` exits the parts loop *before* later parts of the same chunk are
  processed, but `finalContent = candidate.content` (line 572) still runs after the inner
  break and stores the whole chunk. So `functionCall` parts after the break point land in
  `finalContent`/`rawPayload` but never in `toolCalls`. `streamRawPayload` then returns
  `finalContent` (allCallCount <= finalCallCount), keeping the orphan calls. The facilitator
  builds functionResponses only from collected toolCalls → count mismatch → Vertex 400 on
  the next call of the same request.

- **Bug 2**: the SSE routes (`threads/[id]/route.ts`, `threads/[id]/chat/route.ts`) do NOT
  pass `onMessage` to runFacilitator — they persist the aggregated streamed text themselves
  on the `done` event, which carries only `usage`. So `rawPayload` has no path to the DB at
  all, and `findMessagesByThread` → messageHistory mapping omits it too. Chosen design:
  carry `rawPayload` on the `done` FacilitatorStreamEvent (keeps persisted `content`
  byte-identical to today; onMessage path untouched), persist final-turn Content only.

- `mcp-complete` threads are one-shot (fresh thread per request, never re-read) — no
  rawPayload persistence needed there. `v1/chat/completions` is stateless.

- Poisoning hazard: once rawPayload IS persisted, a desynced payload (orphan functionCall)
  would 400 every subsequent turn of the thread forever. Plan includes a persist-time
  consistency guard (final turn with 0 collected tool calls must have 0 functionCall parts;
  else Sentry error + persist null) — this doubles as the instrumentation the issue asks for.

Plan written to codev/plans/70-gemini-history-fidelity-functi.md.

## 2026-08-29 — Implement phase

Plan approved. Two mid-flight architect updates, both incorporated:

1. **Migration runbook**: prod apply must use `SET lock_timeout = '3s';` before the
   ALTER (679K rows; ADD COLUMN is catalog-only but the ACCESS EXCLUSIVE acquisition
   can queue). In the plan's migration step.
2. **DIAGNOSIS CORRECTION** (issue #70 comment): production runs `main`, whose pre-#14
   agent.ts pushes one single-part Content per tool call — THAT is the cause of the
   production 400 spike, already fixed on develop but unpromoted. The repetitionCut
   desync is a real but LATENT defect (gemini-client.ts byte-identical on both
   branches). Success metric for Bug 1 is the desync instrumentation staying silent,
   NOT the production 400 rate. Plan reworded accordingly.

Implementation (commits 7e86836..): repetition-cut break fix + desync tripwire in
gemini-client; guarded rawPayload on the facilitator done event; raw_payload jsonb
column + migration 0004_ancient_mongu.sql (single ALTER, reviewed); both stateful
thread routes persist + replay. Tests: regression (repetition chunk carrying
functionCalls), facilitator guard both directions, pglite round-trip through the real
route. Had to add raw_payload to five test files' hand-written messages DDL.

typecheck ✓, full suite 633 passed / 3 pre-existing skips ✓, build ✓. At dev-approval gate.
