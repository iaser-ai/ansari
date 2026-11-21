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
auto-deploy OFF on all three and return each to the deployment the window's step 1 recorded,
together (step 3). Off first, or the next push to the branch silently redeploys the rolled-back
code. Auto-deploy comes back only when the branch carries a revert PR or the forward fix (step
7): the revert PR is the follow-up, never the mechanism.

## 1. Maintenance mode on, web off

The window's step 3: `MAINTENANCE_MODE=true` on `backend`, and the web domain detached from the
web service (production: the legacy web service). The detach is what stops web traffic: legacy web
never asks `app-check`, so it ignores maintenance mode (the window's step 3 gives the evidence).

**Check:** step 3's `app-check` probe prints `true` on both `apps/api` domains, and the web domain
no longer serves the web app. **If it fails:** stop; nothing below is safe while new code serves
users.

## 2. Remove the post-cutover users

Their accounts have no legacy password, so the legacy code cannot sign them in. Dry run first,
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
   - **Production: `auth` stays on the window's deployment** (step 10's commit), domain
     attached (owner's decision, 2026-11-21). Do **not** remove it, and do **not** return it to
     the pre-window deployment step 1 recorded. Its auto-deploy is off (item 1), so nothing later
     moves it. The legacy `apps/api` that this step restores never calls `apps/auth`. A rollback
     before step 10 deployed anything (an abort from steps 3 to 9) leaves `auth` on its
     pre-window deployment, untouched.
   - **Staging, and any environment without that decision:** `auth`: back to its recorded state, **no active deployment**:
     remove the one step 10 started. On staging the PIR #59 deployment is not restored either:
     nothing the legacy code runs calls `apps/auth`.

**Check (production):** auto-deploy shows off on all three; `backend` and the web service are
healthy, each on the commit the release record holds for it; `auth`:
`curl -s -o /dev/null -w '%{http_code}' https://auth.askansari.ai/health` prints `200`, its
deployed commit is step 10's (the pre-window one if step 10 never deployed), and its auto-deploy
shows off like the others.
**Check (staging):** auto-deploy shows off on all three; `backend` and the web service are
healthy, each on the commit the release record holds for it; `auth` has no active deployment.

## 4. The web domain back

Re-attach the web domain, detached in step 1, to the **same** web service: in production the
legacy web service, the only web service there; on staging the staging web service. There is no
swap to reverse (backend-only release). Make sure that service runs the deployment whose **ID the
release record holds** (window step 1), redeploying that ID if anything else is live.

**Check:** the web domain serves legacy web (staging: the restored staging web service), and that
service's deployed commit equals the commit the release record holds for it.

## 5. Detach `auth.askansari.ai`

**Production: skip this step.** `auth` stays on the window's deployment with its domain attached
(owner's decision, 2026-11-21; step 3, item 4). **Check (production):** the domain is
still listed on the `auth` service, and step 3's production check passed.

**Staging, and any environment without that decision:** remove the public domain from the `auth` service. It was attached at window step 9 (spec H-5),
before anything deployed, so a rollback from any step from 9 on detaches it here; step 3 has
already put the previous `apps/api`, which never calls `apps/auth`, back in place. Leave the
service and its database as they are: they are evidence, and a second attempt starts by emptying
them. The auth database now holds every copied password hash: see "If no second attempt
follows" below.

**Check (staging):** `curl -s -o /dev/null -w '%{http_code}' https://auth.askansari.ai/health` no longer
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
back on for `backend`, the web service and `auth`. The revert is the follow-up; the rollback was
step 3.

**Service keys:** none. No `create-service` or `create-key` runs in the window (owner's decision,
2026-11-21), so a rollback has no service user or key to deal with.

## A second attempt (restart procedure)

The copy refuses a non-empty auth database. To try the window again: empty the auth database
(`DROP SCHEMA auth CASCADE`), then follow the window runbook from **step 5** (the auth
baseline) (**production, 2026-11-21:** after the drop every journal file is missing, so step 5's
`for` loop is run as printed, despite its early-apply note; reverse the apply record in
[`release-record.md`](release-record.md)), after its steps 1 to 4 (the preconditions, comms, maintenance and a new `cutover_at`,
the snapshots). The app window migration (`0011`) is already applied and is not re-run; its check
in step 7 still holds. **Step 10 of a second attempt** deploys the commit that carries the
cutover: if the branch still carries it (no revert yet), redeploy that commit on `auth`,
`backend` and the web service from the dashboard and turn auto-deploy back on; if a revert
landed, revert the revert through a PR and promote (or merge) as step 10 says.

## If no second attempt follows within 7 days

The auth database holds a copy of every user's password hash. If no second attempt starts within
7 days of the rollback, empty it, from the operator environment:

```bash
psql "$AUTH_DATABASE_URL" -X -v ON_ERROR_STOP=1 -c 'DROP SCHEMA auth CASCADE'
```

**Check:** `psql "$AUTH_DATABASE_URL" -X -At -c "select count(*) from information_schema.schemata where schema_name = 'auth'"`
prints `0`. Record the date and who ran it. A later attempt starts from the window's step 5.
**Production, 2026-11-21:** that attempt runs step 5's `for` loop as printed (the journal is gone
with the schema), and the apply record in [`release-record.md`](release-record.md) is reversed.
