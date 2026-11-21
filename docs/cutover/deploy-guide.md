# Cutover deployment guide (spec 300)

The commands only, in order. The full runbook, [`better-auth-cutover.md`](better-auth-cutover.md),
is the authority: it has the reason, the check and the abort for every step. If any check fails
after step 2, stop and follow [`rollback.md`](rollback.md) (valid until `CUTOVER_AT` + 24 hours).

Auto-deploy stays **on** throughout. The merge in step 8 is the deploy.

**A backend-only release (owner, 2026-11-21; #416).** The window releases `apps/api` and
`apps/auth`. Production web stays on legacy web (`legacy/frontend-web`), and `apps/frontend` is
not released to production. The promotion in step 8 carries every commit `main` lacks, not only
spec 300: the runbook's "What the promotion carries" has the measured count.

The Railway services, by their dashboard names:

| Service | Runs | Domain (production) |
|---|---|---|
| `backend` | the api (`apps/api`) | `api.askansari.ai`, `api-35.ansari.chat` |
| `auth` | the auth service (`apps/auth`) | `auth.askansari.ai` (attached in step 7; production, 2026-11-21: already attached and serving, see [`release-record.md`](release-record.md)) |
| the web service | production: legacy web (`legacy/frontend-web`), not changed by this release; staging: `apps/frontend` | the web domain (detached in step 2, re-attached in step 9) |

## Before the day (Railway dashboard)

All of these are set before step 2. Auto-deploy is on, so the merge in step 8 deploys whatever
is set at that point. In Railway, applying a variable change **redeploys** the service's current
deployment, so the `backend` edits restart the legacy api: make them at a quiet hour the day
before, and check that `backend` is healthy afterwards. Production values are shown; for staging, use the staging domains.

- **`backend`: add** the five variables below. The new code does not start in production
  without them.

  | Variable | Value |
  |---|---|
  | `AUTH_URL` | `https://auth.askansari.ai` |
  | `AUTH_JWT_ISSUER` | `https://auth.askansari.ai` (set on its own) |
  | `AUTH_JWT_AUDIENCE` | `ansari-api` (the same as on `auth`) |
  | `AUTH_LAYER_ORIGIN` | `https://api.askansari.ai` (the same as on `auth`) |
  | `ENVIRONMENT` | `production` (`staging` in staging; #314, also the Sentry environment) |

  Also on `backend`: `MAINTENANCE_MODE=false`, and **confirm `MCP_COMPLETE_KEY_MODE=log-only`**.
  It is already set in production (owner's statement, 2026-11-21, not verified from the repo).
  Confirm it on the day and record it. Do not set it in the window. An absent value means
  `enforce`, and `mcp.ansari.chat` and the agent skill send no key (#409). **Keep** `JWT_SECRET`,
  `ACCESS_TOKEN_EXPIRY_HOURS`, `REFRESH_TOKEN_EXPIRY_HOURS`, `ADMIN_EMAILS`, `RESEND_API_KEY` and
  `FRONTEND_URL`. The new code ignores them, but the legacy code that serves until step 8 and
  that a rollback redeploys needs them. They are removed in the contract PR, not now.
- **`auth`: set**

  | Variable | Value |
  |---|---|
  | `DATABASE_URL` | the auth database (Railway reference variable) |
  | `BETTER_AUTH_SECRET` | a new random secret, at least 32 characters. **Production, 2026-11-21:** already set and in use (the key pair in `auth.jwks` is encrypted under it); changing it requires emptying `auth.jwks`. See [`release-record.md`](release-record.md) |
  | `BETTER_AUTH_URL` | `https://auth.askansari.ai` |
  | `AUTH_JWT_ISSUER` | `https://auth.askansari.ai` |
  | `AUTH_JWT_AUDIENCE` | `ansari-api` |
  | `AUTH_LAYER_ORIGIN` | `https://api.askansari.ai` |
  | `CORS_ORIGIN` | the real web origins (legacy web never calls `auth` directly; it calls only `apps/api`) |
  | `RESEND_API_KEY` | the Resend key (reset emails are now sent by `auth`) |
  | `FRONTEND_URL` | the web origin, which legacy web serves: no value change (one origin for legacy and new web, owner's statement). Reset links `${FRONTEND_URL}/reset-password?token=…` land on legacy web's reset page |
  | `NODE_ENV` | `production` |
  | `ENVIRONMENT` | `production` (`staging` in staging; #314: required, and the environment in every service key's prefix) |
  | `PORT` | `3100` |

  Optional on `auth`: `SENTRY_DSN`, and `MARKETMAKER_URL` (copy `backend`'s value if it has
  one). Do **not** set `ADMIN_EMAILS` on it. The service has **no domain and no active deployment** (staging: remove the PIR #59 deployment; production, 2026-11-21: it has both, by the owner's decision, see [`release-record.md`](release-record.md)).
- **The web service: no change.** In production it is legacy web, and nothing is set on it for
  this window (no `EXPO_PUBLIC_*` variables: `apps/frontend` is not released).
- The auth domain's DNS record exists and is not attached to any service (production: attached,
  as above).
- The Tailscale forwarder: port 5432 to the app database, port 5433 to the auth database.
- In the release record: the current deployment ID and commit of `backend`, the web service and
  `auth` (`none` if it has no deployment). These are the rollback targets.
- The admin list is approved. On staging, the cutover PR is approved and current with `develop`.
  (#307, #317 and #305 are no longer window preconditions: they belong to `apps/frontend`.)

## 1. Open the operator session

```bash
tailscale status                                   # the forwarder is listed
cd <repo>                                          # a fresh clone, never a builder worktree
git fetch origin && git checkout --detach <recorded commit>
[ "$(git rev-parse HEAD)" = "<recorded commit>" ] && echo checkout-at-recorded-commit
ls apps/auth/scripts/cutover/auth-journal.mjs packages/auth/drizzle/0001_api_key.sql
pnpm install --frozen-lockfile
set +o history
export CUTOVER_ENV=production                      # or staging
read -rs APP_DATABASE_URL && export APP_DATABASE_URL     # paste at the prompt
read -rs AUTH_DATABASE_URL && export AUTH_DATABASE_URL
export API=https://api.askansari.ai AUTH=https://auth.askansari.ai   # staging: api-staging / auth-staging
```

`<recorded commit>` is the commit being promoted, in full, from the release record. The check
prints `checkout-at-recorded-commit`, and `ls` lists both files. If either fails, stop. Do not use
the `builder-spir-300` worktree: it is at `6ed22431` and has neither file. Make no edits in the
checkout until the window ends.

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

> **Production, 2026-11-21:** production's auth journal is already applied
> ([`release-record.md`](release-record.md)), so its table count below is not `0`. In production
> the auth emptiness check is
> `psql "$AUTH_DATABASE_URL" -X -At -c "select (select count(*) from auth.users) + (select count(*) from auth.account)"   # 0`.

```bash
psql "$APP_DATABASE_URL" -X -At -c "select version()"     # PostgreSQL 18
psql "$AUTH_DATABASE_URL" -X -At -c "select version()"    # PostgreSQL 18
psql "$APP_DATABASE_URL" -X -At -c "select system_identifier from pg_control_system()"
psql "$AUTH_DATABASE_URL" -X -At -c "select system_identifier from pg_control_system()"   # a different number
psql "$AUTH_DATABASE_URL" -X -At -c "select count(*) from information_schema.tables where table_schema not in ('pg_catalog','information_schema')"   # 0
```

## 2. Go offline

Post the notice and silence alerts. In Railway, set `MAINTENANCE_MODE=true` on `backend` and
detach the web domain from the web service (production: the legacy web service). The detach is
what stops web traffic: `MAINTENANCE_MODE` only changes the `app-check` answer, and legacy web never
asks for it (the runbook's step 3). Then:

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

> **Production, 2026-11-21:** production's auth journal is already applied
> ([`release-record.md`](release-record.md)). In production run only the `set -o pipefail` and
> `check` lines, **not** the `for` loop (it would re-apply `0000_auth_schema` and stop on its
> error), except after a `DROP SCHEMA auth CASCADE` (an abort or [`rollback.md`](rollback.md)'s
> restart): then every file is missing and the loop is run as printed. Apply only a file the check reports missing (a journal file newer than the record), one
> at a time, and record it:
> `psql "$AUTH_DATABASE_URL" -X -v ON_ERROR_STOP=1 --single-transaction -f packages/auth/drizzle/<tag>.sql`

```bash
for f in $(node apps/auth/scripts/cutover/auth-journal.mjs files); do psql "$AUTH_DATABASE_URL" -X -v ON_ERROR_STOP=1 --single-transaction -f "$f" || break; done
set -o pipefail
node apps/auth/scripts/cutover/auth-journal.mjs check | psql "$AUTH_DATABASE_URL" -X -q -At -v ON_ERROR_STOP=1   # one <tag>|t per file, in order; no output at all is a failure
```

## 4. Copy the users

> **Production, 2026-11-21:** no `create-service` or `create-key` in production before
> `copy.sh: audit OK` (a service user makes the copy refuse: `auth.users is not empty`). Issue the
> service keys in step 6a, after the copy and before the promotion (step 8); see
> [`release-record.md`](release-record.md). The users-and-accounts count runs immediately before
> `copy.sh` and must print `0` (the `auth` domain serves until the window).

```bash
psql "$APP_DATABASE_URL" -X -v ON_ERROR_STOP=1 -f apps/auth/scripts/cutover/00-preflight-app.sql   # no collision, not_bcrypt = 0
psql "$AUTH_DATABASE_URL" -X -At -c "select (select count(*) from auth.users) + (select count(*) from auth.account)"   # 0
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

## 6a. Service keys (production)

After `copy.sh: audit OK`, before step 8. In the production `auth` service's shell, from
`apps/auth/` ([`service-keys-runbook.md`](service-keys-runbook.md), "The script"). Not
established: which commit that service runs, so first check that the script prints the usage
the runbook documents. The `ansari-mcp` service and the `mcp.ansari.chat` key:

```bash
./node_modules/.bin/tsx scripts/service-keys.ts create-service ansari-mcp
./node_modules/.bin/tsx scripts/service-keys.ts create-service ansari-mcp --confirm ansari-mcp
./node_modules/.bin/tsx scripts/service-keys.ts create-key ansari-mcp --rate-max 120 --rate-window 60 --daily 5000 --name <deployment and date> --client-id <its id>
./node_modules/.bin/tsx scripts/service-keys.ts create-key ansari-mcp --rate-max 120 --rate-window 60 --daily 5000 --name <deployment and date> --client-id <its id> --confirm <user id>
./node_modules/.bin/tsx scripts/service-keys.ts list ansari-mcp   # exactly that key, enabled
```

Hand the key off as the runbook says (the owner's upstream variable), and record each write in
its key log. WhatsApp (#336) is not established: issue its key here only if the owner decides to.

## 7. Attach the auth domain

In Railway, attach the auth domain to the `auth` service on port 3100. Then:

> **Production, 2026-11-21:** the domain is already attached and serving, and by the owner's
> decision it stays so ([`release-record.md`](release-record.md)). In production skip the attach;
> the probe below prints `200` (never `000`). The 404-or-502 rule still applies to staging.

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

Auto-deploy builds `auth` and `backend` (staging: and the web service). Wait until each is healthy.

## 9. Verify

```bash
curl -fsS $AUTH/health
curl -fsS $AUTH/api/auth/jwks | jq '.keys | length'                                   # 1 or more
curl -s -o /dev/null -w '%{http_code}' $AUTH/api/account/me                           # 401
```

- Run the edge probes in [`edge-check.md`](edge-check.md).
- Re-attach the web domain to the **same** web service it was detached from in step 2 (production:
  the legacy web service). There is no web swap.
- On legacy web, in a private window, run the smoke test (runbook step 14 lists each flow's
  `/api/v2` route): guest, sign up, sign out, sign in, ask a question, reset the password from the
  email, and delete the account. After the delete, check that signing in with it fails: legacy
  web's delete page goes to `/welcome` even when the delete failed.

## 10. Back online

In Railway, set `MAINTENANCE_MODE=false` on `backend`. Then:

```bash
curl -s $API/api/v2/app-check -H 'Content-Type: application/json' -d '{"platform":"ios","native_application_version":"1.0.0","native_build_version":"1"}' | jq .maintenance_mode   # false
```

- Relaunch a released mobile build and sign in.
- Un-silence the alerts and close the release record.
- Remove the Tailscale forwarder and revoke its key.
- `exit` the shell.
