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

## 2026-08-29 — Review phase

dev-approval approved (Waleed independently verified, incl. live Vertex replay checks).
PR #71 opened against develop (review file as body). Governance updates routed: new
arch.md section "Gemini facilitator & message history" + hot fact (Vertex parity
contract, arch-critical now at 10-fact cap) + hot lesson (confirm the deployed revision
before diagnosing prod) + cold lessons section "Gemini history fidelity (issue #70)".

3-way consultation: gemini APPROVE, codex + claude REQUEST_CHANGES. Claude's blocking
finding was REAL and I'm glad it ran: I was persisting `rawPayload`, which is
last-chunk-wins (#83) — a multi-chunk final answer would have persisted only its final
text delta and turn 2+ would replay a fragment (worse than the text-only fallback).
Fixed in 2e5152d: `GeminiResponse.allParts` = complete arrival-ordered turn is now the
persistence source; thought parts filtered (reasoning never stored); empty→null;
in-request rawPayload semantics untouched (identity tests still pass). Also added the
continueWithToolResult repetition regression (codex) and corrected the new-test count
(15). Tripwire fires-on-mismatch test rebutted as structurally unreachable post-fix —
documented in review + rebuttals file. Suite 638 green.

At pr gate. Note for cleanup: worktree-local `.codev/config.json` shadows the shared
symlink (stale pre-monorepo checks; shared file must NOT change — 10 other worktrees
still use backend/+npm).
