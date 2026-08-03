# air-18 thread — Issue #18: real pglite rollback coverage for logout transaction

## Implement

- Worktree was cut from develop *before* PR #15 (spec 4 auth hardening) merged, so the
  logout transaction and both referenced test files didn't exist here. Merged
  `origin/develop` (clean, no conflicts) to get the real baseline before writing anything.
- Gap confirmed: `logout-route.test.ts` stubs `db.transaction` with a passthrough fake
  (`cb({})`), so deleting the transaction wrapper from `logout/route.ts` passes every test.
- Added `backend/tests/logout-route-pglite.test.ts` following the
  `session-version-reuse.test.ts` pattern: real POST handler, real middleware, real db
  helpers against pglite; only `db/index`, `config`, and Sentry mocked.
- Failure injection: a plpgsql `BEFORE DELETE` trigger on `tokens` raises, making the
  transaction's second write (`deleteUserTokens`) fail with a genuine DB error — no
  helper mocking needed, the whole route path stays real.
- Three tests: happy-path commit (tokens gone + version bumped), rollback atomicity
  (500, version unchanged, tokens intact, session still authenticates), and
  retry-after-fault-clears (full logout completes, old token dead).
- **Mutation-verified**: temporarily removed the `db.transaction` wrapper from the route —
  2 of 3 tests fail (rollback + retry). Restored. The coverage genuinely guards the wrapper.
- Full suite green: 60 files, 588 passed / 3 skipped. Typecheck clean. Lint: 0 errors,
  only pre-existing warnings, none in touched files.
