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

## Gemini history fidelity (issue #70)

- **Validate invariants at persist time when the record is replayed forever.** A payload that is re-sent on every later request turns a transient producer bug into a permanent per-record poison (here: an orphan `functionCall` would 400 every subsequent turn of the thread). Guard the invariant where the data is persisted and degrade loudly to a safe shape (NULL + Sentry error) instead of storing corrupt state.
- **Stop emitting, don't stop processing.** A mid-loop `break` that cuts one accumulator (streamed events / `toolCalls`) while another (the stored payload) keeps the whole input desyncs the two views of the same turn. Suppress the unwanted *output* with a flag and let the loop complete, so every derived view stays consistent.
- **Hand-written test DDL is a schema copy and drifts like one.** Adding a column meant updating five pglite `CREATE TABLE messages` blocks across test files; the real-DB suites failed loudly until they matched — which is exactly the drift-detection a mocked suite would have silently missed.
- **A live check is only as strong as the shape it exercises.** A pre-fix live Vertex replay check passed for the wrong reason: its single-chunk fixture was the one shape that hides last-chunk-wins truncation. Pick verification fixtures that *can* exhibit the suspected failure mode (here: a multi-chunk streamed turn), or the pass certifies nothing.

## Tool-call persistence (spec 73)

See `codev/reviews/73-persist-tool-use-and-tool-resu.md` for the full context.

- **Make invisibility structural, not a filter.** Records that must never reach an API response (error-turn tool logs) went to a separate table rather than marker rows in `messages`: a table no existing query reads is invisible to thread GET, share snapshots, history replay and message-count stats by construction, whereas marker rows need a filter at every current and future consumer — the quiet-check failure mode. Likewise, project sensitive columns OUT of the read helpers so the contract does not depend on each route's `.map()` discipline.
- **A green suite after adding an error-path call is unproven until every factory mock carries the export.** Four route tests factory-mocked `@/lib/db/threads` without the new `persistOrphanToolCalls`; vitest throws on the missing export, but the streams' `catch` swallowed it and every assertion still held. Nothing failed — the gap was found by reasoning, not by a red run. Grep `vi.mock('<module>'` the moment a route gains a new import from that module.
- **Re-grep hand-written test DDL after every develop merge, not once per phase.** The #70 lesson (test DDL drifts like a schema copy) has a timing corollary: a sixth `CREATE TABLE messages` arrived *with* the develop merge (PR #88) after the initial five-file update, and its whole-row select failed with an unknown column. Loud, but only because the merge happened before the suite ran.
- **Normalize "absent or empty" to one value at the boundary.** `toolCalls ?? null` would have persisted `[]` for an explicitly empty array — legal under the producer's "absent/empty" contract — violating the NULL-when-unused rule. A pure `toolCallsOrNull()` at every persist site (placed in the schema module so no mock needed a new export) closes the class, with a per-site empty-array regression.
- **Lazy config reads inside error paths need targeted mocks in unit tests.** Two terminal facilitator paths (`isInklingConfigured()`, the degenerate-final `config.gemini.model` summary) read validated config only when reached; in a harness without env they throw *inside the catch*, turning the path under test into a different error. Mock `@/lib/ai/inkling-client` and `@/lib/config` whenever a test drives a terminal error path.
- **Number migrations after merging, and expect drizzle's prefix to lag.** A concurrent PR took the next journal index mid-project; the fix was merge-then-generate and a manual rename (`0007_*` at idx 6). drizzle-kit names files by index, so the next generate will emit another `0007_` — the successor must be `0008_*`.

## Monorepo migration & verification discipline (spec 48)

See `codev/reviews/48-standardise-to-apps-packages-m.md` for the full context.

- **Prefer failures that are loud over checks that are quiet.** Many checks pass by not running: an unresolvable lint config reports zero violations, a warm cache skips codegen, undeclared env is excluded from the cache hash, a lint task discovers no files, a `watchPatterns` glob matching nothing does not error. When a check can pass by not running, prove it fails when it should — with a deliberate violation, a removed declaration, a deleted output — and stops failing when restored.
- **Verify in both directions.** Proving a change moves a cache hash is only half the evidence; you must also prove that removing the declaration makes it stop moving. One direction alone cannot distinguish working from broken.
- **A verification pattern is code, and untested code is not evidence.** Scans fail silently — a compound regex that matches nothing, a too-loose pattern, an exclusion filter that never fires. Negative-test every scan against a known-bad line *and* a known-good near-miss, then report hit counts rather than a verdict.
- **Comments and docs deserve the same proof as behaviour.** Assertions about cache-hit behaviour, failure modes, or reachability are easy to write and easily wrong. Run the thing and read the output before writing the sentence.
- **Fix a documentation defect everywhere, not just where you happen to be editing.** Correcting guidance in some places but not others turns one wrong document into several that disagree — worse than the original error, because contradictions get argued about rather than followed.
- **Liveness means progress, not existence.** A live PID proves nothing: a process can sit for hours writing zero bytes against a multi-minute baseline. Compare bytes-written and elapsed time against a known-good baseline from the same batch.
- **In a relocation, `pnpm install` is not neutral.** A non-frozen install can silently bump a transitive dependency inside a supposedly pure move. Diff the lockfile before committing.
- **`globalDependencies` necessity is per-task, gated by the `^` prefix (spec 59).** Whether a `workspace:*` dep's edits bust a consumer task's cache depends on that task's `dependsOn`: a `^`-prefixed entry (`^build`) makes Turborepo traverse internal-dependency package hashes (so it busts without a `globalDependencies` line), while a task with only un-prefixed deps (`typecheck` → `["gen:types"]`) or none (`lint`) does not — it needs the entry. Don't test "does editing the shared package bust the cache?" at the package level and generalize; test each task you rely on. Here `apps/auth#build` busted on `@ansari/auth` edits either way but `#typecheck` did not until `packages/auth/src/**` was listed.
