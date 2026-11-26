# bugfix-444 thread

Issue #444: retry an empty final answer when Gemini reports `MALFORMED_RESPONSE`.

## 2026-11-25 — start

- The branch was cut from a stale local develop (8b090c91), 225 commits behind
  origin/develop. On the architect's instruction, merged origin/develop (540acc85) into the
  branch before any work (merge, no rebase). `git merge-base --is-ancestor origin/develop HEAD`
  succeeds.
- The issue has no owner comments beyond the body.

## Investigate

- Reproduced with scripted `streamGemini` rounds through the real `runFacilitator` loop. An
  empty final with `finishReason: 'MALFORMED_RESPONSE'` makes one Gemini call and yields the
  "empty answer" error; no retry. Six new tests across three files failed without the fix
  (each "expected length 2/3, got 1/2" on the call count), 56 existing tests passed.
- Root cause: `apps/api/lib/facilitator/agent.ts:97`, `RETRYABLE_EMPTY_FINISH_REASONS` holds
  `STOP` and `MALFORMED_FUNCTION_CALL` only. The gate at line 827 sends every other reason
  to the failing branch.
- `MALFORMED_RESPONSE` and `MALFORMED_FUNCTION_CALL` are named in two files only:
  `agent.ts` and `tests/facilitator-empty-final.test.ts`. No doc (arch.md, lessons, README)
  lists the retryable reasons, so there is no second place to correct.
- Scope: a one-word change to the set, two comment blocks, and tests. Well inside BUGFIX.

## Fix

- `MALFORMED_RESPONSE` added to `RETRYABLE_EMPTY_FINISH_REASONS`; the two comment blocks
  that list the retryable reasons updated (the one above `MAX_EMPTY_FINAL_RETRIES` and the
  one at the degenerate-final branch). No other behaviour touched; `SAFETY` and
  `MAX_TOKENS` still fail at once.
- Tests, six new: the staging shape (tool round, then an empty `MALFORMED_RESPONSE`) is
  retried and the retry's answer returned; a repeat fails after one same-model retry when
  Inkling is unconfigured; with Inkling configured a repeat escalates to Inkling exactly as
  `STOP` does, and three empties stop at two retries; a pinned request retries once on its
  own model and never reaches Inkling.
- Mutation check: with the one set entry removed, 6 failed / 56 passed; restored, 62 passed.
- One of my own assertions was wrong at first: the "retrying" telemetry carries the retry
  count taken before the increment (0, not 1). The test now asserts the counters staging
  logged (`toolCallCount: 1`, `iterations: 2`, `emptyFinalRetries: 0`).

## PR

- PR #445 opened against develop. Porch checks before it: build passed, full test check
  (api, auth, eval, frontend) passed.
- The first Gemini and Codex consults, started seconds after the PR was created, printed
  "No PR found for branch: builder/bugfix-444" and exited 0 with no review. Re-run a minute
  later, both found the PR. A consult that exits 0 has not necessarily reviewed anything:
  read the output for a VERDICT line.
- CMAP: Gemini APPROVE, no issues.
- CMAP: Codex REQUEST_CHANGES, on one point only: the three `chore(porch)` commits and
  the merge of origin/develop lack the `[Bugfix #444]` prefix. It found no code, test,
  scope or security issue. Not acted on: porch writes the chore commits itself, the merge
  was the architect's instruction, and renaming any of them means rewriting pushed history,
  which the architect ruled out (no rebase, no force-push).
- CMAP: Claude APPROVE, no blocking issue. Acted on two of its notes in a follow-up commit:
  (1) nothing pinned that an unlisted or missing finish reason still fails at once, so a
  later widening to "retry anything" would pass every test — added a parameterised test
  (`OTHER`, and no reason → `MISSING`); with the gate mutated to a SAFETY/MAX_TOKENS
  denylist both rows fail, restored they pass; (2) an orphan short line my docblock reflow
  left in `facilitator-empty-final.test.ts`.
- Left for the architect, not decided here: Claude's point that an allowlist will meet this
  again each time the API sends a new transient reason the SDK enum lacks. A denylist
  (retry once unless SAFETY / MAX_TOKENS / RECITATION / …) would close the class but risks
  retrying a blocked reason nobody listed. The issue prescribed the allowlist, so the PR
  keeps it.
- Follow-up was tests and a comment only, so CMAP was not re-run.
