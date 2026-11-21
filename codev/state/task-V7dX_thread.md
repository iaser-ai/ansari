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
