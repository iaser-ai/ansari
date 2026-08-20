# Lessons Learned

<!-- STARTER: replace the "_No lessons captured yet._" line below with durable, cross-cutting
lessons as they emerge (usually during a review phase). Delete this comment once the file has
real content. -->

Durable engineering wisdom captured across the project's work. Update it during the review phase of any work that surfaces a generally-applicable pattern, gotcha, or constraint.

## Auth hardening (spec 4)

- **Session-version as uniform revocation.** A per-user integer, embedded in every token and bumped by *any* revocation event (reset, logout), invalidates all outstanding tokens without row locking. It closes reset-vs-refresh and logout-vs-refresh races with one mechanism. Prefer it over per-token or per-device bookkeeping when "kill all sessions" is the requirement.
- **Capture the version at authorization time; never re-read it inside issuance.** A refresh that captured `v` before a concurrent reset bumped to `v+1` must mint tokens carrying `v` (which then fail the check), not re-read `v+1` and mint a valid pair. Re-reading inside the transaction reintroduces the race.
- **Make one-time tokens single-use via a conditional delete inside the transaction**, not a check-then-act. `DELETE ... RETURNING` hands the row to exactly one of two concurrent callers; validating outside the tx (findToken → later delete) is a TOCTOU that lets both proceed.
- **`db.transaction()` is a no-op unless inner helpers use the `tx` handle.** Thread an `exec: Executor = db` param through every DB helper on a transactional path; a helper closing over the module-level `db` commits independently and defeats atomicity — and passes every mocked test. Verify with a real-DB rollback test.
- **Anti-oracle depends on check *placement*, not just the response string.** A reserved-address rejection must return the *same* status AND sit *before* any other validation (e.g. password strength) that could return a different code — otherwise the differing code leaks which addresses are privileged.
- **Drizzle wraps the driver error; the SQLSTATE `code` (e.g. `23505`) is under `.cause`, not the top level.** Walk the cause chain when discriminating unique violations from outages/schema errors — and never treat *every* insert failure as the expected constraint case.
- **Never log a raw driver/DB error object** — it can embed the submitted email, query params, or a password hash. Log sanitized metadata (`{ name, code }`) and return a generic client message.

## Monorepo migration & verification discipline (spec 48)

See `codev/reviews/48-standardise-to-apps-packages-m.md` for the full context.

- **Prefer failures that are loud over checks that are quiet.** Many checks pass by not running: an unresolvable lint config reports zero violations, a warm cache skips codegen, undeclared env is excluded from the cache hash, a lint task discovers no files, a `watchPatterns` glob matching nothing does not error. When a check can pass by not running, prove it fails when it should — with a deliberate violation, a removed declaration, a deleted output — and stops failing when restored.
- **Verify in both directions.** Proving a change moves a cache hash is only half the evidence; you must also prove that removing the declaration makes it stop moving. One direction alone cannot distinguish working from broken.
- **A verification pattern is code, and untested code is not evidence.** Scans fail silently — a compound regex that matches nothing, a too-loose pattern, an exclusion filter that never fires. Negative-test every scan against a known-bad line *and* a known-good near-miss, then report hit counts rather than a verdict.
- **Comments and docs deserve the same proof as behaviour.** Assertions about cache-hit behaviour, failure modes, or reachability are easy to write and easily wrong. Run the thing and read the output before writing the sentence.
- **Fix a documentation defect everywhere, not just where you happen to be editing.** Correcting guidance in some places but not others turns one wrong document into several that disagree — worse than the original error, because contradictions get argued about rather than followed.
- **Liveness means progress, not existence.** A live PID proves nothing: a process can sit for hours writing zero bytes against a multi-minute baseline. Compare bytes-written and elapsed time against a known-good baseline from the same batch.
- **In a relocation, `pnpm install` is not neutral.** A non-frozen install can silently bump a transitive dependency inside a supposedly pure move. Diff the lockfile before committing.
