# bugfix-2 thread — Issue #2 correctness batch

Four related correctness bugs in the facilitator/tool pipeline. Batched because they cluster in
adjacent code and share test infrastructure.

## Investigate phase — findings (root causes confirmed by reading)

### Bug 1 — first-call retry loses the user's question from history
`lib/facilitator/agent.ts:661`: `if (iterations === 1)` pushes the user message into
`geminiHistory`. But the degenerate-final retry path does `continue` (line 625), which re-enters
the loop and runs `iterations++` (line 478). So if the FIRST Gemini call is degenerate
(empty/fragment/MALFORMED) and the retry (iterations===2) then requests a tool, line 661's guard
is false and the user's question is never added to history. Every continuation asks the model to
answer a question it never saw.
- **Fix**: guard on `!userMessageInHistory` instead of `iterations === 1` (the flag already exists,
  set right below at line 666, and is already the exact condition `runSynthesis` uses at line 421).
- **Test**: `[emptyRound, toolRound, textRound]`; assert the post-tool continuation call's
  `options.history` contains the user query. Existing tests only cover empty-final AFTER a tool round.

### Bug 2 — tool timeout covers headers, not the body
`lib/tools/resilience.ts` `fetchWithTimeout` clears its abort timer in a `finally` as soon as
`fetch()` resolves (headers). Callers then `await response.json()` OUTSIDE any timeout
(search-quran, search-hadith, usul-client). A provider that returns headers then stalls the body
bypasses the per-tool cap and the facilitator wall-clock guarantee. No response-size cap either.
- **Fix**: replace `fetchWithTimeout` (returns `Response`) with `fetchJsonWithTimeout<T>` that reads
  + size-caps + JSON-parses the body INSIDE the timeout window, then clears the timer. Reads via a
  streaming reader with a byte cap when `response.body` is a real stream; falls back to
  `response.json()` for responses/mocks without a stream (keeps existing tool-test mocks green).
- **Test**: "headers arrive, body hangs" → timeout ToolFetchError; "oversized body" → too_large.

### Bug 3 — search tools silently convert malformed 200s into "no results"
`search-quran.ts:66`, `search-hadith.ts:76`: `const data: T[] = await response.json()` then
`if (!data || data.length === 0)`. A 200 with a non-array body has `data.length === undefined` →
returns the benign "No results found" — invisible to the degraded counter and Sentry. Same class in
`usul-client.ts` (no shape check → `data.results` undefined → silent "no results").
- **Fix**: Kalemat tools: `if (!Array.isArray(data)) throw new ToolFetchError(..., 'invalid_body')`.
  Usul client: require `Array.isArray(data.results)` else throw. Both degrade loudly through the
  tools' existing catch → `unavailableResult`.
- **Test**: 200-with-object-body → `isDegraded` result, not "No results".
- **Scope note**: mawsuah's per-result `if (result.node) … else …` dual-shape parsing is left as-is
  (load-bearing, refactor is out of BUGFIX scope). The top-level shape validation catches the
  reported failure mode.

### Bug 4 — Inkling truncated stream treated as a successful completion
`lib/ai/inkling-client.ts` `sseData` returns on `[DONE]` OR silently when the HTTP body ends, with
no distinction; `streamInkling` then yields `done` regardless. A connection cut after partial text
ships an incomplete answer marked complete. Also `sseData` drops a final line not terminated by a
newline (trailing data without newline → lost finish_reason).
- **Fix**: track whether `[DONE]` was seen; flush the trailing buffered line on EOF; after the
  stream ends, if neither `[DONE]` nor a `finish_reason` was seen → throw a distinct truncation
  error (last rung fails loud). Apply the terminal-`done` + `classifyDegenerateFinal` gate to
  `runSynthesis` in agent.ts (currently only checks `synthText.trim().length`).
- **Tests**: EOF after partial content (no DONE/finish) → truncation; finish_reason without DONE →
  accepted; trailing data without newline → parsed (finish_reason not lost).

## Fix phase — implemented & verified

All four fixes landed. `npm run typecheck` (0), `npm test` (486 passed, 3 pre-existing skips), and
`env $(grep -v '^#' .env.ci | xargs) npm run build` (0) all green.

- **Bug 1** — `agent.ts:661` guard changed to `!userMessageInHistory`. Regression test in
  facilitator-empty-final.test.ts: `[emptyRound, toolRound, textRound]` asserts the continuation
  call's history contains the user query exactly once; plus a no-double-push guard on the healthy path.
- **Bug 2** — `resilience.ts`: `fetchWithTimeout` (returns Response) replaced by
  `fetchJsonWithTimeout<T>` which reads + size-caps (8 MiB, `MAX_RESPONSE_BYTES`) + JSON-parses the
  body INSIDE the AbortController window. New error classes `too_large`, `invalid_body`. 3 callers
  updated. Tests: headers-arrive-body-hangs → timeout; oversized → too_large; unparseable →
  invalid_body; streamed body parsed.
- **Bug 3** — Kalemat tools throw `ToolFetchError(invalid_body)` on `!Array.isArray(data)`; usul-client
  throws on missing `results` array. Both degrade loudly through the existing catch. Tests:
  200-with-object-body → degraded (isDegraded), not "no results", in kalemat + usul suites.
- **Bug 4** — `inkling-client.ts`: `sseData` tracks `[DONE]` via a marker and flushes a trailing
  newline-less line; `streamInkling` throws a distinct truncation error when neither `[DONE]` nor a
  finish_reason arrived. `runSynthesis` in agent.ts now requires a terminal `done` event AND passes
  `classifyDegenerateFinal`. Tests: EOF-after-partial → truncation; finish_reason w/o [DONE] →
  accepted; trailing-no-newline → parsed; [DONE] w/o finish_reason → accepted.

Net diff: lib +255/-59 (much of it doc comments in the resilience rewrite), tests +271/-12. Contained
to the facilitator/tool pipeline; no architectural changes; within BUGFIX scope for a pre-authorized
4-bug batch.

## BLOCKED (2026-08-02) — porch fix-phase checks misconfigured for this monorepo

`porch check bugfix-2` fails on `build` (and would fail `tests`) because porch runs `npm run
build` / `npm test` from the **worktree root**, but this is a monorepo — `package.json` is in
`backend/`. `build` also needs the dummy CI env in `backend/.env.ci`. My code is verified green
from `backend/` (typecheck 0, test 486 passed / 3 pre-existing skips, build 0 with .env.ci).

Proper fix is a `porch.checks` override in `.codev/config.json`, but that file is a **symlink to
the main checkout** (`/Users/mwk/Development/iaser/ansari/.codev/config.json`) — shared per-user
config, outside this worktree; the write-guard blocks it and a builder must not pollute the main
tree. Escalated to the architect with the exact override (drafted in scratchpad
`porch-checks-override.json`). Waiting on: architect to apply the override to the shared config
(or advise). This blocks advancing out of the fix phase; the fix itself is done and committed.

## PR phase — PR #5 open, at the `pr` gate (2026-08-02)

Architect applied the `porch.checks` override to the shared `.codev/config.json`; fix-phase checks
now pass (build 7.5s, tests 6.4s). Advanced to PR phase.

- **PR #5** opened against `develop` with `Fixes #2`.
- **CMAP**: gemini=APPROVE, codex=COMMENT (its review sandbox couldn't run tests; no substantive
  objection), claude=APPROVE. No REQUEST_CHANGES.
- Disclosed in the PR body: issue #3's `search-mawsuah` per-result dual-shape sub-item is
  intentionally deferred (top-level usul shape validation covers the reported failure mode) so
  `Fixes #2` doesn't silently close it — recommend a follow-up issue if per-result unification is wanted.
- `porch done` → `porch gate` requested the **`pr` gate**. STOPPED, waiting for human approval
  (`porch approve bugfix-2 pr --a-human-explicitly-approved-this`). On approval: `gh pr merge --merge`
  (NOT `--delete-branch` — checked out in this worktree), then `porch done`, then notify architect.

## Constraints honored
No streaming wire-format changes (heartbeats/ZWSP/SSE shapes). No facilitator prompt changes.
Every fix gets a regression test. Full suite: `npm run typecheck && npm test && npm run build`.

Estimated net diff well under 300 LOC.
