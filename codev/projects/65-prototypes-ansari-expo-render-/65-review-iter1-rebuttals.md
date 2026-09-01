# PIR #65 — Review rebuttals (iteration 1)

Verdicts: **Gemini APPROVE**, **Codex COMMENT**, **Claude REQUEST_CHANGES**.
Both actionable points were valid and are **fixed** in commit `0beebf5` (pushed to PR #108).
`pnpm typecheck` clean; `pnpm test` 95 passed (was 93; +2 trace tests).

## Claude — REQUEST_CHANGES (blocking, doc-only): stale docstring in `streaming.ts`

**Point.** `lib/api/streaming.ts` still carried #63's buffer-until-done "PROTOTYPE LIMITATION"
docstring (L19 `onEvent` "for a future live-render follow-up", L28–32 "the UI shows a spinner… must
not copy the spinner-until-done behaviour", L86 "given buffer-until-done"), directly contradicting
the rewritten README — which explicitly names this file as the progress seam — and violating the
plan's "no other paragraph still calls the buffering a limitation (fix the doc defect everywhere)"
plus the repo's own hot-tier lesson about partial doc fixes.

**Agree — fixed.** This was a real miss: I fixed the README but not the module it points at. Rewrote
all three spots to describe the incremental behaviour: the `onEvent` doc now says it is the progress
seam fired per event as it arrives; the function docstring says every event is delivered to `onEvent`
as it arrives and the promise resolves on `done` only for the return contract (the UI no longer waits
on it); the no-body fallback comment now says that path alone fires events in one burst while the
happy path renders as tokens arrive.

## Codex — COMMENT (non-blocking): `traceReducer` matched earliest-pending regardless of tool

**Point.** `traceReducer` completed the earliest pending entry rather than the earliest pending entry
for `event.tool`; current backend ordering masks it, but matching by tool + an out-of-order test
would align with the plan (which said "complete the earliest pending entry of that tool"). Claude
raised no separate issue here.

**Agree — fixed.** Changed `traceReducer` to complete the earliest pending entry whose tool matches
`displayTool(event.tool)`, with a fallback to the earliest pending entry of any tool so a call/result
name mismatch can't strand a spinner, else append. Added two tests: parallel calls resolving
out-of-order land on the right line; a name mismatch falls back rather than stranding. This matches
the approved plan and removes a latent mis-association if the facilitator ever resolves parallel tool
calls out of order.

## Claude — non-blocking notes (captured, not code changes)

1. **Budget-skipped tool reads as "no results".** When the facilitator hits its time budget it emits
   `tool_result` with a hardcoded `resultCount: 0` (`agent.ts:921`), so the trace reads "no hadith
   found" for a search that was skipped, not one that found nothing. The backend sends no skip signal,
   so the client cannot distinguish the two — documented as a known cosmetic limitation of the
   transient trace in the review's "Things to Look At". Out of scope for a client-only change.
2. **Per-delta markdown re-parse.** Each `text` frame re-parses the whole answer (memoized per content
   string). Fine for chunk-sized frames; added a "watch for jank on a long answer on a physical iOS
   device" item to the manual checklist.
3. **`sentAtCount` fallback (`… ?? 0`).** Narrow, self-correcting on the next data tick, and
   prototype-acceptable per Claude's own read — noted in "Things to Look At", not changed.

## Gemini — APPROVE

No action required. Confirmed plan adherence, comprehensive tests, zero scope creep.

## Net

Both actionable items (one blocking doc fix, one plan-alignment refactor) are resolved; the three
non-blocking notes are documented for the reviewer. No point was rejected.
