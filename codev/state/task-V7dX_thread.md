# task-V7dX: backend-only amendments to the cutover runbook (#416)

## 2026-11-21: brief and facts

- Brief from the security architect: the eight items under "Runbook amendments for backend-only" in
  #416, across `docs/cutover/better-auth-cutover.md`, `deploy-guide.md` and `rollback.md`. Docs only,
  one PR, "Refs #416".
- Owner decision relayed at 07:10Z, replacing item 4: keep the web domain detach at step 3 and the
  re-attach at step 13, with the legacy web service as the only production web service.
- Measured: `git rev-list --count origin/main..origin/develop` = 1469 (main `27531c8f`, develop
  `3a30749c`); main is an ancestor of develop. main's app journal ends at `0008`, develop's at `0011`.
- `legacy/frontend-web`: `git diff --stat origin/main origin/develop` is empty. Zero hits for
  `maintenance|app-check|app_check` on either ref. The same grep finds hits in `legacy/frontend-app`,
  which shows the pattern can match.
- `MAINTENANCE_MODE` is read only by `config.ts` and the app-check route, on both refs.
- Decision: keep 16 numbered steps. Step 13 becomes "the web domain back on legacy web". Service
  keys become step 8a, so no step is renumbered and existing cross-references stay valid.
  `apps/api/tests/cutover-docs.test.ts` pins doc text, so it is updated alongside the docs.

## 2026-11-21: done, PR opened

- Runbook: backend-only and promotion-delta preamble; fresh-checkout verification block; the
  precondition "main is current except for spec 300" replaced; `FRONTEND_URL`, `CORS_ORIGIN`, the
  web service and `MCP_COMPLETE_KEY_MODE` preconditions; why step 3 detaches the web domain, with
  grep evidence; the users-and-accounts count right before `copy.sh`; step 7's table re-derived from
  `origin/main`; step 8a for service keys; steps 10 and 11 cover `auth` and `backend` only; step 13
  re-attaches the domain to legacy web; step 14 lists the legacy web flows and their `/api/v2` routes.
- Deploy guide, rollback, rehearsal and service-keys-runbook brought in line. The docs test is
  updated, and its new assertions fail against the old docs (7 failures), so they can catch a
  regression.
- Found, not decided: what a production rollback does with `auth`, which had a live deployment
  and its domain before the window (`rollback.md`, step 3 note). Also, the "Frontend (web) build
  variables" note in `RELEASE.md` says both variables are mandatory on every web service. That is
  `main`'s surface, so it is reported to the architect and not edited.
- Legacy web's delete page goes to `/welcome` even when the `DELETE` fails, so the smoke test
  checks that a sign-in after the delete fails.

## 2026-11-21: scope addition (security architect, on the owner's word)

- The `EXPO_PUBLIC_*` "mandatory on every web service" notes are now scoped to web services built
  from `apps/frontend/Dockerfile.web`, in `RELEASE.md`, `apps/frontend/railway.toml` (comments
  only) and `apps/frontend/README.md`. A grep found no fourth place.
  `Dockerfile.web:16` and `check-web-env.mjs:12` describe that image itself, so they are already
  correctly scoped and were left as they are.
- `rollback.md` now records the owner's statement to me that `auth` stays online during a
  rollback: in production, step 3 item 4 does not remove its deployment and step 5 is skipped.
  Which deployment it stays on is marked not decided.

## 2026-11-21: review round 1, plus three owner decisions

- Where production differs, production and staging are now separate branches, each with its own
  Check and Abort: runbook steps 1, 9 and 11; the comparison table; deploy guide step 7 (two
  labelled probe commands); `edge-check.md`; rollback step 3 item 4 and step 5.
- Owner: no service keys in the window. Steps 8a and 6a are replaced by a "no keys" paragraph.
  `log-only` is now a do-not-start precondition, and WhatsApp is out of the window (#336). On
  `origin/main`, `git grep -i whatsapp -- apps/api/src apps/api/lib` prints nothing; the same
  pattern matches `legacy/*/ansari-3-announce.md`, so it can match.
- Owner: in a production rollback, `auth` stays on step 10's deployment with its domain attached
  and auto-deploy off. Every not-decided marker is gone.
- `release-record.md` has a new dated owner-decision entry; the apply-record lines are untouched.
  `rehearsal.md` records the owner's statement that the rehearsal ran; its result rows stay blank.
- Tests: the new assertions fail 4 tests against the round-0 docs. The key-command scan has a
  planted command and a prose near-miss as controls.
- Flagged, not decided: `rollback.md`'s "If no second attempt follows within 7 days" drops the
  auth schema while production `auth` is still serving.

## 2026-11-21: review round 2 (parts 1 to 3, plus the owner's answer on auth's branch), one push

- Named procedure "Empty the production auth database: drop and re-apply", placed before step 1.
  Every production abort, the second attempt and the 7-day case use it by name; staging drops
  only. Its check is the journal check, the users-and-accounts count and JWKS 200, not /health.
  Read from the code:
  - /health runs `select 1` only;
  - boot.ts exits when `auth.apikey` is missing;
  - better-auth 1.7.7 reads the signing key from the DB on every sign and creates a key pair when
    `auth.jwks` is empty;
  - our code has no `.prepare(`, so no restart is needed after the re-apply. Redeploying once is
    the fallback.
- Owner: production `auth` deploys from `develop`, so step 10's push starts no `auth` deployment.
  Step 9 checks `git diff --quiet <auth running commit> HEAD -- apps/auth packages package.json
  pnpm-lock.yaml pnpm-workspace.yaml` (the toml's watch patterns, which are the Dockerfile's COPY
  sources). Step 16 switches `auth` to `main` first. In a rollback, `auth` is untouched.
- Fresh clone into a new empty directory; `clean-tree` runs in the opening block and again before
  step 5. Step 1 DB checks put production first. The release-record's key line is struck through
  as superseded, and the key scans cover every operator doc.
- Test path scan: a `<ref>:<path>` citation is skipped (step 7 cites `origin/main`-only files).
- Negative test: against the round-1 docs (c86a6694), 8 tests fail.
