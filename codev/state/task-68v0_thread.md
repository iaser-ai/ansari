# task-68v0 thread

## 2026-11-21: production auth journal apply recorded

Owner facts (via the architect): the whole auth journal (0000_auth_schema, 0001_api_key) was
applied by psql to the EMPTY production auth database ahead of the window, from develop at
3951c806; the journal check printed `0000_auth_schema|t` and `0001_api_key|t`; afterwards
`select (select count(*) from auth.users) + (select count(*) from auth.account)` printed 0.
No user copy, no app 0009-0011, no admin grants: those stay for the window.

Done:
- `AUTH_DEPLOYED_THROUGH = '0001_api_key'` in packages/auth's parity test; comment says it is
  still a declaration. The deployed-state test now runs (passes: sign-up + sign-in on 0000+0001).
  Renamed it: its title said "SKIPPED until the cutover", which would now be false.
- New `docs/cutover/release-record.md` (the production window's record) with the two
  `auth-journal-applied:` lines the test scans for.
- Dated "Production, 2026-11-21" notes wherever a doc said production's auth DB is empty/has no
  schema before the window or that the window applies the journal: better-auth-cutover.md (dry
  run, release record, C-4 table row, operator URL checks, empty precondition, Railway bullet,
  step 4 snapshot, step 5), deploy-guide.md (step 1 empty check, step 3). Also short notes in
  service-keys-runbook.md, apps/auth/scripts/cutover/README.md and docs/self-hosting.md, which
  stated the same thing. Nothing else rewritten. Staging/rehearsal text untouched (staging is
  unaffected). Abort/restart texts that `DROP SCHEMA auth CASCADE` still work: step 5's check then
  reports every file missing and they are applied.
- Tests via a worktree-only `.codev/config.local.json` (untracked); `.codev/config.json` is a
  symlink to main and was not touched.

## 2026-11-21: architect review on PR #414, three changes

1. release-record "From": the commit is the architect's assumption, 3951c806 or its first parent
   2f11877e. `git diff --quiet 47b4dfc0 <c> -- packages/auth/drizzle` exits 0 for both.
2. Deviation entry: the production auth domain is attached and serving (health 200, jwks 200,
   account/me 401; all 500 before the apply). Dated pointers at runbook step 1's Railway bullet,
   step 9, deploy-guide step 7. Consequences recorded: jwks is bound to the current
   BETTER_AUTH_SECRET; re-run the users+accounts count right before step 6.
3. Step 5 / deploy-guide step 3 now print the single-file psql command and say the loop is
   not run in production. `cutover-docs.test.ts` counted 4 apply lines in the runbook; it now
   expects 5 (the new line carries both flags and names the auth database, as the test requires).

## 2026-11-21: review round 2: service keys before the copy

I checked the code before writing anything. `createServiceUser` (packages/auth/src/service-users.ts) inserts
one auth.users row and one auth.account row in one transaction; `create-key` refuses without
that user. 02-import-auth.sql's first guards raise on any row in auth.users / auth.account.
So a production create-service before copy.sh would make the copy refuse. Dated notes:
release-record (deviation consequences), runbook step 6, deploy-guide step 4, both Issuance
sections of service-keys-runbook.md. Keys go after the copy, before the promotion.

## 2026-11-21: review round 3 (integration review), five fixes + three nits

packages/auth/README (marker no longer null); after a DROP SCHEMA auth the step-5 loop IS run
(step 5 note, deploy-guide step 3, two dated pointers in rollback.md); BETTER_AUTH_SECRET row in
deploy-guide points at the jwks consequence (the runbook's step 1 does not name the secret);
"Open owner decisions" entry in the record (auth service live or not: NOT decided; step 9's
check applies as written until recorded; remedy for a non-zero pre-copy count); release-record.md
added to cutover-docs DOCS + path checks (negative-tested: a planted missing path fails it).
Nits: bare apply lines moved below the list, test title shortened, reversal sentence added.
My first rollback.md edit split the "(the auth baseline)" phrase a test pins; I moved my note
outside that phrase.

## 2026-11-21: owner decision: production auth stays serving until the window

Recorded as decided in release-record.md (accepted risk, pre-copy count as mitigation, remedy).
Runbook step 9 / deploy-guide step 7: in production the attach is skipped and /health 200 is
expected; stop-on-200 still applies to staging. Step 1's Railway bullet says the two conditions
do not hold in production, by this decision.

Flaky (pre-existing, not touched here): apps/api `tests/auth/layer.test.ts` failed 26 of 35 in
one of three full serial runs (apps/auth answered 404 to the layer: "Registration: apps/auth
unavailable { status: 404 }"); it passed alone (35/35) and in the next full run (1424 passed).
