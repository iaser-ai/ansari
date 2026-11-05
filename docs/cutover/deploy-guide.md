# Cutover deployment guide (spec 300)

The commands only, in order. The full runbook, [`better-auth-cutover.md`](better-auth-cutover.md),
is the authority: it has the reason, the check and the abort for every step. If any check fails
after step 2, stop and follow [`rollback.md`](rollback.md) (valid until `CUTOVER_AT` + 24 hours).

Auto-deploy stays **on** throughout. The merge in step 8 is the deploy.

The three Railway services, by their dashboard names:

| Service | Runs | Domain (production) |
|---|---|---|
| `backend` | the api (`apps/api`) | `api.askansari.ai`, `api-35.ansari.chat` |
| `auth` | the auth service (`apps/auth`) | `auth.askansari.ai` (attached in step 7) |
| the web service | the web app (`apps/frontend`) | the web domain |

## Before the day (Railway dashboard)

All of these are set before step 2. Auto-deploy is on, so the merge in step 8 deploys whatever
is set at that point. In Railway, applying a variable change **redeploys** the service's current
deployment, so the `backend` edits restart the legacy api: make them at a quiet hour the day
before, and check that `backend` is healthy afterwards. Production values are shown; for staging, use the staging domains.

- **`backend`: add** the four variables below. The new code does not start in production
  without them.

  | Variable | Value |
  |---|---|
  | `AUTH_URL` | `https://auth.askansari.ai` |
  | `AUTH_JWT_ISSUER` | `https://auth.askansari.ai` (set on its own) |
  | `AUTH_JWT_AUDIENCE` | `ansari-api` (the same as on `auth`) |
  | `AUTH_LAYER_ORIGIN` | `https://api.askansari.ai` (the same as on `auth`) |

  Also on `backend`: `MAINTENANCE_MODE=false`. **Keep** `JWT_SECRET`,
  `ACCESS_TOKEN_EXPIRY_HOURS`, `REFRESH_TOKEN_EXPIRY_HOURS`, `ADMIN_EMAILS`, `RESEND_API_KEY` and
  `FRONTEND_URL`. The new code ignores them, but the legacy code that serves until step 8 and
  that a rollback redeploys needs them. They are removed in the contract PR, not now.
- **`auth`: set**

  | Variable | Value |
  |---|---|
  | `DATABASE_URL` | the auth database (Railway reference variable) |
  | `BETTER_AUTH_SECRET` | a new random secret, at least 32 characters |
  | `BETTER_AUTH_URL` | `https://auth.askansari.ai` |
  | `AUTH_JWT_ISSUER` | `https://auth.askansari.ai` |
  | `AUTH_JWT_AUDIENCE` | `ansari-api` |
  | `AUTH_LAYER_ORIGIN` | `https://api.askansari.ai` |
  | `CORS_ORIGIN` | the `apps/frontend` web origins |
  | `RESEND_API_KEY` | the Resend key (reset emails are now sent by `auth`) |
  | `FRONTEND_URL` | the web origin (reset links point here) |
  | `NODE_ENV` | `production` |
  | `PORT` | `3100` |

  Optional on `auth`: `SENTRY_DSN`, and `MARKETMAKER_URL` (copy `backend`'s value if it has
  one). Do **not** set `ADMIN_EMAILS` on it. The service has **no domain and no active deployment** (staging: remove the PIR #59 deployment).
- **The web service: set** `EXPO_PUBLIC_API_URL=https://api.askansari.ai` and
  `EXPO_PUBLIC_AUTH_URL=https://auth.askansari.ai`.
- The auth domain's DNS record exists and is not attached to any service.
- The Tailscale forwarder: port 5432 to the app database, port 5433 to the auth database.
- In the release record: the current deployment ID and commit of `backend`, the web service and
  `auth` (`none` if it has no deployment). These are the rollback targets.
- The admin list is approved, #307 and #317 are merged, and the cutover PR is approved and
  current with `develop`.

## 1. Open the operator session

```bash
tailscale status                                   # the forwarder is listed
cd <repo>                                          # the builder-spir-300 worktree, at the commit being deployed
set +o history
export CUTOVER_ENV=production                      # or staging
read -rs APP_DATABASE_URL && export APP_DATABASE_URL     # paste at the prompt
read -rs AUTH_DATABASE_URL && export AUTH_DATABASE_URL
export API=https://api.askansari.ai AUTH=https://auth.askansari.ai   # staging: api-staging / auth-staging
```

Tell the builder before you start: it makes no edits and no git operations in that worktree until
the window ends. Keep the worktree until the production cutover is done; if it is gone, use a
fresh checkout of `develop` at the commit being promoted.

**Both database URLs must go through the Tailscale forwarder, or the scripts reject them.**
Railway's own URLs will not work. The scripts refuse `DATABASE_URL` (`*.railway.internal`, which
resolves only inside Railway), `DATABASE_PUBLIC_URL` (`*.proxy.rlwy.net`), an IP, and any other
host. Build each URL from the database's `PGPASSWORD` and `PGDATABASE` (its Variables tab in
Railway) and the forwarder's name, as `tailscale status` lists it:

```
postgresql://postgres:<app PGPASSWORD>@<project>-<environment>-tailscale-forwarder:5432/railway?sslmode=require
postgresql://postgres:<auth PGPASSWORD>@<project>-<environment>-tailscale-forwarder:5433/railway?sslmode=require
```

- Both URLs use the **same** forwarder host. Port `5432` is the app database and port `5433` is
  the auth database.
- `<environment>` must match `CUTOVER_ENV`, so a staging URL is refused in a production run.
- If Postgres refuses TLS on this path, drop `?sslmode=require`. The scripts then print a warning,
  which is expected.

Both databases are on Postgres 18, and they are two different clusters. The auth database is empty:

```bash
psql "$APP_DATABASE_URL" -X -At -c "select version()"     # PostgreSQL 18
psql "$AUTH_DATABASE_URL" -X -At -c "select version()"    # PostgreSQL 18
psql "$APP_DATABASE_URL" -X -At -c "select system_identifier from pg_control_system()"
psql "$AUTH_DATABASE_URL" -X -At -c "select system_identifier from pg_control_system()"   # a different number
psql "$AUTH_DATABASE_URL" -X -At -c "select count(*) from information_schema.tables where table_schema not in ('pg_catalog','information_schema')"   # 0
```

## 2. Go offline

Post the notice and silence alerts. In Railway, set `MAINTENANCE_MODE=true` on `backend` and
detach the web domain from the web service. Then:

```bash
export CUTOVER_AT="$(psql "$APP_DATABASE_URL" -X -At -c "select now()")"
echo "$CUTOVER_AT"                                 # into the release record
curl -s $API/api/v2/app-check -H 'Content-Type: application/json' -d '{"platform":"ios","native_application_version":"1.0.0","native_build_version":"1"}' | jq .maintenance_mode   # true
```

`MAINTENANCE_MODE` takes effect only once Railway's redeploy of `backend` is healthy, so the probe
prints `false` until then: wait and re-run it, that is not a failure. In production, also run the
probe on `https://api-35.ansari.chat`. Take a Railway snapshot of
both databases and record their ids.

## 3. Auth schema

```bash
for f in $(node apps/auth/scripts/cutover/auth-journal.mjs files); do psql "$AUTH_DATABASE_URL" -X -v ON_ERROR_STOP=1 --single-transaction -f "$f" || break; done
set -o pipefail
node apps/auth/scripts/cutover/auth-journal.mjs check | psql "$AUTH_DATABASE_URL" -X -q -At -v ON_ERROR_STOP=1   # one <tag>|t per file, in order; no output at all is a failure
```

## 4. Copy the users

```bash
psql "$APP_DATABASE_URL" -X -v ON_ERROR_STOP=1 -f apps/auth/scripts/cutover/00-preflight-app.sql   # no collision, not_bcrypt = 0
apps/auth/scripts/cutover/copy.sh                  # copy.sh: audit OK
```

## 5. App schema

Skip any file the release record says is already applied.

```bash
psql "$APP_DATABASE_URL" -X -v ON_ERROR_STOP=1 --single-transaction -f apps/api/drizzle/0009_better_auth_scaffold_cleanup.sql
psql "$APP_DATABASE_URL" -X -v ON_ERROR_STOP=1 --single-transaction -f apps/api/drizzle/0010_deleted_users.sql
psql "$APP_DATABASE_URL" -X -v ON_ERROR_STOP=1 --single-transaction -f apps/api/drizzle/0011_better_auth_window.sql
psql "$APP_DATABASE_URL" -X -At -c "select count(*) from users where email <> lower(trim(email))"   # 0
```

## 6. Admin roles

For each approved address, show the account first, then grant it by its id:

```bash
(cd apps/auth && DATABASE_URL="$AUTH_DATABASE_URL" pnpm exec tsx scripts/grant-admin.ts <email>)
(cd apps/auth && DATABASE_URL="$AUTH_DATABASE_URL" pnpm exec tsx scripts/grant-admin.ts <email> --confirm <id>)
psql "$AUTH_DATABASE_URL" -X -q -v ON_ERROR_STOP=1 -f apps/auth/scripts/cutover/05-audit-admins-auth.sql   # exactly the approved list
```

If the first command prints a warning (a recent or unverified account), confirm with the person
before you run `--confirm`.

## 7. Attach the auth domain

In Railway, attach the auth domain to the `auth` service on port 3100. Then:

```bash
curl -s -o /dev/null -w '%{http_code}' $AUTH/health   # 404 or 502; never 200, never 000
```

## 8. Deploy: merge

- **Staging:** merge the cutover PR into `develop`.
- **Production:** promote `develop` to `main`. The push goes straight to `main`, which requires a
  PR for everyone but admins, so only an **admin** can run it (as in `RELEASE.md`'s promotion):

```bash
git fetch origin && [ "$(git rev-parse origin/develop)" = "$(git rev-parse HEAD)" ] && echo develop-unchanged   # production, before the push
git fetch origin && git push origin origin/develop:main          # production
git fetch origin && git diff-tree --quiet HEAD origin/main && echo same-tree   # origin/develop on staging
```

Auto-deploy builds `auth`, `backend` and the web service. Wait until all three are healthy.

## 9. Verify

```bash
curl -fsS $AUTH/health
curl -fsS $AUTH/api/auth/jwks | jq '.keys | length'                                   # 1 or more
curl -s -o /dev/null -w '%{http_code}' $AUTH/api/account/me                           # 401
```

- Run the edge probes in [`edge-check.md`](edge-check.md).
- Attach the web domain to the `apps/frontend` web service.
- In a private window, run the smoke test: guest, sign up, sign out, sign in, ask a question,
  reset the password from the email, and delete the account.

## 10. Back online

In Railway, set `MAINTENANCE_MODE=false` on `backend`. Then:

```bash
curl -s $API/api/v2/app-check -H 'Content-Type: application/json' -d '{"platform":"ios","native_application_version":"1.0.0","native_build_version":"1"}' | jq .maintenance_mode   # false
```

- Relaunch a released mobile build and sign in.
- Un-silence the alerts and close the release record.
- Remove the Tailscale forwarder and revoke its key.
- `exit` the shell.
