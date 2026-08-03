# bugfix-14 thread — Issue #14: Gemini 400 "function response parts != function call parts"

## 2026-08-02 — Investigate phase

**Root cause identified** (code reading, `backend/lib/facilitator/agent.ts`):

When a model turn contains N parallel `functionCall` parts, the tool-round loop pushes
**N separate `user`-role Contents**, each carrying ONE `functionResponse` part
(agent.ts ~705 skipped branch, ~734 normal branch). The Gemini/Vertex contract for
parallel function calling requires all N `functionResponse` parts to be in the
**single** user turn that follows the functionCall turn. With the split shape, the
turn immediately after the model's functionCall turn has 1 response part vs N call
parts → Vertex rejects the continuation with:

> 400: Please ensure that the number of function response parts is equal to the
> number of function call parts of the function call turn

**Why it matches prod evidence:**
- `iterations: 2, toolCallCount: 3` — the 400 fires on the *continuation* call
  (iteration 2) right after a round where the model made 3 parallel calls.
  Single-call rounds (the common case) are 1=1 and pass, which is why this recurs
  only occasionally (~4 in 2.5h): parallel-call turns are rare, but when one
  happens the 400 is deterministic.
- The kalemat timeout coincidence is incidental: parallel rounds hit multiple
  tools at once, so a same-second timeout is more likely, but degraded results DO
  get a functionResponse appended (checked: both the degraded and the thrown/backstop
  paths return a result that is pushed). The count in our history always matches
  numerically — the defect is structural (split across Contents), not a missing
  response.

**Ruled out:**
- `gemini-client.ts` rawPayload construction: `streamRawPayload` (#83 fix) guarantees
  the stored model turn's functionCall count equals the emitted tool_call events, so
  `toolCallsCollected.length` always equals the rawPayload's call-part count.
- `continueWithToolResult`: exported but has zero callers — not the prod path.
- Inkling rescue path: `inkling-client.ts` iterates parts within each Content, so it
  tolerates both the split shape (why the rescue succeeds) and the merged shape the
  fix will produce.

**Planned fix (fix phase):** accumulate the round's `functionResponse` parts (real,
degraded, and budget-skipped alike) into a single `user` Content pushed once after
the tool loop. Regression test: script a 3-parallel-call round and assert the Content
following the functionCall turn carries all 3 functionResponse parts (fails on
current code, which produces 3 single-part Contents).

No live Vertex repro possible from this environment (only dummy `.env.ci` creds);
repro standard is the failing-without-fix regression test + prod log correlation.

## 2026-08-02 — Fix phase

Implemented in `backend/lib/facilitator/agent.ts`: the tool-round loop now
accumulates all functionResponse parts (real, degraded, budget-skipped) into
`responseParts` and pushes ONE `user` Content after the loop (before the
short-circuit synthesis branch, so synthesis history is well-formed too).
Net diff: ~28 insertions / 27 deletions in agent.ts.

Regression test `backend/tests/facilitator-parallel-responses.test.ts` (4 cases:
3-parallel healthy, parallel-with-degraded, T1-short-circuit-with-skips,
single-call rounds). Verified 3/4 fail with the fix reverse-applied
(single-call case passes by design — that shape was already valid), all pass
with the fix.

Checks: typecheck clean, full suite 489 passed / 3 skipped, `next build` green
with CI dummy env, lint 0 errors (8 pre-existing warnings, untouched files).
Commits 264edad (fix) + d2ec5af (test).

## 2026-08-02 — PR phase

PR #27 open against develop with `Fixes #14`.

CMAP 3-way review (protocol bugfix, type pr): **gemini=APPROVE, codex=APPROVE,
claude=APPROVE**, all HIGH confidence, no blocking issues. Non-blocking notes
from claude: (1) root cause is code-reading + prod-correlation, not a live
Vertex repro — monitor the 400 signature post-merge; (2) `functionResponse.id`
is not propagated for same-name parallel calls (pre-existing; possible
follow-up issue).

`pr` gate requested via porch; waiting for human approval.

## 2026-08-03 — Integration + merge

Architect asked for a develop-tip integration before the gate: merged
`origin/develop` into `builder/bugfix-14` (clean, no conflicts), reran
post-merge — typecheck clean, full suite **589 passed / 3 skipped** across 60
files (now includes PR #15's auth suites; was 489 pre-merge). Pushed.

`pr` gate approved by the human in porch state (`gates.pr.status: approved`,
2026-08-03T18:05:45Z) — verified in status.yaml before merging, per the
protocol's "merge is gated by porch state, never by typed prose" rule.

**PR #27 merged to develop** at 18:10:37Z (merge commit 38ffdec). CI was green
(backend lint/typecheck/test/build + gitleaks), mergeStateStatus CLEAN.
Issue #14 auto-closed by `Fixes #14`. Branch NOT deleted (worktree is checked
out on it) — awaiting architect-driven `afx cleanup`.

**Post-merge watch item:** the root cause was established by code reading +
prod-log correlation, not a live Vertex repro. Confirm the 400 signature
("number of function response parts is equal to...") and its Inkling-rescue
breadcrumbs stop appearing in prod after deploy. Possible follow-up (non-
blocking, pre-existing): `functionResponse.id` is not propagated, so same-name
parallel calls are matched positionally.
