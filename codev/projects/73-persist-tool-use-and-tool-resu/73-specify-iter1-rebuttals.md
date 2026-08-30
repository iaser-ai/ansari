# Spec 73 — Iteration 1 Rebuttal

Verdicts: gemini APPROVE, claude REQUEST_CHANGES, codex REQUEST_CHANGES.
All REQUEST_CHANGES points were verified against the code and accepted — each
one identified a real gap. The spec was revised in place; no point is
contested.

## Claude #1 / Codex #1 — error-path data loss contradicts "exactly computable"

**Accepted, resolved by scoping the claim honestly (not by extending capture).**
Verified: empty-final turns skip `createMessage`, mcp-complete 502s before
persisting, failed synthesis yields `error` — those turns persist no assistant
row, and they are plausibly failure-correlated.

Changes:
- Desired State now says "exactly computable **over persisted assistant
  turns**" and carries an explicit "Known, accepted denominator limitation"
  paragraph explaining which paths are lost, why (no assistant row exists to
  attach records to), and why extending capture is out of scope (rows would
  need to be invisible to thread GET and history replay — a contract-adjacent
  design of its own; the issue's acceptance wording is "populated for
  assistant turns").
- Open Questions adds "error-path capture" as an explicit, non-blocking
  architect decision / follow-on.
- Test Scenario 9 now states it intentionally freezes this documented
  limitation.
- New risk row: "degradation rate read as exact when error-path turns are
  uncounted" with the floor-semantics mitigation.

Rationale for scoping rather than capturing: the alternative persists message
rows for turns the product treats as failed, which every serializing and
replay surface must then filter — a larger contract-adjacent change than this
regression fix warrants, and one the architect can commission separately with
the limitation now stated in writing.

## Claude #2 — Assumptions contradicted Success Criterion 3 (ids for skipped/refused calls)

**Accepted, fixed.** Verified: tool-limit refusals return at
`agent.ts:176-190` before the tracker push at `:195-197`; T1/T2-skipped calls
never reach `processToolCall`. The Assumptions section no longer claims
`callsWithArgs` covers everything; it now states ids must be minted **at the
loop level** and cites both bypass paths. Success Criterion 2 says the same.

## Claude #3 / Codex #2 — status taxonomy promoted to a success criterion; result payload made definitive

**Accepted, fixed.** New success criterion: every tool_result record carries a
status field with a fixed category set — success, degraded, budget-skipped,
limit-refused, unknown-tool — and the spec now states `isDegraded` is read off
`ToolResult` (the model-facing `{results, summary}` payload does not carry
it). The full-`formatToolResultForGemini`-output decision moved from Open
Questions into Constraints as definitive. Test Scenario 5 now proves the flag
is sourced from `ToolResult`, not the payload.

## Claude #4 / Codex #3 — duration semantics

**Accepted, fixed.** Assumptions and Success Criterion 2 now state duration is
new instrumentation (no timing exists in the loop today), unit is
milliseconds, and it is `NULL` for skipped/limit-refused calls, which never
executed.

## Codex #4 — SSE route integration test missing

**Accepted, fixed.** Test Scenario 8 now names all three persist sites
explicitly, including `/threads/[id]/chat`.

## Claude minor — share snapshot surface + onMessage reality

**Accepted, fixed.** Constraints and Test Scenario 1 now cover
`createThreadSnapshot` (`lib/db/shares.ts:36-44`) as a second serializing
surface with its own leak assertion. Assumptions note `onMessage` has no
production callers, so conveyance rides on the `done` event in practice.
