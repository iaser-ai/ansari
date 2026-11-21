# Better Auth cutover: rollback (spec 300)

**Valid until `cutover_at` + 24 hours** (both are in the window's release record). After the
deadline, do **not** roll back: fix forward on `develop`.

Rollback is a **redeploy, not a restore**. The window dropped nothing the legacy code reads
(`password_hash`, `is_admin`, `session_version` and `tokens` all stay until the contract PR), so
the previous `apps/api` runs on the app database as it now is. The app database snapshot from
the window's step 4 exists for a disaster, not for this procedure.

**Costs the owner accepted:** a password changed at `apps/auth` after the cutover reverts to the
legacy one (that user resets again), and accounts created after the cutover are removed, with
their threads. **Every client that signed in during the window is signed out once:** it holds an
`apps/auth` session token and JWT, which the legacy code rejects (its first call is a 401, and
its refresh is refused), so the released mobile app clears its tokens and the user signs in again
with the legacy password. Step 6 checks one such client.

**Production `auth` stays online, so step 2 cleans the app database only.** Step 2 deletes the
post-cutover users' `public.users` rows (and their threads) from the **app** database. Their
`auth.users` rows, sessions and credentials stay in the **auth** database until it is emptied (a
second attempt, or "If no second attempt follows" below, both by
[Empty the production auth database: drop and re-apply](better-auth-cutover.md#empty-the-production-auth-database-drop-and-re-apply)). Until then such an account can still sign in
at `auth.askansari.ai` directly and get a JWT. The restored legacy `apps/api` rejects that JWT: it
verifies only HS256 tokens signed with `JWT_SECRET`
(`origin/main:apps/api/lib/auth/jwt.ts:47-48`, called from
`origin/main:apps/api/lib/auth/middleware.ts`'s `authenticateRequest`), and `apps/auth` signs
EdDSA. So it reaches no thread and no answer.

Each step: what to run, the mechanical **check**, and what to do if it fails. Database steps run
from the window runbook's operator environment (spec H-8): the owner's machine over the Tailscale
route, a checkout of the deployed commit, and both URLs entered with `read -rs` for that
session only.

**A backend-only release (owner, 2026-11-21; #416).** Production web is legacy web throughout: the
window takes it offline with the legacy web service's own `MAINTENANCE_MODE` (PR #418) and brings
it back on the same service, and swaps nothing. So this rollback has no web swap to reverse. In
production it sets that flag `true` in step 1 and `false` in step 4, as the window does; the web
domain stays attached. On staging (`apps/frontend`, no switch, #419) it detaches the web domain in
step 1 and re-attaches it to the same web service in step 4.

**The mechanism (main, M2).** Auto-deploy is on for `backend`, the web service and `auth`
(owner decision, 2026-10-19), so a rollback is **one step in the Railway dashboard**: turn
auto-deploy OFF on all three and return `backend` to the deployment the window's step 1
recorded (step 3). **In production only `backend` returns:** legacy web stays on the maintenance
build until step 4 builds it again with the flag off, and its recorded deployment ID is kept as the
record of the pre-window build, and as step 4's last option (c). On staging, `backend` and the web
service return to their recorded deployments together (step 3). **Production `auth` is not a rollback target**: window step
10 never deployed it (it deploys from `develop`; owner's statement, 2026-11-21), so it stays on
the deployment it had all along, with auto-deploy off for the rollback's duration. Its recorded
ID is for the record. On staging, `auth` returns to its recorded state too. Off first, or the next push to the branch silently redeploys the rolled-back
code. Auto-deploy comes back only when the branch carries a revert PR or the forward fix (step
7): the revert PR is the follow-up, never the mechanism.

## 1. Maintenance mode on, web off

The window's step 3: `MAINTENANCE_MODE=true` on `backend`, and web offline. `backend`'s flag only
changes the `app-check` answer, and legacy web never asks it (the window's step 3 gives the
evidence), so web needs its own action:
- **Production:** `MAINTENANCE_MODE=true` on the legacy web service (its service variable; it is
  already `true` if the rollback starts before window step 13). The name is `MAINTENANCE_MODE`,
  the value `true` with no quotes: an `EXPO_PUBLIC_MAINTENANCE_MODE` on the service has no effect
  (`legacy/frontend-web/Dockerfile:18,30`), and a quoted `"true"` is OFF. It is baked in at build time: web
  is offline only once that rebuild is live, and until then legacy web keeps serving the public on
  the new code. A tab loaded before then keeps working against the api until reloaded (the
  window's step 3 residual).
- **Staging:** the web domain detached from the staging web service.

**Check:** the window's step 3 `app-check` probe prints `true` on both `apps/api` domains.
Production: the window's step 3 ON check (define the three functions there in this session)
prints `web-flag-ON` (nothing printed is not ON: stop), and a fresh private window on the
web domain shows the maintenance screen. Staging: the web domain no longer serves the web app.
**If it fails:** stop; nothing below is safe while new code serves users. A web rebuild that fails
leaves the previous deployment serving: if that is the live app, tell the security architect at
once.

## 2. Remove the post-cutover users

Their accounts have no legacy password, so the legacy code cannot sign them in. This removes
their **app** rows only; in production their auth rows stay (see the start of this page). Dry run first,
with `cutover_at` from the release record:

```bash
psql "$APP_DATABASE_URL" -X -v ON_ERROR_STOP=1 -v cutover_at='<cutover_at>' -f apps/auth/scripts/cutover/rollback-remove-post-cutover-users.sql
```

Read the count (`post_cutover_users`), record it, then delete:

```bash
psql "$APP_DATABASE_URL" -X -v ON_ERROR_STOP=1 -v cutover_at='<cutover_at>' -v confirm=yes -f apps/auth/scripts/cutover/rollback-remove-post-cutover-users.sql
```

**Check:** re-running the dry run prints `0`. System accounts are never removed (the script
excludes them). **If it fails:** the delete runs in one transaction, so nothing changed; fix
the cause (usually `cutover_at` missing or malformed) and repeat.

## 3. Auto-deploy off, and the recorded deployments back (one step)

In the Railway dashboard, for `backend`, the web service and `auth`, in this order and without a
push in between:
1. **Turn auto-deploy OFF** on all three.
2. `backend`: Deployments → the deployment whose **ID the release record holds** (window step 1)
   → **Redeploy**. Never pick it by eye: by now the list has new entries. It boots only with its
   legacy variables, which the window's preconditions keep on `backend` until the contract PR
   (`JWT_SECRET`, `ACCESS_TOKEN_EXPIRY_HOURS`, `REFRESH_TOKEN_EXPIRY_HOURS`, `ADMIN_EMAILS`,
   `RESEND_API_KEY`, `FRONTEND_URL`):
   confirm they are set first.
3. The web service, by environment:
   - **Production: do not redeploy the recorded ID.** It was built with the flag off (window step
     1), so redeploying it would put legacy web back in front of the public, on whatever api is
     serving, before step 4. Leave the maintenance build of step 1 serving; step 4 turns the flag
     off. Its sources are the recorded ones: `legacy/frontend-web` is identical on both sides of
     the promotion.
   - **Staging:** the staging web service's recorded ID → **Redeploy**, if it is not already the
     live deployment.
4. `auth`, by environment:
   - **Production: `auth` is untouched.** Window step 10 starts no `auth` deployment (it deploys from
     `develop`; owner's statement, 2026-11-21), so `auth` stays on the deployment it had all
     along: the one window step 9 checked (window step 1's, unless window step 9 had it redeployed at the
     promoted commit), with its domain attached (owner's decision). Do **not** remove or redeploy
     it. The legacy `apps/api` that this step restores never calls `apps/auth`.
     Its state is one of window step 16's three, and the rollback leaves it there in each:
     - **(a) Not switched** (a rollback before window step 16, or before its switch): the
       `develop` deployment window step 9 checked; source `develop`.
     - **(b) Switched, new deployment Active:** the deployment window step 16 recorded; source
       `main`.
     - **(c) Switched, build failed:** still the window step 9 deployment; source now `main`.

     In each, auto-deploy is off (item 1), so no push to `develop` or `main` moves it.
     `origin/main` before the promotion has no `apps/auth/Dockerfile`: never turn `auth`'s
     auto-deploy back on for a revert of the promotion; tell the security architect.
   - **Staging, and any environment without that decision:** `auth`: back to its recorded state, **no active deployment**:
     remove the one window step 10 started. On staging the PIR #59 deployment is not restored either:
     nothing the legacy code runs calls `apps/auth`.

**Check (production):** auto-deploy shows off on all three; `backend` is healthy, on the commit
the release record holds for it; the legacy web service is healthy and still serves the
maintenance build (the window's step 3 ON check prints `web-flag-ON`), on the commit the release record holds
for it or step 10's; `auth`:
`curl -s -o /dev/null -w '%{http_code}' https://auth.askansari.ai/health` and
`curl -s -o /dev/null -w '%{http_code}' https://auth.askansari.ai/api/auth/jwks` print `200`, its
auto-deploy shows off like the others, and by the state the release record names:
- **(a) or (c):** its deployment ID is window step 9's, and in the window checkout
  `git diff --quiet <auth running commit> HEAD -- apps/auth packages package.json pnpm-lock.yaml pnpm-workspace.yaml && echo auth-tree-matches` prints `auth-tree-matches`;
- **(b):** its deployment ID is the one window step 16 recorded, and its deployed commit equals the
  recorded promoted commit.

**Check (staging):** auto-deploy shows off on all three; `backend` and the web service are
healthy, each on the commit the release record holds for it; `auth` has no active deployment.

## 4. Web back

There is no swap to reverse (backend-only release).
- **Production:** `MAINTENANCE_MODE=false` on the legacy web service, the only web service there.
  Whether a variable change starts a deployment while auto-deploy is off is not established
  (dashboard behaviour). So bring web back by the first of these that works, in order. The proof
  for each is the window's step 3 **OFF check**, `web_flag_off https://<web domain>`, printing
  `web-flag-OFF`:
  - **(a)** the deployment the variable change starts itself;
  - **(b)** if no deployment starts, the dashboard's deploy of the service's latest commit;
  - **(c)** if that fails, or the check still does not print `web-flag-OFF`, the recorded
    pre-window web deployment (window step 1's ID) → **Redeploy**. It was built with the flag off.
    Then make sure the variable is `false`, so it matches. Tell the security architect when (c) is
    needed.

  The failure mode of all three is web staying on the maintenance build, which is safe: the screen
  makes no api request. The public sees legacy web, now on the legacy `apps/api`, once a deployment
  that passes the OFF check is live.
- **Staging:** re-attach the web domain, detached in step 1, to the **same** staging web service.
  Make sure that service runs the deployment whose **ID the release record holds** (window step
  1), redeploying that ID if anything else is live.

**Check:** production: the window's step 3 OFF check prints `web-flag-OFF`, a fresh private
window on the web domain shows legacy web's app, and the deployed commit is the one the release
record holds for the service or step 10's (`git diff --quiet <recorded web commit> <deployed web commit> -- legacy/frontend-web && echo web-sources-match`
prints `web-sources-match`); record the new deployment's ID. Staging: the web domain serves the
restored staging web service, and its deployed commit equals the commit the release record holds
for it.

## 5. Detach the auth domain (staging)

**Production: skip this step.** `auth` is untouched and keeps its domain attached
(owner's decision, 2026-11-21; step 3, item 4). **Check (production):** the domain is
still listed on the `auth` service, and step 3's production check passed.

**Staging, and any environment without that decision:** remove the public domain from the `auth` service. It was attached at window step 9 (spec H-5),
before anything deployed, so a rollback from any step from 9 on detaches it here; step 3 has
already put the previous `apps/api`, which never calls `apps/auth`, back in place. Leave the
service and its database as they are: they are evidence, and a second attempt starts by emptying
them. The auth database now holds every copied password hash: see "If no second attempt
follows" below.

**Check (staging):** `curl -s -o /dev/null -w '%{http_code}' https://auth-staging.askansari.ai/health` no longer
returns 200.

## 6. Maintenance off, and a legacy login

`MAINTENANCE_MODE=false` on `backend`. With a migrated account:

```bash
curl -s https://api.askansari.ai/api/v2/users/login -H 'Content-Type: application/json' \
  -d '{"email":"<migrated account>","password":"<its legacy password>"}' | jq -r .access_token
```

**Check:** an access token is returned, and `/api/v2/threads` with it returns 200 with the
account's threads. A released mobile build signs in. **One client signed in during the window**
(a released mobile build that signed in after window step 15) is signed out on its next call or
refresh, and signs in again with the legacy password.

## 7. Record it, and the follow-up

In the release record: the time, the dry-run count, who decided, and why. Un-silence alerts.
The branch still carries the cutover commit (`main` in production, `develop` on staging), and
auto-deploy stays off until it carries a **revert PR** or the forward fix: then turn auto-deploy
back on for `backend` and the web service (staging: and `auth`). The revert is the follow-up; the
rollback was step 3.

**Production `auth` after a rollback: its auto-deploy stays off until the security architect says
otherwise.** A reverted `main` has no `apps/auth/Dockerfile`. Any other new code would be code the
window never ran, deployed onto an auth database that holds every migrated hash. Its disposition:
- **State (a), not switched:** `auth` is on its `develop` deployment (window step 9's); source
  `develop`.
- **State (b), switched and Active:** `auth` is on the deployment window step 16 recorded; source
  `main`.
- **State (c), switched but the build failed:** `auth` is still on window step 9's deployment;
  source `main`.

In all three its auto-deploy stays off until the security architect says otherwise, so neither
`develop` nor `main` needs to stay frozen for it.

**Service keys:** none. No `create-service` or `create-key` runs in the window (owner's decision,
2026-11-21), so a rollback has no service user or key to deal with.

## A second attempt (restart procedure)

**Production overrides (the runbook's step 1 `auth` deploy-source line describes the first
attempt).** After a rollback, production `auth` is in state (a), (b) or (c) with auto-deploy
**off**. A second attempt keeps it that way:
- **Source branch and auto-deploy before the second attempt:** as the rollback left them. Whether
  the source is `develop` or `main`, auto-deploy stays **off** through the second window, so
  nothing moves `auth` during it. The `develop` freeze is then not needed for `auth`.
- **Step 1** records that state (source, auto-deploy off, the deployment ID and its commit as
  `<auth running commit>`) in place of the first attempt's line.
- **Step 9's tree check** runs as written against that `<auth running commit>`. If it does not
  print `auth-tree-matches`, the owner deploys `auth` at the promoted commit from the dashboard (a
  manual deploy works with auto-deploy off), records the new ID and commit, and the check is
  re-run.
- **Step 16** then brings `auth` to state (b) as written, and the owner turns `auth`'s auto-deploy
  back on **only on the security architect's word**.
- **Who restores anything:** the owner, on the security architect's word. Nothing is restored by
  default.

The copy refuses a non-empty auth database. To try the window again: empty the auth database
(**production:** [Empty the production auth database: drop and re-apply](better-auth-cutover.md#empty-the-production-auth-database-drop-and-re-apply); the apply record stays true, and step 5
then runs as **check only**. **Staging:** `DROP SCHEMA auth CASCADE`), then follow the window
runbook from **step 5** (the auth
baseline), after its steps 1 to 4 (the preconditions, comms, maintenance and a new `cutover_at`,
the snapshots). The app window migration (`0011`) is already applied and is not re-run; its check
in step 7 still holds. **Step 10 of a second attempt** deploys the commit that carries the
cutover: if the branch still carries it (no revert yet), redeploy that commit on `backend` (on
staging also `auth` and the staging web service; production `auth` is not redeployed, window step 9
checks it) from the dashboard, and turn auto-deploy back on for `backend` and the web service
(staging: and `auth`; production `auth`'s stays off until the security architect says otherwise); if a revert
landed, revert the revert through a PR and promote (or merge) as window step 10 says.

## If no second attempt follows within 7 days

The auth database holds a copy of every user's password hash. If no second attempt starts within
7 days of the rollback, empty it, from the operator environment (the window runbook's: the owner's
machine, the Tailscale forwarder, which window step 16 removes (set it up again if it was removed), and a
checkout of the promoted commit, whose code window step 9 checked `auth` runs).

### Production: drop, then re-apply the auth journal (owner's decision, 2026-11-21)

`auth` stays online after a production rollback (step 3, item 4), so run the window runbook's
[Empty the production auth database: drop and re-apply](better-auth-cutover.md#empty-the-production-auth-database-drop-and-re-apply): the drop and
the whole auth journal, in one transaction. `auth` then returns to its state of 2026-11-21: the schema
applied, zero users, serving.

**Check (production):** the procedure's own check: the journal check prints `<tag>|t` for every
file `files` lists, in order; the users-and-accounts count prints `0`; the JWKS probe prints
`200` (not `/health`: it answers `200` with no schema). The apply record in
[`release-record.md`](release-record.md) **stays true**, because the schema is applied again: do
not reverse it. Add a dated entry: the drop, the re-apply, the commit and the check's output.
Record the date and who ran it.

### Staging, and any environment without that decision: drop only

```bash
psql "$AUTH_DATABASE_URL" -X -v ON_ERROR_STOP=1 -c 'DROP SCHEMA auth CASCADE'
```

**Check:** `psql "$AUTH_DATABASE_URL" -X -At -c "select count(*) from information_schema.schemata where schema_name = 'auth'"`
prints `0`. Record the date and who ran it. A later attempt starts from the window's step 5.
