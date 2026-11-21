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
