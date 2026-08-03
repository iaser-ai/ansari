# air-20 thread — Issue #20: Extend Executor pattern to threads.ts and feedback.ts

## 2026-08-02 — Implement

- Spawned in strict AIR mode. Porch phase: implement.
- Found my branch was cut from a stale develop (80 commits behind): the Executor
  pattern the issue references (PR #15, spec 4) wasn't in my tree. Rebased
  builder/air-20 onto origin/develop (only my porch-init commit was unique; clean rebase).
- Design decisions:
  - Lifted `Executor` from a module-local type in `lib/db/users.ts` to an exported
    type in `lib/db/index.ts` (next to `db`, which it's defined in terms of).
    users.ts now imports it; no behavior change.
  - Threaded a trailing `exec: Executor = db` through ALL helpers in threads.ts and
    feedback.ts (reads included — read-your-writes inside a tx needs them), matching
    the users.ts convention. Internal composition passes exec down
    (createMessage's two statements, getThreadWithMessages' two reads).
  - Did NOT make createMessage self-wrap its two statements in a transaction —
    consistent with users.ts (issueTokenPair also leaves wrapping to the caller),
    and out of scope for #20.
- Tests: new `tests/executor-threads-feedback.test.ts` (pglite, real transactions):
  rollback atomicity, commit path, a poisoned-global-db proxy proving no helper
  bypasses its exec, standalone default behavior, and the createMessage
  thread.updated_at bump through the tx.
- Verified: typecheck clean, full suite 60 files / 590 passed (3 pre-existing skips),
  `next build` green with .env.ci loaded (matches CI).

## 2026-08-02 — PR gate

- `porch check` green (build + tests). Rebase required a `--force-with-lease` push
  (origin held only the pre-rebase porch-init commit; content preserved).
- PR #26 opened against develop with the review in the body. Porch at `pr` gate;
  architect notified via afx. Waiting for human approval.

## 2026-08-03 — Direction change: first real consumers (architect instruction)

- Architect extended the PR scope: don't merge plumbing-only. Wrapped thread-creation +
  inbound-message persistence in `db.transaction` in the two ingestion routes
  (v1/chat/completions, v2/mcp-complete), scoped strictly to pre-stream/pre-facilitator
  persistence — never held across runFacilitator.
- On v1 the DB failure path stays non-fatal (caller still gets an answer), but threadId
  now stays undefined on rollback so no assistant reply attaches to a partial log.
- New `tests/route-persistence-rollback.test.ts`: pglite through the ACTUAL route
  boundary; a CHECK constraint (sentinel __BOOM__) forces the inbound insert to fail;
  asserts zero threads and zero messages remain (both routes), plus success-path sanity.
- Existing mocked route tests updated: db.transaction passthrough mock + tx arg in
  createThread/createMessage assertions.
- Suite 61 files / 594 passed, typecheck + build green.
