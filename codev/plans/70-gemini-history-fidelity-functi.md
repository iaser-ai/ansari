# PIR Plan: Gemini history fidelity — functionCall/toolCalls desync + rawPayload persistence

Issue #70. Two related defects in how a Gemini model turn is captured and replayed.

## Understanding

**Bug 1 — desync → Vertex 400.** In `apps/api/lib/ai/gemini-client.ts:535-570` the
repetition guard (#51) `break`s out of the *parts* loop the moment the degenerate-tail
check trips. Any part after that point in the same chunk — including `functionCall`
parts — is skipped: it never reaches `allParts` and never reaches `toolCalls`. But
`finalContent = candidate.content` (`gemini-client.ts:572`) runs *after* the inner break
and stores the whole chunk verbatim. `streamRawPayload` (`gemini-client.ts:750-758`) then
sees `allCallCount <= finalCallCount` and returns `finalContent` unchanged — orphan
`functionCall` parts included. The facilitator builds one `functionResponse` per
*collected* tool call (`agent.ts:698-757`), so the replayed turn has more `functionCall`
parts than `functionResponse` parts, and Vertex rejects the next call of the same request
with the exact production 400 message.

**Correction (issue comment, 2026-08-29): this is a LATENT defect, not the production
fire.** Production runs `main`, whose pre-#14 `agent.ts` pushes one single-part Content
per tool call — every parallel tool call there is malformed by construction, which
accounts for all the Sentry symptoms. `develop` already fixed that (#14's `responseParts`
batching) but is unpromoted. The repetitionCut desync is present in both branches
(`gemini-client.ts` is byte-identical), merely masked on `main` by the larger bug. So:
fix it and instrument it, but the production 400 rate is NOT the success metric — it
drops when develop is promoted. Success for Bug 1 = the desync instrumentation staying
silent.

**Bug 2 — rawPayload never persisted.** The whole rawPayload persistence design is a
dangling wire. `agent.ts:658` passes `rawPayload` to `onMessage` — but no production
caller passes an `onMessage`. The two stateful SSE routes
(`src/app/api/v2/threads/[id]/route.ts:220-260` and
`src/app/api/v2/threads/[id]/chat/route.ts:103-153`) persist the aggregated streamed text
themselves when the `done` event arrives, and `done` carries only `usage` — `rawPayload`
never reaches `createMessage`. There is no `raw_payload` column in
`db/schema/messages.ts` or any migration. And when history is loaded back
(`route.ts:163-167`, `chat/route.ts:65-69`), the mapping to `Message[]` omits
`rawPayload` anyway. So `convertToGeminiHistory` (`agent.ts:252-292`) always takes the
text-only fallback on turn 2+: all tool calls and every `thoughtSignature` are lost.

The other two facilitator callers don't need this: `v2/mcp-complete` creates a fresh
one-shot thread per request and never re-reads it; `v1/chat/completions` is stateless
(history arrives in the request body).

**Impact scale** (measured over the last 60 days of human traffic, per Waleed):
65.9% of all questions are follow-ups (51,825 of 78,691) and 52% of threads are
multi-turn — so the rawPayload gap degrades roughly two-thirds of questions, not an
edge case.

**Interaction between the bugs (important):** today Bug 2 *masks* Bug 1 across turns —
text-only history has zero `functionCall` parts, so nothing can mismatch on turn 2+. Once
rawPayload is persisted, a desynced payload with an orphan `functionCall` would be
replayed on *every* subsequent turn of that thread — a permanently poisoned thread, not a
one-request rescue. So Bug 1's fix must land with Bug 2's, and persistence needs a
consistency guard (below).

## Proposed Change

### Bug 1

1. **Fix the `break`** (`gemini-client.ts:544-549`): stop *emitting/accumulating text*
   on repetition rather than abandoning part processing. Concretely: remove the inner
   `break`; guard the text-part branch with `!repetitionCut` so no further text is
   appended to `fullText` or emitted once the cut fires; keep processing every part of
   the chunk (`allParts`, thought flags, and `functionCall` → `toolCalls` +
   `tool_call` event). The existing outer `if (repetitionCut) break;`
   (`gemini-client.ts:589`) still stops pulling further chunks. Result: `toolCalls`
   stays in sync with the `functionCall` parts of whatever lands in `finalContent`.

2. **Instrument the merge** (issue ask #1): in `attempt()` where the response is built
   (`gemini-client.ts:611-619`), compute the `functionCall` count of the returned
   `rawPayload`. If it differs from `toolCalls.length`, `console.warn` +
   `Sentry.captureMessage` (warning) with `{ label, toolCallCount, payloadCallCount,
   repetitionCut }` — counts only, no content, no PII. Post-fix this should never fire;
   any production hit = a second desync path exists and is now visible. Also add
   `payloadCallCount` to the existing repetition-cut warn summary
   (`gemini-client.ts:594`) so one day of data shows how often the guard co-occurs with
   function calls at all.

3. **Regression test** (issue ask #3): extend the mocked-SDK suites
   (`tests/gemini-repetition.test.ts` / `tests/gemini-rawpayload.test.ts` pattern) with a
   stream whose repetition-tripping chunk carries `functionCall` parts *after* the
   degenerate text part. Assert `toolCalls.length === functionCall count in
   rawPayload.parts` and that the calls were actually collected and emitted as
   `tool_call` events. Also assert the invariant on the existing repetition-cut and
   multi-chunk scenarios.

### Bug 2

4. **Schema**: add nullable `rawPayload: jsonb('raw_payload')` to
   `db/schema/messages.ts`, typed via a type-only import of `Content` from
   `@google/genai`. Nullable — existing rows and user messages legitimately have none.

5. **Migration**: `pnpm db:generate` → `drizzle/0004_*.sql` (should be exactly
   `ALTER TABLE "messages" ADD COLUMN "raw_payload" jsonb;`). Committed for review;
   human-applied at deploy per `arch-critical.md`. NEVER `db:push`. Deploy order:
   migration first, then deploy (old code ignores the new column, so the migration is
   safe to apply ahead of the code).

   **Production runbook** (architect addition, 2026-08-29): prod `messages` is
   679,634 rows / 326MB heap on PostgreSQL 17.11. A nullable, no-default ADD COLUMN
   is catalog-only — instant — but the ACCESS EXCLUSIVE lock still has to be
   *acquired*, and without a timeout it would queue every other query behind any
   in-flight long transaction. Apply with a fail-fast lock timeout:

   ```sql
   SET lock_timeout = '3s';
   ALTER TABLE "messages" ADD COLUMN "raw_payload" jsonb;
   ```

   If it times out, just re-run once the blocking transaction has finished.

6. **Carry rawPayload on the `done` event**: add optional `rawPayload?: Content | null`
   to `FacilitatorStreamEvent` and set it on both `done` yields (`agent.ts:662` main
   path, `agent.ts:482` synthesis path). Chosen over switching the routes to
   `onMessage` because the routes persist the *aggregate streamed text across all
   iterations* as `content`, while `onMessage` would persist only the final call's text
   — switching would silently change user-visible thread history. With the event field,
   persisted `content` stays byte-identical to today and only gains the new column.
   `FacilitatorStreamEvent` is server-internal; the SSE wire format does not change
   (mobile compat: no API contract change anywhere — the thread GET response does not
   expose `raw_payload`).

   > **Amendment (review iteration 1):** consultation found that `response.rawPayload`
   > is last-chunk-wins (#83) — for a multi-chunk answer it holds only the final text
   > delta, so persisting it would replay a fragment. The persisted payload is instead
   > built from the new `GeminiResponse.allParts` (the complete arrival-ordered turn),
   > with `thought: true` parts filtered out (reasoning is never stored). In-request
   > `rawPayload` semantics are unchanged.

7. **Persist-time consistency guard** (flagged in ask #5's "consider before
   implementing" spirit, and the poisoning hazard above): the `done` event's rawPayload
   is the *final* call's Content — a turn that ended with zero collected tool calls. If
   that Content nevertheless contains `functionCall` parts (a desync some path slipped
   through), attach `rawPayload: null` and `Sentry.captureMessage` (error) with counts
   only. Persisting it would 400 every later turn of the thread forever; degrading that
   one message to today's text-only replay, loudly, is the correct failure mode. This
   guard lives in `agent.ts` where the `done` event is built, so both routes and any
   future `onMessage` caller are covered by the same check.

8. **Persist + read back** in both stateful routes:
   - `createMessage({ ..., rawPayload: event.rawPayload ?? null })` on the `done`
     branch of `threads/[id]/route.ts` and `threads/[id]/chat/route.ts`.
   - History mapping gains `rawPayload: m.rawPayload` in both routes, so
     `convertToGeminiHistory` takes the rawPayload branch on turn 2+.

9. **Tests with a real DB (pglite)** per `lessons-critical.md`:
   - New `tests/rawpayload-persistence.test.ts`: PGlite + drizzle, schema including
     `raw_payload jsonb`. Round-trip an assistant message whose rawPayload carries
     multiple parts with `thoughtSignature` (incl. non-ASCII text) and assert
     deep-equality on read-back via `findMessagesByThread`.
   - Route-level (mocked `runFacilitator`, real PGlite db): POST turn 1 emits `done`
     with a rawPayload → assert the row's `raw_payload`; POST turn 2 → assert the
     `messageHistory` handed to `runFacilitator` carries that rawPayload and that
     `convertToGeminiHistory` output (or the facilitator input) contains the preserved
     parts. Also: guard test — a `done` rawPayload containing a `functionCall` part
     persists NULL and logs.
   - Update the hand-written DDL in `tests/route-persistence-rollback.test.ts` to
     include the new column (its inserts go through the same helpers).

### Scope / retention decisions (issue ask #5)

- **What is stored**: only the final model turn's Content — final answer text (already
  stored in `content` today) plus opaque `thoughtSignature` blobs. NOT stored:
  intermediate tool-call turns and tool results, so tool `args` embedding user query
  text are *not* written to the new column, and payload size stays bounded (single
  turn's parts, typically a few KB of signature + the answer text). This matches the
  existing `Message.rawPayload: Content | null` type and both replay sites
  (`convertToGeminiHistory`, `buildHistoryFromMessages`) — they expect one Content per
  assistant message. Replaying full tool rounds cross-request would also widen the
  strict-signature-validation surface the issue warns about; deliberately out of scope.
- **Known limitation to accept**: on replay the rawPayload branch reconstructs the model
  turn from the final call's parts, so preamble text streamed during earlier tool
  iterations ("Let me search…") is not in the replayed model turn (it stays in the
  user-visible `content`). This is the original design's semantics, not a regression.
- A repetition-cut turn's rawPayload keeps the chunk's text verbatim (including the
  degenerate tail of that one chunk, bounded by chunk size) — signatures trump trimming;
  noted, not changed.

## Files to Change

- `apps/api/lib/ai/gemini-client.ts:535-572` — remove inner `break`; gate text
  accumulation/emission on `!repetitionCut`; desync instrumentation at the response
  build (`:611-619`); extend the repetition-cut log summary (`:594`).
- `apps/api/lib/facilitator/agent.ts` — `FacilitatorStreamEvent` gains
  `rawPayload?: Content | null` (`:238-243`); consistency guard + set it on the `done`
  yields (`:482`, `:662`).
- `apps/api/db/schema/messages.ts` — add `rawPayload` jsonb column (type-only `Content`
  import).
- `apps/api/drizzle/0004_<generated>.sql` + `drizzle/meta/*` — generated migration
  (ALTER TABLE add column only; will be reviewed before commit).
- `apps/api/src/app/api/v2/threads/[id]/route.ts:163-167,247-259` — map `rawPayload`
  into history; persist `event.rawPayload`.
- `apps/api/src/app/api/v2/threads/[id]/chat/route.ts:65-69,140-152` — same.
- `apps/api/tests/gemini-repetition.test.ts` — regression: repetition cut with trailing
  functionCall parts keeps counts equal.
- `apps/api/tests/rawpayload-persistence.test.ts` — new; pglite round-trip + route-level
  persist/read-back + guard.
- `apps/api/tests/route-persistence-rollback.test.ts:86-101` — add `raw_payload jsonb`
  to the hand-written DDL.

## Risks & Alternatives Considered

- **Risk: poisoned threads if any desync path remains.** Mitigated three ways: the
  break fix, the persist-time guard (never store a final-turn payload carrying
  functionCalls), and the Sentry instrumentation that makes any residual path visible
  from one day of production data.
- **Risk: payload growth of the messages table.** Bounded by storing the final turn
  only; nullable column, zero cost for user messages and legacy rows. Flagged rather
  than adding retention machinery now.
- **Risk: replay of old/foreign payload shapes.** Inkling responses also produce a
  Gemini-format `Content` (`inkling-client.ts:425-434`, plain text parts) — replayable
  as-is. Rows written before this change are NULL → text fallback, unchanged behavior.
- **Alternative: routes adopt `onMessage` for persistence.** Rejected: changes the
  persisted `content` from aggregate streamed text to final-call text — a user-visible
  history change and a wire-behavior risk for the frozen mobile contract.
- **Alternative: persist the full tool round (Content[]).** Rejected for this issue:
  type/replay-site redesign, much larger payloads (tool results embed retrieved
  documents), stores tool args containing user query text, and widens the
  thought-signature validation surface on replay. Can be a follow-up if final-turn
  replay proves insufficient.
- **Alternative: also strip degenerate text from a repetition-cut rawPayload.**
  Rejected: touching parts risks detaching signatures; the tail is bounded.

## Test Plan

- **Unit (mocked SDK)**: repetition-cut-with-functionCalls regression asserting
  `toolCalls.length === rawPayload functionCall count` (the issue's ask #3), on both
  `streamGemini` and `continueWithToolResult` paths; desync instrumentation fires on a
  hand-built mismatch and stays silent on matched streams (negative test per
  lessons-critical: prove the check fails when it should).
- **Unit (pglite, real DB)**: jsonb round-trip incl. thoughtSignature + non-ASCII;
  route-level turn-1-persist / turn-2-read-back showing `runFacilitator` receives
  rawPayload; guard persists NULL for a functionCall-bearing final payload.
- **Suite**: `pnpm typecheck && pnpm test` green with `.env.ci` only.
- **Manual (dev-approval gate)**: apply `0004` to the local dev DB (`pnpm db:migrate`
  — local only; prod stays human-applied), run the worktree, ask a question that
  triggers tool calls, then a follow-up in the same thread. Verify: (a) the assistant
  row has `raw_payload` populated (`psql: select raw_payload from messages …`), (b) the
  follow-up turn answers with awareness of the prior search and no Vertex 400, (c) logs
  show no desync warning.
- **Post-deploy measurement** (issue ask #1, per the 2026-08-29 correction): success
  for Bug 1 is the new desync Sentry message staying SILENT (any hit = an unknown
  desync path), plus the extended repetition-cut summary showing how often the guard
  co-occurs with function calls. Do NOT expect the production 400 rate to move — that
  is fixed by the develop→main promotion (#14), not by this change.
