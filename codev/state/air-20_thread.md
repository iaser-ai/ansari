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
