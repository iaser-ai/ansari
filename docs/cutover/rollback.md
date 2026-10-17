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
route, the promoted commit's clean checkout, and both URLs entered with `read -rs` for that
session only.

## 1. `apps/api` offline

By the same mechanism as the window's step 3. Turn auto-deploy off for `backend` and the web
service if it was re-enabled.

**Check:** `https://api.askansari.ai/api/health` and `https://api-35.ansari.chat/api/health` return
the offline response. **If it fails:** stop; nothing below is safe while new code still serves.

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

## 3. Redeploy the previous `apps/api` and `apps/frontend`

The previous `apps/api` boots only with its legacy variables, which the window's preconditions
keep on `backend` until the contract PR: `JWT_SECRET`, `ACCESS_TOKEN_EXPIRY_HOURS`,
`REFRESH_TOKEN_EXPIRY_HOURS` and `ADMIN_EMAILS`. Confirm they are set, then: Railway dashboard →
`backend` → Deployments → the deployment whose **ID the release record holds** (window step 1)
→ **Redeploy**. Never pick it by eye: by now the list has new entries.
Do the same for the web service, with its recorded ID, only if `apps/frontend` was serving web
before the window. On staging it was, so the staging web service's recorded ID is redeployed
here.

**Check:** each redeployed service is healthy, and its deployed commit equals the commit the
release record holds for it.

## 4. Restore the previous legacy web deployment

Move the web domain back from the `apps/frontend` web service to the legacy web service (the
reverse of the window's step 16). Then make sure the legacy web service runs the deployment
whose **ID the release record holds** (window step 1), redeploying that ID if anything else is
live. (On staging there is no legacy web; step 3 already restored the web service.)

**Check:** the web domain serves legacy web, and the legacy web service's deployed commit equals
the commit the release record holds for it.

## 5. Detach `auth.askansari.ai`

Remove the public domain from the `auth` service. It was attached at window step 11 (spec H-5),
before `apps/api` deployed, so a rollback from any step from 11 on detaches it here; step 3 has
already put the previous `apps/api`, which never calls `apps/auth`, back in place. Leave the
service and its database as they are (stopped is fine): they are evidence, and a second attempt
starts by emptying them. The auth
database now holds every copied password hash: see "If no second attempt follows" below.

**Check:** `curl -s -o /dev/null -w '%{http_code}' https://auth.askansari.ai/health` no longer
returns 200.

## 6. Smoke-test a legacy login

Re-attach `apps/api`'s domains (undo step 1). With a migrated account:

```bash
curl -s https://api.askansari.ai/api/v2/users/login -H 'Content-Type: application/json' \
  -d '{"email":"<migrated account>","password":"<its legacy password>"}' | jq -r .access_token
```

**Check:** an access token is returned, and `/api/v2/threads` with it returns 200 with the
account's threads. A released mobile build signs in. **One client signed in during the window**
(a released mobile build that signed in after step 13) is signed out on its next call or refresh,
and signs in again with the legacy password.

## 7. Record it

In the release record: the time, the dry-run count, who decided, and why. Un-silence alerts.
`main` still holds the cutover commit: revert the promotion on `develop` and promote that before
re-enabling auto-deploy, so nothing redeploys the cutover code.

## A second attempt (restart procedure)

The copy refuses a non-empty auth database. To try the window again: empty the auth database
(`DROP SCHEMA auth CASCADE`), then follow the window runbook from **step 7** (the auth
baseline). The app window migration (`0011`) is already applied and is not re-run; its check in
step 9 still holds.

## If no second attempt follows within 7 days

The auth database holds a copy of every user's password hash. If no second attempt starts within
7 days of the rollback, empty it, from the operator environment:

```bash
psql "$AUTH_DATABASE_URL" -X -v ON_ERROR_STOP=1 -c 'DROP SCHEMA auth CASCADE'
```

**Check:** `psql "$AUTH_DATABASE_URL" -X -At -c "select count(*) from information_schema.schemata where schema_name = 'auth'"`
prints `0`. Record the date and who ran it. A later attempt starts from the window's step 7.
