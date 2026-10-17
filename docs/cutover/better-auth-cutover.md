# Better Auth cutover: the window runbook (spec 300)

The production cutover from `apps/api`'s legacy JWT auth to `apps/auth` (Better Auth). Read
it whole before the window. Every step names the file it runs, the commit it is applied from,
a **check** that is mechanical (a command and the output it must show) and the **abort**
action if the check fails. Rollback, within 24 hours, is [`rollback.md`](rollback.md). The
operator SQL is described in
[`apps/auth/scripts/cutover/README.md`](../../apps/auth/scripts/cutover/README.md).

**The operator environment (spec H-8).** Every database step runs on **the owner's machine**, in
one terminal session, over the owner's **Tailscale route to Railway's private network**, from a
**clean checkout of the promoted commit** (step 4). The auth image carries no Postgres client:
the cutover tooling runs from this checkout, once, and nowhere else.

```bash
tailscale status                                   # up, and the route to Railway's private network is listed
git -C <repo> fetch origin && git -C <repo> checkout --detach <promoted commit>
cd <repo> && git status --porcelain                # prints nothing: a clean checkout
set +o history                                     # shell history off for this session
export PROMOTED_COMMIT=<promoted commit>           # the scripts refuse any other HEAD
read -rs APP_DATABASE_URL && export APP_DATABASE_URL     # pasted at the prompt, never typed as a command
read -rs AUTH_DATABASE_URL && export AUTH_DATABASE_URL
```

- **The hosts.** Each URL's host is Railway-internal, `<name>.railway.internal`, reached over the
  Tailscale route: `copy.sh`, `complete-tombstones.sh` and the rehearsal seed refuse Railway's
  public TCP proxy (`*.proxy.rlwy.net`) and every other host. They also refuse a `psql` that is not
  major 18, a dirty checkout, a HEAD that is not `PROMOTED_COMMIT`, and stdout that is not a
  terminal (`apps/auth/scripts/cutover/operator-env.sh`).
- **TLS on the path.** Append `sslmode=require` to both URLs, then
  `psql "$APP_DATABASE_URL" -X -At -c "select ssl from pg_stat_ssl where pid = pg_backend_pid()"`
  (and the same for `$AUTH_DATABASE_URL`) must print `t`. **If Railway refuses TLS on its private
  path,** drop `sslmode=require`, record that in the release record, and rely on the tunnel: the hop
  from this machine to Railway's private network is inside Tailscale's WireGuard encryption, and
  past it the connection stays on Railway's private network. The scripts then print a TLS warning,
  which is expected.
- **What passes through this machine.** The copy (step 8) streams every email and bcrypt hash
  from the app database into the auth database through a pipe in this session's memory. Nothing
  is written to a file (`02`'s import table is `TEMP`), and the scripts print counts and
  checksums only.
- **The operator scripts** run from the same checkout:
  `(cd apps/auth && DATABASE_URL="$AUTH_DATABASE_URL" pnpm exec tsx scripts/grant-admin.ts …)`
  (and `ban-user.ts`). They need no `psql`, and they also run in the auth image.
- **The session ends with the window:** `exit` the shell, which takes the URLs with it. They are
  never set on a service and never written to a file.

**`psql`.** Every `psql` that applies a migration is `psql -X -v ON_ERROR_STOP=1 --single-transaction -f <file>`:
with both flags, a failed statement stops the run **and** rolls back everything before it. The
cutover scripts are the exception named in their README: they open their own transaction and
run without `--single-transaction`.

**Release record.** Keep one record for the window, in the release notes. It gets the promoted
commit, every SQL file with the commit it was applied from, `cutover_at`, every check's output
(counts and checksums only) and every decision taken.

**Freeze.** From the merge of the cutover PR to the end of the production window, **nothing**
merges to `develop` except the staging rehearsal's docs-only evidence PR (owner amendment R-2).
So the staging rehearsal runs on exactly what production receives.

## Staging rehearsal (owner amendment R-2): this runbook, on staging, first

The branch is never deployed to staging. After the cutover PR merges to `develop`, **this whole
runbook runs on staging, from step 1**, before production. That run is the rehearsal, recorded in
[`rehearsal.md`](rehearsal.md).

### Step 0, before the cutover PR merges: staging auto-deploy OFF

**Turn auto-deploy OFF on staging `backend`, the staging web service and staging `auth` before
the cutover PR merges to `develop`.** Staging deploys from `develop`: with auto-deploy on, the
merge itself would deploy the new `apps/api` onto a staging app database that has no `0010` or
`0011` yet, and every staging sign-in and first use would fail. `DEPLOYED_THROUGH =
'0011_better_auth_window'` asserts that the migrations are applied before the code deploys; only
this step keeps that true on staging. Check each service in the Railway dashboard, and record
that all three are off before the merge word.

Roles:
- the owner operates the Railway side
- the main architect prepares the filled-in staging command sheet from this runbook and checks
  every output
- the builder runs the client-side checks: the edge probes, the released mobile build, the admin
  analytics login, the stored-guest sign-in

The evidence lands as a docs-only PR to `develop`, and only then does the production window
promote `develop`. Each step is run as written, except for these differences:

| Production | Staging rehearsal |
|---|---|
| Step 4 promotes `develop` to `main`; every deploy and file comes from the promoted commit | **No promotion.** The cutover PR's merge commit on `develop` stands in for `main`. Record it in step 1; every deploy and every applied file comes from it |
| The operator environment, with production's URLs | The **same machine, Tailscale route and checkout path**, with staging's URLs (the rehearsal proves this environment, not only the SQL); the seed also needs `ANSARI_CUTOVER_ENV=staging`, because an internal host name is the same in both environments |
| `api.askansari.ai`, `api-35.ansari.chat`; `auth.askansari.ai`; the production web domain | `api-staging.askansari.ai`; `auth-staging.askansari.ai`; the staging web domain. Service names are on main's sheet |
| Auto-deploy is turned off for the window (step 1) and back on in step 18 | **Set before the cutover PR merges** (owner): auto-deploy off on staging `backend` and the staging web service, and the staging `auth` service deploying from `develop` with auto-deploy off. Every deploy is manual: the new frontend is deployed by hand at step 12, so the step 16 web change is rehearsed in order. Auto-deploy comes back only after the rollback rehearsal and the second forward run (below) |
| The auth database is created for the window, or found (C-4) | It already exists, empty, on Postgres 18. Step 1's empty and version checks apply as written |
| The app database is production's | The staging app database (Postgres 18) with its **existing staging users**, no production restore (R-1), plus the anomaly seed below |
| Step 1 records the rollback targets: `backend` and the legacy web service (deployment ID and commit) | Record `backend` and the **staging web service** (it already serves `apps/frontend`); the rollback rehearsal redeploys exactly those IDs |
| Step 2: the public maintenance notice | The team only; no public notice |
| Step 16 replaces legacy web with `apps/frontend`; its rollback is [`rollback.md`](rollback.md) step 4 (the previous legacy web deployment) | Staging web **already serves `apps/frontend`**. Step 16 rehearses only its rebuild with `EXPO_PUBLIC_AUTH_URL` and the domain checks; the swap itself is **not rehearsed** ([`rehearsal.md`](rehearsal.md), residuals) |
| Steps 11 and 14: production domains (the auth domain attaches at step 11, spec H-5) | `auth-staging.askansari.ai` attaches at step 11, after the admin roles and before the staging `backend` deploys, and staging `backend`'s `AUTH_URL` is that domain from its first deploy; its DNS record exists, unattached, before the run. The staging domains are probed on **both paths**: via Cloudflare once the owner orange-clouds `api-staging` and `auth-staging`, and direct with `--resolve` ([`edge-check.md`](edge-check.md)). The staging verdict is recorded only after both paths are measured |
| Step 18 closes the window | Then the **rollback** is rehearsed ([`rollback.md`](rollback.md), all of it). Then the second forward run (rollback's restart procedure), so staging ends on `develop`. Then auto-deploy goes back on |

**`cutover_at` on staging** is the staging app database's clock at step 6, as in production. In
the rollback rehearsal it marks the users to remove. The step 17 smoke test signs up a new user
after it, so the rollback has at least one user to remove, and must leave none behind.

**The seeded anomaly users** (`apps/auth/scripts/cutover/rehearsal-anomalies.ts`; staging only).
They are seeded from the operator environment after step 6 and before step 7. Every seeded
`created_at` is in the past, so the rollback never removes them. Step 8 then runs four times:

| Run | State | `copy.sh` must | Then |
|---|---|---|---|
| 1 | as seeded | **abort** on the collision (`1 normalized email(s) are held by more than one row`); `auth.users` and `auth.account` hold 0 rows; no `import_users` table | `rehearsal-anomalies.ts resolve-collision \| psql …` |
| 2 | collision removed | **abort** on the non-bcrypt hash (`1 row(s) have a hash that is not bcrypt $2a$/$2b$ of length 60`); auth still empty; no `import_users` table | `rehearsal-anomalies.ts resolve-hash \| psql …` |
| 3 | that row removed | **abort** on the NULL timestamp (`1 row(s) have a NULL created_at or updated_at`); auth still empty; no `import_users` table | `rehearsal-anomalies.ts resolve-null \| psql …` |
| 4 | all resolved | **pass**: `copy.sh: audit OK`, the six lines identical | continue at step 9 |

After the pass:
- the mixed-case row signs in with its address in upper case
- the `$2a$` and `$2b$` rows both sign in
- the legacy admin gets `role = 'admin'` in step 10, and `05` lists it
- the guest signs in
- `system_domain_rows|0`

The exact commands and the result tables are in [`rehearsal.md`](rehearsal.md). After the second
forward run, `rehearsal-anomalies.ts remove | psql …` deletes the seeded rows.

## 1. Preconditions (all must hold; any missing → do not start)

- **`main` is current except for spec 300.** A normal release of `develop` at the tip just
  before the cutover PR has been promoted and has soaked, so this window promotes only the
  spec 300 delta.
- **The rollback targets are recorded, before anything goes offline.** In the release record,
  write the **current Railway deployment ID and its commit** for the `backend` service and for
  the legacy web service. On staging there is no legacy web, so record the staging web service
  instead. Rollback steps 3 and 4 redeploy exactly these IDs, never one picked by eye from a
  list that by then has new entries.
- **Production only:** the staging rehearsal (the section above: this runbook, the rollback and
  the second forward run, on staging, from the same `develop` merge commit) passed, the security
  architect has its verdicts, and its docs-only evidence PR is merged. On the staging run itself,
  this item reads: the cutover PR's merge commit on `develop` is recorded.
- **The operator machine (spec H-8), checked before anything goes offline:**
  - full-disk encryption is on;
  - the Tailscale route is up: `tailscale status` lists the route to Railway's private network,
    and `psql "$AUTH_DATABASE_URL" -X -At -c "select 1"` answers over it. Both URLs' hosts are
    `<name>.railway.internal` (never `*.proxy.rlwy.net`);
  - TLS on that path is probed and recorded (the operator environment section): `sslmode=require`
    with `pg_stat_ssl` printing `t`, or the recorded reason for going without it;
  - the URLs are entered with `read -rs` only: never typed as a command, never in a file, a note
    or a clipboard manager's history (turn it off before copying from the Railway dashboard);
  - shell history is off for the session (`set +o history`; the scripts also turn it off);
  - no terminal session recording: no `script`, no asciinema, no iTerm2 (or other terminal)
    session logging;
  - screen sharing is off for the whole window;
  - the checkout is clean, at the promoted commit, with `PROMOTED_COMMIT` exported;
  - the session is closed (`exit`) at the end of the window.
- The phase 13 image check passed: `docker build -f apps/auth/Dockerfile .`, run as the image's
  `node` user, `./node_modules/.bin/tsx scripts/grant-admin.ts --list` inside it.
- Baselines B-1 to B-4 are recorded in [`baselines.md`](baselines.md). The staging edge check's
  verdict is recorded ([`edge-check.md`](edge-check.md)); it selects no mode any more (spec H-4:
  per-email is the only mode), but `apps/api`'s per-IP limits on the layer rest on it.
- The owner has approved the **admin list** (by address), from `00-preflight-app.sql`'s
  inventory.
- **Postgres 18 on both servers, so the cutover runs 18 to 18.** The production app database
  has been upgraded from 17 to 18 (Railway's native upgrade, **before** this window, never inside
  it), and the auth database runs on 18. From the operator
  environment, `psql "$APP_DATABASE_URL" -X -At -c "select version()"` and
  `psql "$AUTH_DATABASE_URL" -X -At -c "select version()"` both report `PostgreSQL 18`, and
  `psql --version` on this machine reports 18 (the scripts refuse any other major).
- **The auth database is empty**, checked mechanically against `AUTH_DATABASE_URL`, whether it was
  created for this window (production) or already existed (staging):
  `psql "$AUTH_DATABASE_URL" -X -At -c "select count(*) from information_schema.tables where table_schema not in ('pg_catalog','information_schema')"`
  prints `0`. Step 7 then applies the `0000` auth baseline as written.
- Every **collision** the preflight lists is decided and resolved (the copy and `0011` abort on
  any), the preflight shows no NULL `created_at`/`updated_at` (the copy aborts on any: it
  copies timestamps exactly), and `not_bcrypt = 0` (the copy aborts on any hash that is not
  bcrypt `$2a$`/`$2b$` of length 60: apps/auth would send it to scrypt and the user could not
  sign in).
- Phases 10b (#304) and 10c (#306) are merged into `builder/spir-300`, so the cutover PR carries
  the reset and delete-account pages (legacy web retires in step 16). #307 (the public
  shared-thread page, so links already in the wild still open) is merged.
- **#317 is merged before the window** (parent #305; the app's builder, with main reviewing the
  `Dockerfile.web` hunk). It is the web image's build guard: `Dockerfile.web` requires both
  `EXPO_PUBLIC_API_URL` and `EXPO_PUBLIC_AUTH_URL` build args unconditionally, with no production
  flag, and refuses a pair that names different hosts. It is negative-tested with the args unset,
  set, and mixed. Without it, a web image built without the args falls back to the staging
  defaults and signs production users in against staging.
- The cutover PR is approved and merged to `develop`; record its merge commit.
- Railway (main architect's runbook section): the `auth` service exists (in production it is
  created for this window, or found; in staging it already exists) with its variables set
  (see `docs/self-hosting.md`; `auth` has no `ADMIN_EMAILS`: spec H-7); one port,
  `PORT=3100`, and **no domain yet**; its own Postgres with snapshots or PITR **on**. The auth
  database is **empty** (no schema yet). Neither `auth` nor `backend` carries
  `AUTH_INTERNAL_SECRET`, `AUTH_INTERNAL_URL` or `INTERNAL_PORT` (spec H-1: there is no internal
  hop). `backend` has `AUTH_URL=https://auth.askansari.ai` (the public domain, from its first
  deploy in step 12) and `AUTH_JWT_ISSUER=https://auth.askansari.ai`, set separately.
- **Auto-deploy is OFF for `backend`, the web service and `auth`** for the window. Railway deploys
  `backend` from `main` on every push, so with auto-deploy on, the promotion in step 4 would boot
  the new `apps/api` before `0011` and the auth database exist. Every deploy below is manual,
  from the promoted commit.
- **`backend` keeps its legacy variables** `JWT_SECRET`, `ACCESS_TOKEN_EXPIRY_HOURS`,
  `REFRESH_TOKEN_EXPIRY_HOURS` and `ADMIN_EMAILS` until the contract PR: the rollback redeploys
  the previous `apps/api`, which does not boot without them.
- `CORS_ORIGIN` on `auth` lists the **real web origins** (the `apps/frontend` web domains). No CI
  check can see this; if it is wrong, every web sign-in fails.
- The web service has both build variables set, for production:
  `EXPO_PUBLIC_API_URL=https://api.askansari.ai`, `EXPO_PUBLIC_AUTH_URL=https://auth.askansari.ai`.
- **The DNS record for `auth.askansari.ai` exists before the window and is not attached** (spec
  H-5): `dig +short auth.askansari.ai` answers (the Railway target, or Cloudflare's proxy if it is
  orange-clouded), and the `auth` service lists no custom domain. Step 11 attaches it; a record
  created inside the window could leave `apps/api` unable to reach `apps/auth` while DNS and the
  certificate catch up.

**Check:** each item ticked in the release record by name. **Abort:** postpone the window.

## 2. Comms and alert silencing

Post the maintenance notice (the time window, "you will be asked to sign in again"). Silence
the uptime and Sentry alerts that the offline step would page on.

**Check:** the notice is visible; the alert silences are listed in the record.
**Abort:** none needed; un-silence if the window is postponed.

## 3. `apps/api` offline

By the mechanism the rehearsal chose (recorded there).

**Check:** `curl -s -o /dev/null -w '%{http_code}' https://api.askansari.ai/api/health` and the
same for `https://api-35.ansari.chat/api/health` return the offline response, not 200.
**Abort:** bring `apps/api` back online. Nothing has changed.

## 4. Promote `develop` to `main`

The fast-forward of `RELEASE.md`'s standard checklist, now that `apps/api` is offline and
auto-deploy is off. Every deploy and every applied file below comes from this commit.

```bash
git fetch origin && git push origin origin/develop:main
```

**Check:** `git rev-parse origin/main` equals the cutover PR's merge commit (or a later
`develop` commit carrying no migration); record it. No Railway deployment started.
**Abort:** bring `apps/api` back online on its current deployment. `main` holding the new
commit is harmless while nothing deploys from it; revert the promotion before re-enabling
auto-deploy.

## 5. Snapshots

Take a Railway snapshot (or note the PITR mark) of the **app database**, and of the (empty)
**auth database**.

**Check:** both snapshot ids or PITR timestamps are in the record.
**Abort:** bring `apps/api` back online.

## 6. Deploy `apps/auth` privately

Deploy the `auth` service from the promoted commit, with **no domain**. It boots without a
schema (`/health` only pings the database), and it runs no admin check at boot (spec H-7). The
operator environment (above) is already open on the owner's machine, at the same commit.

Then take **`cutover_at`** from the app database's own clock:

```bash
psql "$APP_DATABASE_URL" -X -At -c "select now()"
```

It is taken **here**, with `apps/api` offline and before any new code can create a user (the new
`apps/api` first deploys in step 12), so the rollback's "users created at or after
`cutover_at`" catches every one of them.

**Check:** the deployment is healthy; in the operator session, `git rev-parse HEAD` equals
`PROMOTED_COMMIT` and `git status --porcelain` prints nothing; `psql --version` shows 18, and `select version()` reports `PostgreSQL 18` on both
`$APP_DATABASE_URL` and `$AUTH_DATABASE_URL`; step 1's empty-database check prints `0` on
`$AUTH_DATABASE_URL`; `cutover_at` is in the record.
**Abort:** remove the deployment, bring `apps/api` back online.

## 7. The auth baseline

`packages/auth/drizzle/0000_auth_schema.sql`, from the operator environment:

```bash
psql "$AUTH_DATABASE_URL" -X -v ON_ERROR_STOP=1 --single-transaction -f packages/auth/drizzle/0000_auth_schema.sql
```

**Check:** `psql "$AUTH_DATABASE_URL" -X -At -c "select count(*) from information_schema.tables where table_schema = 'auth'"`
prints `6`, and `psql "$AUTH_DATABASE_URL" -X -At -c "select count(*) from auth.users"` prints `0`.
Record `auth-journal-applied: 0000_auth_schema` and the commit.
**Abort:** `psql "$AUTH_DATABASE_URL" -X -c 'DROP SCHEMA auth CASCADE'`, remove the `auth`
deployment, bring `apps/api` back online.

## 8. The copy and the audits

Re-run the preflight first; it must show no collision, `no_password_hash = 0`, `not_bcrypt = 0` and no NULL timestamp. Then copy:

```bash
psql "$APP_DATABASE_URL" -X -v ON_ERROR_STOP=1 -f apps/auth/scripts/cutover/00-preflight-app.sql
apps/auth/scripts/cutover/copy.sh
```

**Check:** `copy.sh` exits 0 and prints `copy.sh: audit OK`, with the same six lines for the app
and the auth side (`rows` equal to the preflight's `to_copy`). Record both blocks.
**Abort:** do **not** run step 9. Empty the auth database (`DROP SCHEMA auth CASCADE`), and
either re-run from step 7 or bring `apps/api` back online on the old code.

## 9. The app window migration

From the operator environment, in journal order, each applied only if not already applied
(`0009` and `0010` may have shipped earlier; the release record says):

```bash
psql "$APP_DATABASE_URL" -X -v ON_ERROR_STOP=1 --single-transaction -f apps/api/drizzle/0009_better_auth_scaffold_cleanup.sql
psql "$APP_DATABASE_URL" -X -v ON_ERROR_STOP=1 --single-transaction -f apps/api/drizzle/0010_deleted_users.sql
psql "$APP_DATABASE_URL" -X -v ON_ERROR_STOP=1 --single-transaction -f apps/api/drizzle/0011_better_auth_window.sql
```

**Check:** `psql "$APP_DATABASE_URL" -X -At -c "select to_regclass('public.deleted_users') is not null"`
prints `t` (`0010` landed: the tombstone table `DELETE me` and first use read), `psql "$APP_DATABASE_URL" -X -At -c "select is_nullable from information_schema.columns where table_schema = 'public' and table_name = 'users' and column_name = 'password_hash'"`
prints `YES` (`0011` landed: rows created on first use carry no hash), and `psql "$APP_DATABASE_URL" -X -At -c "select count(*) from users where email <> lower(trim(email))"`
prints `0`. A skipped migration must not pass into step 12: the new `apps/api` would refuse every
first use and every delete, a total auth outage. Each guard is one `DO` block: a guard failure aborts its file with nothing applied.
**Abort:** a guard failure changed nothing; the legacy code still runs on this database. Bring
`apps/api` back online on the old code and investigate. If `0011` applied and the window must
still stop, follow [`rollback.md`](rollback.md).

## 10. Admin roles

From the operator environment (`grant-admin.ts` reads the auth database from `DATABASE_URL`), for each
address on the approved list: show the account, check it, then grant it by its id. Then run
the audit.

```bash
(cd apps/auth && DATABASE_URL="$AUTH_DATABASE_URL" pnpm exec tsx scripts/grant-admin.ts <email>)                  # shows id, email, created_at, email_verified, role; grants nothing
(cd apps/auth && DATABASE_URL="$AUTH_DATABASE_URL" pnpm exec tsx scripts/grant-admin.ts <email> --confirm <id>)   # grants exactly that account
psql "$AUTH_DATABASE_URL" -X -q -v ON_ERROR_STOP=1 -f apps/auth/scripts/cutover/05-audit-admins-auth.sql
```

A copied legacy admin shows `email_verified true` and an old `created_at`. A **warning** (a
recent or unverified account: the signs of a squatted address) means you stop and confirm the
person out of band before `--confirm`. There is no `ADMIN_EMAILS` to set and no `auth` redeploy
in this step (spec H-7): the window has one fewer `auth` redeploy than before.

**Check:** `05-audit-admins-auth.sql` prints exactly the approved list, one address per line. A
legacy admin left off the list holds no admin role. The role in `auth.users` is the only admin
truth; nothing at boot checks a list.
**Abort:** `(cd apps/auth && DATABASE_URL="$AUTH_DATABASE_URL" pnpm exec tsx scripts/grant-admin.ts --revoke <email>)`
for any extra; fix and re-check.

## 11. Attach `auth.askansari.ai` (spec H-5)

Only now, after the copy (step 8) and the admin roles (step 10), and before `apps/api` deploys:
`apps/api` reaches `apps/auth` at this domain from its first deploy (its JWKS, its account
endpoints, the layer). Never earlier: a reachable `apps/auth` before the copy would accept
sign-ups into `auth.users`, and the copy's empty-target guard would abort. Attach the domain to
the `auth` service, targeting **`PORT` (3100)**. Railway's certificate can take minutes: wait for
it.

```bash
curl -fsS https://auth.askansari.ai/health
curl -fsS https://auth.askansari.ai/api/auth/jwks | jq '.keys | length'
curl -s -o /dev/null -w '%{http_code}' https://auth.askansari.ai/internal/users/00000000-0000-0000-0000-000000000000/profile
curl -s -o /dev/null -w '%{http_code}' https://auth.askansari.ai/api/account/me
```

Then the edge properties on its probe, as in step 14, on every path the domain has (via
Cloudflare if proxied, and direct with `--resolve`), over IPv4 and IPv6:
`curl -s -H 'X-Real-IP: 192.0.2.66' -H 'X-Forwarded-For: 192.0.2.66' -H 'CF-Connecting-IP: 192.0.2.66' https://auth.askansari.ai/__diag/client-ip`.

**Check:** `/health` returns 200 over https with a **valid certificate** (plain `curl`, never
`-k`; a certificate error is not a pass); the JWKS prints `1` or more; `/internal/…` prints `404`
(there is no internal route); `/api/account/me` with no token prints `401`; the probe shows your
real address on every path, and a second network a different one. Record them in
[`edge-check.md`](edge-check.md).

**Exposure, accepted (spec H-5):** from here until step 12 deploys `apps/api`, the public can sign
up and sign in at `apps/auth` directly, a few minutes earlier than the old order (attach last)
allowed; it is the same exposure as after step 15 before. Those users are created after
`cutover_at`, so the rollback removes them.
**Abort:** detach the domain; follow [`rollback.md`](rollback.md). An edge failure alone is step
14's abort.

## 12. Deploy `apps/api` and `apps/frontend`

Deploy the `backend` service and the web service from the promoted commit. `backend`'s
`AUTH_URL` is `https://auth.askansari.ai`, attached and checked in step 11.

**Check:** both deployments healthy. On each `*.up.railway.app` production domain of `backend`,
the P-4 probe `curl -s https://<backend>.up.railway.app/api/v2/_diag/client-ip` shows your own
IP as `x_real_ip` (see [`edge-check.md`](edge-check.md) for the reading).
**Abort:** follow [`rollback.md`](rollback.md).

## 13. Re-attach `apps/api`'s domains

Undo step 3's mechanism for `api.askansari.ai` and `api-35.ansari.chat`.

**Check:** `curl -fsS https://api.askansari.ai/api/health` and
`curl -fsS https://api-35.ansari.chat/api/health` return 200. A released mobile build signs in
through `/v2/users/login` (the compatibility layer) and loads its threads.
**Abort:** follow [`rollback.md`](rollback.md).

## 14. Edge probe on the `apps/api` production domains (P-4)

On `api.askansari.ai` and `api-35.ansari.chat`, over IPv4 and IPv6 where reachable, both
properties of [`edge-check.md`](edge-check.md). Probe **both paths**: through Cloudflare where
the domain is proxied (`api.askansari.ai`), and direct to Railway's edge with `--resolve`. Run
the method's whole command block, with `curl -4` and `curl -6` on each path, recording an
unreachable family as such. The via-Cloudflare IPv4 probe, for example:

```bash
curl -4 -s -H 'X-Real-IP: 192.0.2.66' -H 'X-Forwarded-For: 192.0.2.66' -H 'CF-Connecting-IP: 192.0.2.66' https://api.askansari.ai/api/v2/_diag/client-ip
```

**Check:** **overwrite:** on every path, `x_real_ip` is your real address, never `192.0.2.66`;
**distinctness:** the same probe from a second network (a phone hotspot) shows a different
`x_real_ip`. Record both, per domain and path, in `edge-check.md`.
**Abort (no rollback):** if either property fails, tell the security architect at once. There is
no mode to switch (spec H-4): `apps/auth` keys nothing the layer calls by IP, and its per-email,
per-session and global limits hold whatever the edge does. What fails is `apps/api`'s per-IP
limit on the layer's routes, which would then be keyed by a value a client can choose; the
security architect decides whether the window goes on.

## 15. (Moved to step 11)

`auth.askansari.ai` is attached, and its edge probe run, in step 11 (spec H-5): `apps/api` needs
it from its first deploy. Confirm only that the record still holds every step 11 output.

**Check:** step 11's outputs are in the record. **Abort:** n/a.

## 16. Replace legacy web with `apps/frontend`

Move the web domain from the legacy web service to the `apps/frontend` web service (owner,
2026-10-16: legacy web retires at go-live).

**Check:** the web domain serves `apps/frontend` (its page title and the sign-in sheet), and a
private window provisions a guest (one `sign-up/email` then one `token` at `auth.askansari.ai`).
**Abort:** move the domain back; follow [`rollback.md`](rollback.md) if anything else changed.

## 17. Public smoke tests (scenario 31)

On the production web app, in a private window: open the app (a guest is provisioned), sign up
a throwaway account, sign out, sign in, ask one question. Request a password reset for it and
complete the reset from the email. Delete the account at `/delete-account`.

**Check:** each succeeds; the reset email's link has the shape
`https://<web domain>/reset-password?token=…` and opens the reset page.
**Abort:** follow [`rollback.md`](rollback.md).

## 18. Re-enable alerting and close the record

Un-silence the alerts from step 2. Re-enable auto-deploy for `backend`, the web service and
`auth`. Complete the release record: the promoted commit, each applied file with its commit,
`cutover_at`, the rollback deadline (`cutover_at` + 24 hours), and every check's output.

**Check:** the record is complete and posted; auto-deploy is on again.
**Abort:** n/a.

## Orphan app rows (owner-accepted residual, spec H-6)

A user can call `apps/auth`'s `DELETE /api/account` with their own token directly, bypassing
`apps/api`. That deletes their auth account but leaves their `public.users` row (and its threads)
with **no tombstone**. If they later sign up with the same email, `apps/auth` gives them a new id,
and `apps/api`'s first use refuses it as an email conflict, every time. Without an internal hop,
`apps/api` cannot tell that the holder row has no auth user.

**The signal:** the Sentry alert `auth user has no app row: email-conflict`, whose `extra` names
`sub` (the new id) and `holderId` (the old app row). Ids only, never the email.

**The audit** (operator environment, read-only): app user ids that have no auth user. System
rows are excluded; they never have one.

```bash
psql "$APP_DATABASE_URL" -X -At -c "select id from users where system_key is null" | LC_ALL=C sort > /tmp/app_ids
psql "$AUTH_DATABASE_URL" -X -At -c "select id from auth.users" | LC_ALL=C sort > /tmp/auth_ids
LC_ALL=C comm -23 /tmp/app_ids /tmp/auth_ids
```

**The cleanup**, for one `holderId` the alert named, only if the audit lists it: delete the orphan
row (its threads, preferences and feedback cascade, as the user's own delete would have done) and
write its tombstone, in one transaction. It writes the tombstone only if it deleted a non-system
row, and prints `INSERT 0 1` when it did.

```bash
psql "$APP_DATABASE_URL" -X -v ON_ERROR_STOP=1 --single-transaction -v id='<holderId>' <<'SQL'
WITH gone AS (DELETE FROM users WHERE id = :'id' AND system_key IS NULL RETURNING id)
INSERT INTO deleted_users (id, auth_deleted_at) SELECT id, now() FROM gone;
SQL
```

The user's next request then creates their new app row on first use. Remove `/tmp/app_ids` and
`/tmp/auth_ids` afterwards. `apps/api/tests/auth/resolve-user.test.ts` ("owner-accepted residual
R3") runs this cleanup against the refusal it clears.

## What users and operators will notice

- **Everyone signs in once more.** Old JWTs and refresh tokens are dead.
- **Users signed in to a real account before the cutover** open the new web app signed out, on
  their device's guest. Their account is unchanged; they sign in with the same email and
  password. Say this in the release note and the maintenance notice.
- **Key rotation is not revocation.** A rotated signing key does not invalidate existing JWTs
  until `apps/api`'s cached key set expires (10 minutes, plus a 15-minute grace while `apps/auth`
  is unreachable) or `apps/api` restarts. To cut a user off, ban them (`ban-user.ts`, which
  deletes their sessions); their JWT still verifies until it expires (15 minutes).
- **Reset links in access logs.** `GET /reset-password?token=…` is logged by the web host on every
  click. The token is single-use and expires after an hour. Changing the link shape is with the
  owner.
- **If the offline mechanism detaches domains,** `backend`'s `*.up.railway.app` domain stays
  reachable during the window. Accepted; the rehearsal records it.
