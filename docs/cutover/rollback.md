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
window detaches its domain and re-attaches it to the same service, and swaps nothing. So this
rollback has no web swap to reverse. It detaches the web domain in step 1 and re-attaches it to
the same web service in step 4, as the window does.

**The mechanism (main, M2).** Auto-deploy is on for `backend`, the web service and `auth`
(owner decision, 2026-10-19), so a rollback is **one step in the Railway dashboard**: turn
auto-deploy OFF on all three and return `backend` and the web service to the deployments the
window's step 1 recorded, together (step 3). **Production `auth` is not a rollback target**: window step
10 never deployed it (it deploys from `develop`; owner's statement, 2026-11-21), so it stays on
the deployment it had all along, with auto-deploy off for the rollback's duration. Its recorded
ID is for the record. On staging, `auth` returns to its recorded state too. Off first, or the next push to the branch silently redeploys the rolled-back
code. Auto-deploy comes back only when the branch carries a revert PR or the forward fix (step
7): the revert PR is the follow-up, never the mechanism.

## 1. Maintenance mode on, web off

The window's step 3: `MAINTENANCE_MODE=true` on `backend`, and the web domain detached from the
web service (production: the legacy web service). The detach is what stops web traffic: legacy web
never asks `app-check`, so it ignores maintenance mode (the window's step 3 gives the evidence).

**Check:** the window's step 3 `app-check` probe prints `true` on both `apps/api` domains, and the web domain
no longer serves the web app. **If it fails:** stop; nothing below is safe while new code serves
users.

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
3. The web service: its recorded ID → **Redeploy**, if it is not already the live deployment
   (on staging, the staging web service; in production, the legacy web service, which the window
   changes only if the push rebuilt it).
4. `auth`, by environment:
   - **Production: `auth` is untouched.** Window step 10 starts no `auth` deployment (it deploys from
     `develop`; owner's statement, 2026-11-21), so `auth` stays on the deployment it had all
     along: the one window step 9 checked (window step 1's, unless window step 9 had it redeployed at the
     promoted commit), with its domain attached (owner's decision). Do **not** remove or redeploy
     it. Its auto-deploy is off for the rollback's duration (item 1), so a push to `develop` cannot
     move it. The legacy `apps/api` that this step restores never calls `apps/auth`.
     **After window step 16's switch to `main`:** `auth` runs the deployment window step 16 recorded
     (its check: the deployed commit equalled `origin/main` at that time). With its auto-deploy off
     it stays there, and a later push to `main` (a revert, say) does not reach it. `origin/main` before the promotion has no
     `apps/auth/Dockerfile`, so do not turn `auth`'s auto-deploy back on for a revert of the
     promotion: tell the security architect.
   - **Staging, and any environment without that decision:** `auth`: back to its recorded state, **no active deployment**:
     remove the one window step 10 started. On staging the PIR #59 deployment is not restored either:
     nothing the legacy code runs calls `apps/auth`.

**Check (production):** auto-deploy shows off on all three; `backend` and the web service are
healthy, each on the commit the release record holds for it; `auth`:
`curl -s -o /dev/null -w '%{http_code}' https://auth.askansari.ai/health` and
`curl -s -o /dev/null -w '%{http_code}' https://auth.askansari.ai/api/auth/jwks` print `200`, its
deployment is the one window step 9 checked (or, after window step 16, the deployment window step 16 recorded), and its
auto-deploy shows off like the others.
**Check (staging):** auto-deploy shows off on all three; `backend` and the web service are
healthy, each on the commit the release record holds for it; `auth` has no active deployment.

## 4. The web domain back

Re-attach the web domain, detached in step 1, to the **same** web service: in production the
legacy web service, the only web service there; on staging the staging web service. There is no
swap to reverse (backend-only release). Make sure that service runs the deployment whose **ID the
release record holds** (window step 1), redeploying that ID if anything else is live.

**Check:** the web domain serves legacy web (staging: the restored staging web service), and that
service's deployed commit equals the commit the release record holds for it.

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
- **Rollback before window step 16:** `auth` is still on its `develop` deployment, the one window
  step 9 checked. Its auto-deploy stays off until the security architect says otherwise, so
  `develop` need not stay frozen for it.
- **Rollback after window step 16:** `auth` is on the `main` deployment window step 16 recorded, with
  auto-deploy off.

**Service keys:** none. No `create-service` or `create-key` runs in the window (owner's decision,
2026-11-21), so a rollback has no service user or key to deal with.

## A second attempt (restart procedure)

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
