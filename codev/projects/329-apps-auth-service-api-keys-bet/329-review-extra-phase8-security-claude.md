I'll start by locating the worktree and the actual files on disk.# Review — PR #331, phase 8 ("Remove the phone number", owner amendment 2)

Scope: `7d1a163d..3ff38416` (= `origin/builder/spir-329`), read from the worktree at `.builders/spir-329`. Note up front: the increment is **one file larger than the diff I was handed** — `codev/resources/arch.md:25` was changed in `47b4dfc0` and does not appear in the pasted diff. I read it; it is correct for the final state (no phone claim). Worth knowing only because the omission was silent.

---

## (1) Completeness of the removal

**No findings.** The removal is complete in the senses that matter — read, store, log, echo, derive.

Rationale: the column is gone from `packages/auth/src/schema.ts` (`users` no longer declares `phoneNumber`), the better-auth additional user field is gone from `packages/auth/src/index.ts` (and `packages/auth/tests/config/options.test.ts` now pins the surviving three: `first_name`, `last_name`, `registered_via`), and the phone-update block is gone from `decideUnderLock` in `packages/auth/src/whatsapp.ts`. The route no longer names the field except in prose: `apps/auth/src/routes/whatsapp.ts:9-11` documents accept-and-ignore accurately, and line 20 keeps the number in the never-leak list, which is the correct remaining mention. I independently re-ran the source-scan logic from `apps/auth/tests/no-phone-source.test.ts` as a read-only `node -e` pass over `packages/auth/src` + `apps/auth/src` and got `files: 28 hits: 0`, matching the review doc's reported numbers exactly. Docs are consistent, not partially fixed: `docs/self-hosting.md:243` ("accepted and ignored; no phone number is stored"), `docs/cutover/service-keys-runbook.md:126-127`, `docs/cutover/better-auth-cutover.md:340`, `packages/auth/README.md:15,59`, `codev/resources/arch.md:25`. That is the project's own "fix a documentation defect everywhere" lesson honoured.

---

## (2) The regenerated migration

**No findings.** It satisfies the constraint exactly.

Rationale: `git diff 7d1a163d HEAD -- packages/auth/drizzle/` shows the rename `0001_api_key_phone.sql → 0001_api_key.sql` plus **exactly one** deleted line — `ALTER TABLE "auth"."users" ADD COLUMN "phone_number" text;--> statement-breakpoint` — and nothing else in the SQL. `meta/_journal.json` carries `0000_auth_schema` / `0001_api_key` with `when` values unchanged in kind; `meta/0001_snapshot.json` differs only by a fresh `id` and the dropped column. I grepped for anything asserting a `when` or a snapshot `id` and found nothing, so the regeneration cannot have broken a hidden pin. Every tag reference is consistent: the journal, the SQL filename, the fully tag-driven `apps/auth/scripts/cutover/auth-journal.mjs`, `packages/auth/tests/migration/auth-journal-parity.test.ts:95`, `apps/auth/tests/cutover/copy.test.ts:464/472/484`, `apps/auth/tests/cutover/auth-journal.test.ts:53`, `apps/auth/tests/docs/self-hosting-docs.test.ts:81-82`, `apps/auth/tests/docs/cutover-docs.test.ts:465`, the three runbooks and the README. The only surviving `api_key_phone` strings are untracked files, a corrected thread line, and historical quotes in the review's appendix — all correct. The boot assertion is unaffected: `apps/auth/src/boot.ts:31-43` probes only the `auth.apikey` relation (42P01) and `hasAuthUniqueConstraint` on `auth.account`, neither of which mentions a users column.

---

## (3) The accept-and-ignore contract

**nit — no composite shape in the accept list.** `apps/auth/tests/whatsapp-session.test.ts:338-345` covers seven shapes (digits, leading `+`, JSON number, `null`, empty string, 33 chars, letters and spaces) but no nested object, array or boolean. The contract is nonetheless airtight by construction, not by enumeration: `exchangeBody` at `apps/auth/src/routes/whatsapp.ts:85-90` destructures only `bsuid` and **returns a fresh object literal** `{ bsuid }`, so the spread at line 181 (`{ userId, ...body }`) provably cannot carry any other key into `issueWhatsappToken`, whatever its shape. I settled this by reading rather than by mutating: there is no path from `req.body.phone_number` to state, because the only object that reaches state is one the route built itself. The nit is that a reader has to notice that to trust it; one `['a nested object', () => ({ n: remember(...) })]` row would make the type-independence explicit.

**nit — the JSON-number shape is outside the never-log needle set.** Line 341 (`['a JSON number', () => Number(...)]`) does not go through `remember()`, unlike the five string shapes. `remember()` (lines 40-49) is what seeds the file-wide log capture at lines 795-803, so that one value is checked against the response body and the auth rows but not against the captured log lines. Low risk — a number cannot reach a log line by a path a string couldn't — but the asymmetry is unintentional-looking.

**nit — `EXCHANGE_BODY_LIMIT` headroom is argued, not tested.** A worst-case accepted body (256-char `bsuid` + a long `phone_number`) is roughly 330 bytes against a 1024-byte limit, so the limit cannot reject a legitimate WhatsApp request. The 400 list at `apps/auth/tests/whatsapp-session.test.ts:~541-557` tests the limit's upper edge (`pad: 'x'.repeat(limits.EXCHANGE_BODY_LIMIT)`) but nothing pins that a maximal *valid* body still passes. A single 200 case with a 256-char bsuid plus a 64-char phone would convert the arithmetic into a regression guard.

No finding on the response or log surface: `post()` at lines 117-136 asserts every response against the **raw body text** and against each string value longer than 2 chars, the Sentry scrub test still carries `data: '{"bsuid":"US.1","phone_number":"15551234567"}'` as its needle, and the log capture asserts `logged.length).toBeGreaterThan(0)` so it cannot pass by capturing nothing. The needles survived the increment, as amendment 2 requires.

---

## (4) Test quality

**should-fix — the `ALTER TABLE … ADD COLUMN` branch of the cutover journal check is now uncovered.** `apps/auth/scripts/cutover/auth-journal.mjs` (`objectChecks`, ~lines 60-64) has a branch that turns an `ADD COLUMN` statement into an `information_schema.columns` check. Its only two assertions were `apps/auth/tests/cutover/auth-journal.test.ts:29` (was `toContain("column_name = 'phone_number'")`) and `apps/auth/tests/cutover/copy.test.ts:487` (same), and phase 8 inverted both to `not.toContain('phone_number')`. Since no journal migration adds a column any more, that branch is now operator-script code with zero coverage — and it is precisely the code the next column migration's cutover will depend on, in a hand-applied-migration regime where a wrong check is a silent "verified". This is the project's own lesson verbatim: *a verification pattern is code, and untested code is not evidence*. The fix is one assertion, no fixture: `objectChecks('ALTER TABLE "auth"."users" ADD COLUMN "x" text;', '0002_add')` should yield the `column_name = 'x'` check. Note the file keeps its unknown-statement negative (`DROP COLUMN` → throws) and its "a check that only knew 0000 would pass there" control, so the surrounding discipline is good — this one branch just fell off the edge.

**should-fix — `packages/auth/tests/config/api-key.test.ts:310-337` can pass vacuously.** The rewritten all-tables scan loops tables asserting `expect(JSON.stringify(rows), table_name).not.toContain(number)`, guarded only by `expect(tables.length).toBeGreaterThan(0)`. That proves the *table list* is non-empty, not that the dump contains anything: a query that returned `[]` per table (wrong schema filter, a quoting slip, a renamed column) would pass every assertion while proving nothing. Contrast the two scans that amendment 2 actually names, both of which carry a positive control: `apps/auth/tests/whatsapp-session.test.ts:351` (`expect(rows).toContain(bsuid)` — the scan sees this exchange's own writes) and `apps/api/tests/contract/whatsapp-exchange.test.ts:135` (`expect(authText).toContain(bsuid)`). One line — `expect(dump).toContain(email)` — brings this one up to the same standard. Secondary, same hunk: the rewrite dropped the former `expect(signUp.status).toBe(400)` pin in favour of "any non-200", so better-auth's unknown-field behaviour at sign-up is now pinned in neither direction. That is a defensible choice (plan line 461 says so deliberately), but the behaviour actually observed should be written down somewhere, or the next upgrade silently changes meaning.

**No finding on the model test — the deviation is pinned, not waived.** `packages/auth/tests/schema/better-auth-model.test.ts` runs `getAuthTables(createAuth(drizzleFor(client)).options)` against the journal-built pglite, maps types through `COMPATIBLE`, checks `required → NOT NULL`, asserts `Object.keys(models.apikey!.fields)).toHaveLength(21)`, asserts no phone field, and has a negative control that drops `apikey.key` and retypes `name` to integer. I checked the deviation question the hard way, by reading the installed plugin rather than trusting the test's framing: in `@better-auth/api-key@1.7.7` the apikey model has **exactly 21 fields** and `referenceId: { type: "string", required: true, input: false, index: true }` with **no `references`**. So `DEVIATIONS = { 'apikey.referenceId': 'uuid' }` is live — it is not shadowed by the `def.references ? ['uuid']` branch — and the test fails if that column ever becomes `text`. All 21 required/optional flags line up with the drizzle table's nullability, so the test is genuinely green rather than silently green.

**nit — the model test's negative control is partial and one-directional.** It exercises the missing-column and wrong-type branches but not required-but-nullable or missing-table, and it cannot see columns the database has that better-auth doesn't model. The second gap is covered elsewhere (`auth-schema.test.ts:83` plus the journal-parity test), so this is a completeness note, not a hole.

---

## (5) Anything weakened from the approved design

**No findings.** I re-read the parts phase 8 touches or sits next to, and nothing regressed.

Rationale: `packages/auth/src/whatsapp.ts:140-231` still sets `lock_timeout` and `statement_timeout` via `set_config(..., true)` before `.for('no key update')`, still re-reads the user inside the lock (`user-gone`), still applies all four eligibility checks (`accounts`, `address`, `registered_via`, `role !== USER_ROLE` — exactly `user`, not "not admin"), still deletes sessions and returns `{kind:'banned'}` on a ban, still reuses a session only against `exp + SESSION_MARGIN`, and `issueWhatsappToken` still signs **after** `db.transaction(...)` commits. The route is unchanged in every respect that matters: one 401 body for every key refusal (`refuse` → `unauthorized`, `apps/auth/src/routes/whatsapp.ts:92,116-119`), the per-user budget consumed on the pool *outside* the locking transaction with the comment explaining why (lines 172-179), the 404 catch-all so OPTIONS and sub-paths never fall through to `corsFor` (lines 219-221), and `fail()` logging `redactError(err)` — `{name, code}` only, never the raw driver object (line 122). The removal of the phone column also moots the old rationale behind `packages/auth/tests/migration/auth-journal-parity.test.ts`'s deployed-state test ("the phone_number additional field makes that insert fail"), but the test now does a generic sign-up/sign-in and remains meaningful; nothing is weaker.

**nit — cosmetic JSDoc rewrap.** `packages/auth/src/whatsapp.ts:149-150` reads awkwardly after the phone sentence was removed ("…the ban and the session. Nothing here signs or spends a / * rate-limit budget."). Purely editorial.

---

## (6) Review-doc and PR-body accuracy

**nit — review doc line 5 overstates the phase-8 verdict.** It says "Eight phases, each approved by Codex", but the recorded phase-8 verdict at lines 236-238 is `### Phase 8 (Round 1)` / `#### Codex (COMMENT)`. A COMMENT is not an approval; the summary line and the record disagree. Worth a word change because this document is the audit trail for a hand-applied-migration change.

**nit — review doc line 98 is stale.** The superseded-deviation bullet still ends "the body tests swap the 400 case for a 200 case (red without the route change)", but phase 8 **deleted** those six phone 400 cases outright. The bullet is already marked superseded, so this is low-stakes, but it describes tests that no longer exist.

**nit — the plan was not amended the way the spec was.** `codev/specs/329-….md` folds amendment 2 in properly with strikethroughs (§5 ~233-257, criteria 248-251/310-314/486-487, risk table 523-524). `codev/plans/329-….md` adds a correct phase 8 at line 435+, but lines 10, 75, 90, 96, 100, 128, 264, 269-274, 287-301 and 353 still describe the phone column and the phone update as live, unmarked. Same "partial fix makes several docs disagree" hazard the increment otherwise avoided.

**Positive note on the doc's honesty.** Line ~487 records plainly that T12's two read-only staging queries were **not run** and that the claim rests on the owner's written record. That is the right way to carry an unverified premise, and the residual risk is bounded: if migration 0001 had in fact been applied, the apply would fail loudly on `CREATE TABLE "auth"."apikey"`, and the `0002` fallback is recorded. Line 457 (migration = one-line diff) matches what I measured. The PR body is accurate for the final state: `0001_api_key`, "no phone column", the phase-8 testing paragraph, and the counts (@ansari/auth 254 + 1 skipped, ansari-auth 472, ansari-api 1139 + 3 skipped, typecheck/lint 13/13).

---

## Library behaviour I relied on that the review doc does not probe

Three things, stated plainly:

1. **`getAuthTables` field shape.** The model test's correctness depends on `type`, `required`, `fieldName` and `references` meaning what it assumes. The review doc asserts the resulting schema match but does not probe the model itself. I verified it by **reading** installed `@better-auth/api-key@1.7.7` (`dist/index.mjs`): 21 apikey fields, `referenceId` as string/required/`input:false`/`index:true` with no `references`. That is what makes the single deviation load-bearing rather than decorative.
2. **better-auth core 1.7.7 unknown-field handling at sign-up.** The rewritten `api-key.test.ts:310-337` accommodates either behaviour (reject, or accept-and-drop). Neither the test nor the doc pins which one 1.7.7 does; I did not probe it. That is the basis of my should-fix note about recording the observed behaviour.
3. **I did not run the suites.** This is a read-only review of a live builder worktree, so running vitest would write caches into the tree under review and could collide with the builder. The recorded test counts are taken on trust from the PR body. Where I needed evidence rather than trust, I re-implemented the check read-only outside the tree (the source scan: `files: 28 hits: 0`) or settled it by reading source. I was not asked to edit anything, and I changed nothing.

---

APPROVE WITH CHANGES (1: add a one-line unit assertion covering `objectChecks`'s `ALTER TABLE … ADD COLUMN` branch in `apps/auth/tests/cutover/auth-journal.test.ts`; 2: add a positive control — `expect(dump).toContain(email)` — to the all-tables scan at `packages/auth/tests/config/api-key.test.ts:310-337`, and record which sign-up behaviour better-auth 1.7.7 actually exhibits; doc nits optional)