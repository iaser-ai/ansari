# Better Auth cutover: the window runbook (spec 300)

The production cutover from `apps/api`'s legacy JWT auth to `apps/auth` (Better Auth). Read
it whole before the window. Every step names the file it runs, the commit it is applied from,
a **check** that is mechanical (a command and the output it must show) and the **abort**
action if the check fails. Rollback, within 24 hours, is [`rollback.md`](rollback.md). The
operator SQL is described in
[`apps/auth/scripts/cutover/README.md`](../../apps/auth/scripts/cutover/README.md).
The commands alone, in order, are in [`deploy-guide.md`](deploy-guide.md).

**The operator environment (spec H-8).** Every database step runs on **the owner's machine**, in
one terminal session, through **Railway's Tailscale forwarder** (docs.railway.com, "Set up a
Tailscale forwarder"), from a checkout of the commit being deployed (step 10 checks it).

**The forwarder.** A Railway service in the environment being cut over (staging for the
rehearsal, production for the window) that joins the owner's tailnet and relays ports to the
databases' private hosts. One forwarder, two mappings:

```
CONNECTION_MAPPING_1=5432:<app-postgres>.railway.internal:5432    # the app database
CONNECTION_MAPPING_2=5433:<auth-postgres>.railway.internal:5432   # the auth database
```

MagicDNS is on, this machine uses Tailscale DNS, and the tailnet ACL lets only this machine
reach the forwarder, on those two ports. The forwarder service has **no public networking and no
domain** in Railway, and its Tailscale auth key is a **tagged** key, scoped by that ACL, that
exists only as the forwarder service's `TS_AUTHKEY` variable. Both URLs name the **same**
forwarder, its machine name (which Railway derives from the project, environment and service),
and differ by the mapping's port:
`postgresql://postgres:<password>@<project>-<environment>-tailscale-forwarder:5432/railway` for
the app database, `:5433` for the auth database. The scripts refuse two different hosts, and any
host that is not the forwarder of `CUTOVER_ENV`'s environment, so a URL pasted from the other
environment is refused before anything runs. After the window, remove the forwarder service and
revoke its key (step 16): it keeps its machine identity across restarts (`TS_EPHEMERAL=false`).

The auth image carries no Postgres client: the cutover tooling runs from this checkout, once,
and nowhere else.

```bash
tailscale status                                   # up, and the environment's forwarder is listed
cd <repo>                                          # at the commit being deployed (staging: the cutover PR's head)
set +o history                                     # shell history off for this session
export CUTOVER_ENV=production                      # staging in the rehearsal; read it back aloud
echo "$CUTOVER_ENV"                                # say the word aloud before going on
read -rs APP_DATABASE_URL && export APP_DATABASE_URL     # pasted at the prompt, never typed as a command
read -rs AUTH_DATABASE_URL && export AUTH_DATABASE_URL
```

- **The hosts.** Each URL's host is the forwarder's MagicDNS name,
  `<project>-<environment>-tailscale-forwarder` (Tailscale may add `-<n>`; the full
  `.<tailnet>.ts.net` form is accepted too): `copy.sh`, `complete-tombstones.sh` and the
  rehearsal seed refuse Railway's public TCP proxy (`*.proxy.rlwy.net`), `<name>.railway.internal`
  (it resolves only inside Railway), IPs and every other host. The seed also requires staging's
  forwarder (`<project>-staging-tailscale-forwarder`). They also refuse a `psql` that is not
  major 18, and stdout that is not a terminal (`apps/auth/scripts/cutover/operator-env.sh`).
- **TLS on the path.** Append `sslmode=require` to both URLs, then
  `psql "$APP_DATABASE_URL" -X -At -c "select ssl from pg_stat_ssl where pid = pg_backend_pid()"`
  (and the same for `$AUTH_DATABASE_URL`) must print `t`. The forwarder relays plain TCP, so TLS,
  when Postgres offers it, runs end to end through it (`verify-full` would fail on the forwarder's
  name; `require` does not check the name). **If Postgres refuses TLS on this path,** drop
  `sslmode=require`, record that in the release record, and rely on the tunnel: the hop from this
  machine to the forwarder is inside Tailscale's WireGuard encryption, and from the forwarder on
  the connection stays on Railway's private network. The scripts then print a TLS warning,
  which is expected.
- **What passes through this machine.** The copy (step 6) streams every email and bcrypt hash
  from the app database into the auth database through a pipe in this session's memory. Nothing
  is written to a file (`02`'s import table is `TEMP`), and the scripts print counts and
  checksums only.
- **The operator scripts** run from the same checkout:
  `(cd apps/auth && DATABASE_URL="$AUTH_DATABASE_URL" pnpm exec tsx scripts/grant-admin.ts …)`
  (and `ban-user.ts`). They need no `psql`, and they also run in the auth image.
- **The checkout is the `builder-spir-300` worktree** (owner, 2026-10-19). It is **not** cleaned
  up after #315 merges: it stays until the production cutover is done. If it is gone by then, the
  fallback is a fresh checkout of `develop` at the commit being promoted.
- **The builder is idle during each window:** no edits and no git operations in that worktree.
  Nothing checks the checkout any more, so an edit made mid-window would run unnoticed.
- **The session ends with the window:** `exit` the shell, which takes the URLs with it. They are
  never set on a service and never written to a file.

**A dry run before the window (optional).** From this same operator environment,
`apps/auth/scripts/cutover/copy.sh --dry-run` runs step 6's copy, guards and audits against the
real databases and commits nothing. An auth database with no schema gets the `0000` baseline inside
the rolled-back transaction, so step 1's empty-database check still holds, and the script checks
that it does. It streams every production email and hash through this machine like the real copy, so it
is never run casually: only under the full operator checks and step 1's hygiene checklist, in the
same session discipline as the real copy. Its timing previews step 6's. It is not a step of the window: in the window,
step 6 runs `copy.sh` without the flag.

**`psql`.** Every `psql` that applies a migration is `psql -X -v ON_ERROR_STOP=1 --single-transaction -f <file>`:
with both flags, a failed statement stops the run **and** rolls back everything before it. The
cutover scripts are the exception named in their README: they open their own transaction and
run without `--single-transaction`.

**Release record.** Keep one record for the window, in the release notes. It gets the promoted
commit, every SQL file with the commit it was applied from, `cutover_at`, every check's output
(counts and checksums only) and every decision taken.

**Freeze.** From the merge of the cutover PR to the end of the production window, **nothing**
merges to `develop` except the staging rehearsal's docs-only evidence PR (owner amendment R-2).
So the staging rehearsal runs on exactly what production receives. Before its merge, the cutover
PR is brought current with `develop` and nothing else merges ahead of it: on staging the
scripts run from the PR head, and step 10 checks that the merge commit's tree equals it.

**Auto-deploy stays on (owner decision, 2026-10-19).** Railway deploys `backend`, the web
service and `auth` from the branch on every push, and nothing turns that off. So the new code's
deploy **is** step 10: the promotion of `develop` to `main` (production), or the cutover PR's
merge to `develop` (staging). Everything the new code needs comes before it: the database steps
(3 to 8), the auth domain (9) and every variable it reads (step 1). The legacy `apps/api` keeps
serving until then, behind maintenance mode. Steps 3 to 10 are **one continuous session**: the
copy is the last thing before the promotion, so a legacy write between them stays a matter of
minutes. The release record holds the target duration, and step 10 records the actual time.

## Staging rehearsal (owner amendment R-2): this runbook, on staging, first

The branch is never deployed to staging ahead of its merge. **This whole runbook runs on staging,
from step 1, before production**, and its step 10 is the cutover PR's merge to `develop`, whose
auto-deploy brings up the staging `auth`, `backend` and web services. That run is the rehearsal,
recorded in [`rehearsal.md`](rehearsal.md).

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
| Step 10 promotes `develop` to `main`; Railway auto-deploys `auth`, `backend` and web from `main` | Step 10 **merges the cutover PR** to `develop`; Railway auto-deploys the staging services from `develop` |
| The scripts run from the `develop` tip about to be promoted | The scripts run from the **cutover PR's head**, current with `develop` (the freeze); step 10 checks that the merge commit's tree equals it |
| The operator environment, with production's URLs | The **same machine, forwarder setup and checkout path**, with staging's forwarder and URLs (the rehearsal proves this environment, not only the SQL); `CUTOVER_ENV=staging`, which the seed also requires |
| `api.askansari.ai`, `api-35.ansari.chat`; `auth.askansari.ai`; the production web domain | `api-staging.askansari.ai`; `auth-staging.askansari.ai`; the staging web domain. Service names are on main's sheet |
| The `auth` service is created for the window with no deployment, or found with none | Staging `auth` already exists and runs the PIR #59 code: **remove its active deployment before step 9** (record its ID), so the domain attached in step 9 serves nothing until the merge deploys the new code |
| The auth database is created for the window, or found (C-4) | It already exists, empty, on Postgres 18. Step 1's empty and version checks apply as written |
| The app database is production's | The staging app database (Postgres 18) with its **existing staging users**, no production restore (R-1), plus the anomaly seed below |
| Step 1 records the rollback targets: `backend`, the legacy web service and `auth` (deployment ID and commit, or none) | `backend`, the **staging web service** (it already serves `apps/frontend`) and `auth` (the PIR #59 deployment removed before step 9) |
| Step 2: the public maintenance notice | The team only; no public notice |
| Step 3 detaches the production web domain from the legacy web service; step 13 attaches it to the `apps/frontend` web service, and its rollback is [`rollback.md`](rollback.md) step 4 | Staging web **already serves `apps/frontend`**. Step 3 detaches its domain and step 13 re-attaches it, after the merge rebuilt it with `EXPO_PUBLIC_AUTH_URL`; the swap itself is **not rehearsed** ([`rehearsal.md`](rehearsal.md), residuals) |
| Steps 9, 11 and 12: production domains | `auth-staging.askansari.ai` attaches at step 9, after the admin roles and before the merge; its DNS record exists, unattached, before the run, and staging `backend`'s `AUTH_URL` is that domain before the merge. The staging domains are probed on **both paths**: via Cloudflare once the owner orange-clouds `api-staging` and `auth-staging`, and direct with `--resolve` ([`edge-check.md`](edge-check.md)). The staging verdict is recorded only after both paths are measured |
| Step 16 closes the window | Then the **rollback** is rehearsed ([`rollback.md`](rollback.md), all of it). Then the second forward run (rollback's restart procedure), so staging ends on `develop` with auto-deploy on |

**`cutover_at` on staging** is the staging app database's clock at step 3, as in production. In
the rollback rehearsal it marks the users to remove. The step 14 smoke test signs up a new user
after it, so the rollback has at least one user to remove, and must leave none behind.

**The seeded anomaly users** (`apps/auth/scripts/cutover/rehearsal-anomalies.ts`; staging only).
They are seeded from the operator environment after step 4 and before step 5. Every seeded
`created_at` is in the past, so the rollback never removes them. Step 6 then runs four times:

| Run | State | `copy.sh` must | Then |
|---|---|---|---|
| 1 | as seeded | **abort** on the collision (`1 normalized email(s) are held by more than one row`); `auth.users` and `auth.account` hold 0 rows; no `import_users` table | `rehearsal-anomalies.ts resolve-collision \| psql …` |
| 2 | collision removed | **abort** on the non-bcrypt hash (`1 row(s) have a hash that is not bcrypt $2a$/$2b$ of length 60`); auth still empty; no `import_users` table | `rehearsal-anomalies.ts resolve-hash \| psql …` |
| 3 | that row removed | **abort** on the NULL timestamp (`1 row(s) have a NULL created_at or updated_at`); auth still empty; no `import_users` table | `rehearsal-anomalies.ts resolve-null \| psql …` |
| 4 | all resolved | **pass**: `copy.sh: audit OK`, the six lines identical | continue at step 7 |

After the pass:
- the mixed-case row signs in with its address in upper case
- the `$2a$` and `$2b$` rows both sign in
- the legacy admin gets `role = 'admin'` in step 8, and `05` lists it
- the guest signs in
- `system_domain_rows|0`

The exact commands and the result tables are in [`rehearsal.md`](rehearsal.md). After the second
forward run, `rehearsal-anomalies.ts remove | psql …` deletes the seeded rows.

## 1. Preconditions (all must hold; any missing → do not start)

- **`main` is current except for spec 300.** A normal release of `develop` at the tip just
  before the cutover PR has been promoted and has soaked, so this window promotes only the
  spec 300 delta. That soaked release is the `apps/api` serving during steps 3 to 9.
- **The rollback targets are recorded, before anything changes.** In the release record, write
  the **current Railway deployment ID and its commit** for the `backend` service, the legacy web
  service and the `auth` service (`none` if it has no deployment). On staging there is no legacy
  web, so record the staging web service instead. Rollback step 3 returns each service to exactly
  these, never to one picked by eye from a list that by then has new entries.
- **The commit being deployed is recorded:** in production, the `develop` tip about to be
  promoted (the cutover PR's merge, or a later `develop` commit carrying no migration); on the
  staging run, the cutover PR's head, current with `develop`. Steps 3 to 9 run from a checkout of
  it, and step 10 checks that what deploys has the same tree.
- **Production only:** the staging rehearsal (the section above: this runbook, the rollback and
  the second forward run, on staging, from the same commit) passed, the security architect has its
  verdicts, and its docs-only evidence PR is merged. On the staging run itself, this item reads:
  the cutover PR is approved, current with `develop`, and not yet merged.
- **The operator machine (spec H-8), checked before anything changes:**
  - full-disk encryption is on;
  - `CUTOVER_ENV` is set to this window's environment (`production`; `staging` in the
    rehearsal) and **read back aloud**; the scripts refuse any other value, and any host that is
    not `<project>-$CUTOVER_ENV-tailscale-forwarder`;
  - the Tailscale forwarder is up: `tailscale status` lists this environment's forwarder, and
    both URLs' hosts are that one name, `<project>-<environment>-tailscale-forwarder` (never
    `*.proxy.rlwy.net`, never another environment's forwarder);
  - the forwarder service has no public networking and no domain in Railway's dashboard, and its
    Tailscale auth key exists only as that service's `TS_AUTHKEY` variable, as a tagged key
    scoped by the ACL to this machine and ports 5432 and 5433;
  - each URL reaches its own database, and the two are different clusters (a swapped mapping, or
    one database mapped twice). The auth database is empty here (the baseline lands at step 5),
    so the checks hold for an empty one:
    - `psql "$APP_DATABASE_URL" -X -At -c "select to_regclass('public.users')"` prints `users`;
    - `psql "$AUTH_DATABASE_URL" -X -At -c "select to_regclass('public.users')"` prints an empty
      line (NULL);
    - `psql "$AUTH_DATABASE_URL" -X -At -c "select count(*) from information_schema.schemata where schema_name = 'auth'"`
      prints `0`;
    - `psql "$APP_DATABASE_URL" -X -At -c "select system_identifier from pg_control_system()"` and
      the same for `$AUTH_DATABASE_URL` print two **different** numbers;
  - TLS on that path is probed and recorded (the operator environment section): `sslmode=require`
    with `pg_stat_ssl` printing `t`, or the recorded reason for going without it;
  - the URLs are entered with `read -rs` only: never typed as a command, never in a file, a note
    or a clipboard manager's history (turn it off before copying from the Railway dashboard);
  - shell history is off for the session (`set +o history`; the scripts also turn it off);
  - no terminal session recording: no `script`, no asciinema, no iTerm2 (or other terminal)
    session logging;
  - screen sharing is off for the whole window;
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
  prints `0`. Step 5 then applies the whole auth journal as written.
- Every **collision** the preflight lists is decided and resolved (the copy and `0011` abort on
  any), the preflight shows no NULL `created_at`/`updated_at` (the copy aborts on any: it
  copies timestamps exactly), and `not_bcrypt = 0` (the copy aborts on any hash that is not
  bcrypt `$2a$`/`$2b$` of length 60: apps/auth would send it to scrypt and the user could not
  sign in).
- Phases 10b (#304) and 10c (#306) are merged into `builder/spir-300`, so the cutover PR carries
  the reset and delete-account pages (legacy web retires in step 13). #307 (the public
  shared-thread page, so links already in the wild still open) is merged.
- **#317 is merged before the window** (parent #305; the app's builder, with main reviewing the
  `Dockerfile.web` hunk). It is the web image's build guard: `Dockerfile.web` requires both
  `EXPO_PUBLIC_API_URL` and `EXPO_PUBLIC_AUTH_URL` build args unconditionally, with no production
  flag, and refuses a pair that names different hosts. It is negative-tested with the args unset,
  set, and mixed. Without it, a web image built without the args falls back to the staging
  defaults and signs production users in against staging.
- **Auto-deploy is ON for `backend`, the web service and `auth`, and stays on** (owner decision,
  2026-10-19). Their next deploy is step 10's, so **every variable the new code reads is set
  before step 3** (below), and nothing is pushed to the deploying branch between step 3 and step
  10 except step 10 itself. Applying a variable change in Railway redeploys the service's current
  deployment, so the `backend` edits restart the legacy api: make them at a quiet hour the day
  before, and check its health afterwards.
- Railway (main architect's runbook section): the `auth` service exists (in production it is
  created for this window, or found; in staging it already exists) with its variables set
  (see `docs/self-hosting.md`; `auth` has no `ADMIN_EMAILS`: spec H-7); one port,
  `PORT=3100`; **no domain yet** and **no active deployment** (staging: the PIR #59 deployment is
  removed, its ID recorded above); its own Postgres with snapshots or PITR **on**. The auth
  database is **empty** (no schema yet). Neither `auth` nor `backend` carries
  `AUTH_INTERNAL_SECRET`, `AUTH_INTERNAL_URL` or `INTERNAL_PORT` (spec H-1: there is no internal
  hop). `backend` has the four variables the new code requires in production (it does not boot
  without them), read from its first deploy in step 10: `AUTH_URL=https://auth.askansari.ai` (the
  public domain), `AUTH_JWT_ISSUER=https://auth.askansari.ai` (set separately),
  `AUTH_JWT_AUDIENCE` and `AUTH_LAYER_ORIGIN=https://api.askansari.ai`, the last two equal to
  `auth`'s; and `MAINTENANCE_MODE=false` (step 3 sets it). `auth` has every variable
  `packages/auth/src/env.ts` requires, including `RESEND_API_KEY` and `FRONTEND_URL` (it now
  sends the reset emails).
- **`backend` keeps its legacy variables** `JWT_SECRET`, `ACCESS_TOKEN_EXPIRY_HOURS`,
  `REFRESH_TOKEN_EXPIRY_HOURS`, `ADMIN_EMAILS`, `RESEND_API_KEY` and `FRONTEND_URL` until the
  contract PR: the legacy code serves until step 10, and the rollback redeploys it. It does not
  boot without `JWT_SECRET`, and its admin access and reset emails need the others.
- `CORS_ORIGIN` on `auth` lists the **real web origins** (the `apps/frontend` web domains). No CI
  check can see this; if it is wrong, every web sign-in fails.
- **The web service has both build variables set before step 10**, whose push rebuilds it (#317's
  guard fails the build if either is missing), for production:
  `EXPO_PUBLIC_API_URL=https://api.askansari.ai`, `EXPO_PUBLIC_AUTH_URL=https://auth.askansari.ai`.
- **The DNS record for `auth.askansari.ai` exists before the window and is not attached** (spec
  H-5): `dig +short auth.askansari.ai` answers (the Railway target, or Cloudflare's proxy if it is
  orange-clouded), and the `auth` service lists no custom domain. Step 9 attaches it.
- **The window's migrations are safe for the `apps/api` that is serving** while they apply (the
  soaked pre-spec-300 release in production; the `develop` tip before the merge on staging): the
  table in step 7.

**Check:** each item ticked in the release record by name. **Abort:** postpone the window.

## 2. Comms and alert silencing

Post the maintenance notice: the time window; "you will be asked to sign in again"; and
"**accounts created and passwords changed during the maintenance window do not carry over**:
after it, sign up again, or reset your password again". Silence the uptime and Sentry alerts the
window would page on.

**Check:** the notice is visible; the alert silences are listed in the record.
**Abort:** none needed; un-silence if the window is postponed.

## 3. Maintenance mode on, web off, and `cutover_at`

The session of steps 3 to 10 starts here; record the time. Set `MAINTENANCE_MODE=true` on
`backend` (Railway redeploys its current deployment with it: the same commit, still the legacy
code). Detach the web domain from the web service (the legacy web service in production; the
staging web service on staging). Then take **`cutover_at`** from the app database's own clock:

```bash
export CUTOVER_AT="$(psql "$APP_DATABASE_URL" -X -At -c "select now()")"
echo "$CUTOVER_AT"                                 # into the release record
```

It is taken **here**, after maintenance is on and before the copy, so the rollback's "users
created at or after `cutover_at`" catches every user the window or the new code creates.

**What maintenance mode covers (owner-accepted residual, 2026-10-19).** The legacy app asks
`/v2/app-check` at launch and shows its maintenance screen; the legacy `apps/api` itself keeps
serving every route until step 10. The owner's position: clients don't ignore maintenance mode,
so no legacy write is expected between the copy and the new code. If one happens anyway:
- a sign-up during the window has an app row and no auth account: the user signs up again at
  `apps/auth`, and the orphan-row procedure (below) clears the email conflict;
- a password change or reset during the window is not in the auth database: the user resets again.

`MAINTENANCE_MODE` takes effect only once that redeploy is healthy: until then the probe below
prints `false`, which is not a failure; wait and re-run it.

**Check:**
`curl -s https://api.askansari.ai/api/v2/app-check -H 'Content-Type: application/json' -d '{"platform":"ios","native_application_version":"1.0.0","native_build_version":"1"}' | jq .maintenance_mode`
prints `true`, and the same for `https://api-35.ansari.chat`; the web domain no longer serves the
web app; `cutover_at` and the session start are in the record.
**Abort:** `MAINTENANCE_MODE=false`, re-attach the web domain. Nothing else has changed.

## 4. Snapshots

Take a Railway snapshot (or note the PITR mark) of the **app database**, and of the (empty)
**auth database**.

**Check:** both snapshot ids or PITR timestamps are in the record.
**Abort:** step 3's abort.

## 5. The auth baseline

The **whole auth journal**, every migration in `packages/auth/drizzle/meta/_journal.json`, in
its order (`0000_auth_schema`, `0001_api_key` and any later one), one
`psql -X -v ON_ERROR_STOP=1 --single-transaction` per file, from the operator environment. It
runs **before** the copy (step 6): the auth database is empty here, so no constraint can fail at
apply, and the copy then runs against the final schema in its one transaction, where a duplicate
aborts cleanly. (The duplicate pre-check in the service-keys runbook is for a database that
already holds data, staging; not this one.)

```bash
for f in $(node apps/auth/scripts/cutover/auth-journal.mjs files); do psql "$AUTH_DATABASE_URL" -X -v ON_ERROR_STOP=1 --single-transaction -f "$f" || break; done
set -o pipefail
node apps/auth/scripts/cutover/auth-journal.mjs check | psql "$AUTH_DATABASE_URL" -X -q -At -v ON_ERROR_STOP=1
```

`auth-journal.mjs` reads the journal: `files` lists the files in order, and `check` prints SQL
that checks each migration's objects (every schema, table, column, constraint and index it
creates), so a later migration needs no edit here. A failed apply stops the loop, and the check
then names what is missing.

`set -o pipefail` (bash and zsh) makes the check line fail when `auth-journal.mjs` fails, instead
of psql reading empty input and exiting 0.

**Check:** the check prints one `<tag>|t` line per file `files` listed, in the same order, and
nothing else (it fails, naming the migrations, when one is not applied). **No output at all is a
failure**: stop. And
`psql "$AUTH_DATABASE_URL" -X -At -c "select count(*) from auth.users"` prints `0`.
Record one `auth-journal-applied: <tag>` line per tag it printed, and the commit. Now the auth URL also answers
for the auth schema: `psql "$AUTH_DATABASE_URL" -X -At -c "select to_regclass('auth.users')"`
prints `auth.users`.
**Abort:** `psql "$AUTH_DATABASE_URL" -X -c 'DROP SCHEMA auth CASCADE'`, then step 3's abort.

## 6. The copy and the audits

Re-run the preflight first; it must show no collision, `no_password_hash = 0`, `not_bcrypt = 0` and no NULL timestamp. Then copy:

```bash
psql "$APP_DATABASE_URL" -X -v ON_ERROR_STOP=1 -f apps/auth/scripts/cutover/00-preflight-app.sql
apps/auth/scripts/cutover/copy.sh
```

**Check:** `copy.sh` exits 0 and prints `copy.sh: audit OK`, with the same six lines for the app
and the auth side (`rows` equal to the preflight's `to_copy`). Record both blocks.
**Abort:** do **not** run step 7. Empty the auth database (`DROP SCHEMA auth CASCADE`), and
either re-run from step 5 or take step 3's abort (the legacy code is still serving).

## 7. The app window migration

From the operator environment, in journal order, each applied only if not already applied
(`0009` and `0010` may have shipped earlier; the release record says). The legacy `apps/api` is
still serving while they apply:

```bash
psql "$APP_DATABASE_URL" -X -v ON_ERROR_STOP=1 --single-transaction -f apps/api/drizzle/0009_better_auth_scaffold_cleanup.sql
psql "$APP_DATABASE_URL" -X -v ON_ERROR_STOP=1 --single-transaction -f apps/api/drizzle/0010_deleted_users.sql
psql "$APP_DATABASE_URL" -X -v ON_ERROR_STOP=1 --single-transaction -f apps/api/drizzle/0011_better_auth_window.sql
```

**Why the serving `apps/api` is unaffected** (main, M1). The serving code's schema
(`apps/api/db/schema/` before spec 300: `users`, `tokens`, `threads`, `messages`, `feedback`,
`shares`, `preferences`, `tool-call-orphans`) is the evidence:

| File | What it does | The serving `apps/api` |
|---|---|---|
| `0009_better_auth_scaffold_cleanup.sql` | Drops the #59 scaffold tables `public.user`, `session`, `account` and `verification`, and refuses if any holds rows | Has no schema for them and no query on them |
| `0010_deleted_users.sql` | Creates `public.deleted_users` | Additive; never reads or writes it |
| `0011_better_auth_window.sql` | Sets `users.email` to `lower(trim(email))`; drops `NOT NULL` from `users.password_hash` | No column is dropped or renamed, and dropping a `NOT NULL` cannot fail a write. Legacy login looks a user up by `eq(users.email, email.toLowerCase())`, so a mixed-case legacy row, which it could never match before, matches during the window; a typed address with surrounding spaces still fails, as before |

**Check:** `psql "$APP_DATABASE_URL" -X -At -c "select to_regclass('public.deleted_users') is not null"`
prints `t` (`0010` landed: the tombstone table `DELETE me` and first use read), `psql "$APP_DATABASE_URL" -X -At -c "select is_nullable from information_schema.columns where table_schema = 'public' and table_name = 'users' and column_name = 'password_hash'"`
prints `YES` (`0011` landed: rows created on first use carry no hash), and `psql "$APP_DATABASE_URL" -X -At -c "select count(*) from users where email <> lower(trim(email))"`
prints `0`. A skipped migration must not pass into step 10: the new `apps/api` would refuse every
first use and every delete, a total auth outage. Each guard is one `DO` block: a guard failure aborts its file with nothing applied.
**Abort:** a guard failure changed nothing; the legacy code still serves on this database. Empty
the auth database and take step 3's abort, then investigate. A migration that applied is
harmless to the legacy code (the table above) and stays.

## 8. Admin roles

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
in this step (spec H-7).

**Check:** `05-audit-admins-auth.sql` prints exactly the approved list, one address per line. A
legacy admin left off the list holds no admin role. The role in `auth.users` is the only admin
truth; nothing at boot checks a list.
**Abort:** `(cd apps/auth && DATABASE_URL="$AUTH_DATABASE_URL" pnpm exec tsx scripts/grant-admin.ts --revoke <email>)`
for any extra; fix and re-check.

## 9. Attach `auth.askansari.ai` (spec H-5)

Now, after the copy (step 6) and the admin roles (step 8), and before step 10 deploys anything
(main, M3): attach the domain to the `auth` service, targeting **`PORT` (3100)**. Never before the
copy: a reachable `apps/auth` would accept sign-ups into `auth.users`, and the copy's empty-target
guard would abort. `auth` has **no active deployment** yet (step 1), so the domain serves nothing
until step 10, while Railway issues its certificate.

```bash
curl -s -o /dev/null -w '%{http_code}' https://auth.askansari.ai/health
```

**Check:** the domain is listed on the `auth` service, and the probe prints `404` or `502` over
https with a **valid certificate** (plain `curl`, never `-k`: a certificate error prints `000`,
which is not a pass; wait for the certificate). A `200` means a deployment is live on the domain
before the new code: stop, detach the domain, and remove that deployment.
**Abort:** detach the domain, empty the auth database (`DROP SCHEMA auth CASCADE`), then step 3's
abort. Nothing has deployed.

## 10. Promote `develop` to `main` (staging: merge the cutover PR)

The last step of the session, right after step 9. In production, the fast-forward of
`RELEASE.md`'s standard checklist, pushed straight to `main`: `main`'s protection requires a PR
but does not bind admins, so only an **admin** can run that push; on staging, the cutover PR's merge. Auto-deploy then builds
and deploys `auth`, `backend` and the web service from this commit.

```bash
git fetch origin && [ "$(git rev-parse origin/develop)" = "$(git rev-parse HEAD)" ] && echo develop-unchanged   # production, before the push
git fetch origin && git push origin origin/develop:main          # production
git fetch origin && git diff-tree --quiet HEAD origin/main && echo same-tree   # origin/develop on staging
```

**Check:** in production, the first line prints `develop-unchanged` **before** the push (a
`develop` tip that moved during the session is caught before anything deploys: do not push), and
afterwards `git rev-parse origin/main` equals the checkout's `HEAD`; on both, the
`diff-tree` line prints `same-tree` (the deployed tree is the one every script ran from), and a
deployment of that commit has started on `auth`, `backend` and the web service. Record the commit
and the session's elapsed time from step 3.
**Abort:** a rejected push deployed nothing: take step 9's abort. A tree that differs means the
deploys run code the scripts did not run from: follow [`rollback.md`](rollback.md).

## 11. The deploys: `auth`, `backend` and web

Wait for the three deployments. In production this is the `auth` service's **first build and
deploy**: the staging rehearsal is what proves the image builds. Until `auth` is healthy, the new
`apps/api`'s sign-ins and first uses fail closed with `503` (never a grant), and maintenance mode
covers it. If the `auth` build or deploy fails, the new `apps/api` stays up answering `503` under
maintenance: that is [`rollback.md`](rollback.md) from step 1.

```bash
curl -fsS https://auth.askansari.ai/health
curl -fsS https://auth.askansari.ai/api/auth/jwks | jq '.keys | length'
curl -s -o /dev/null -w '%{http_code}' https://auth.askansari.ai/internal/users/00000000-0000-0000-0000-000000000000/profile
curl -s -o /dev/null -w '%{http_code}' https://auth.askansari.ai/api/account/me
```

Then the edge properties on the auth domain's probe, as in step 12, on every path it has (via
Cloudflare if proxied, and direct with `--resolve`), over IPv4 and IPv6:
`curl -s -H 'X-Real-IP: 192.0.2.66' -H 'X-Forwarded-For: 192.0.2.66' -H 'CF-Connecting-IP: 192.0.2.66' https://auth.askansari.ai/__diag/client-ip`.

**Check:** all three deployments are healthy and their deployed commit is step 10's; `/health`
returns 200 over https with a **valid certificate**; the JWKS prints `1` or more; `/internal/…`
prints `404` (there is no internal route); `/api/account/me` with no token prints `401`; the probe
shows your real address on every path, and a second network a different one. On each
`*.up.railway.app` domain of `backend`, the P-4 probe
`curl -s https://<backend>.up.railway.app/api/v2/_diag/client-ip` shows your own IP as
`x_real_ip`. Record them in [`edge-check.md`](edge-check.md).
**Abort:** follow [`rollback.md`](rollback.md). An edge failure alone is step 12's abort.

## 12. Edge probe on the `apps/api` production domains (P-4)

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

## 13. Replace legacy web with `apps/frontend`

Attach the web domain, detached in step 3, to the `apps/frontend` web service, which step 10
rebuilt with both build variables (owner, 2026-10-16: legacy web retires at go-live).

**Check:** the web domain serves `apps/frontend` (its page title and the sign-in sheet), and a
private window provisions a guest (one `sign-up/email` then one `token` at `auth.askansari.ai`).
**Abort:** detach the domain; follow [`rollback.md`](rollback.md).

## 14. Public smoke tests (scenario 31)

On the production web app, in a private window: open the app (a guest is provisioned), sign up
a throwaway account, sign out, sign in, ask one question. Request a password reset for it and
complete the reset from the email. Delete the account at `/delete-account`.

**Check:** each succeeds; the reset email's link has the shape
`https://<web domain>/reset-password?token=…` and opens the reset page.
**Abort:** follow [`rollback.md`](rollback.md).

## 15. Maintenance mode off

Set `MAINTENANCE_MODE=false` on `backend` (Railway redeploys the current deployment with it).
Apps that showed the maintenance screen show it until they are relaunched.

**Check:** step 3's `app-check` probe prints `false` on both domains, and a released mobile
build, relaunched, signs in through `/v2/users/login` (the compatibility layer) and loads its
threads.
**Abort:** follow [`rollback.md`](rollback.md).

## 16. Re-enable alerting and close the record

Un-silence the alerts from step 2. Complete the release record: the promoted commit, each applied
file with its commit, `cutover_at`, the session's duration (steps 3 to 10), the rollback deadline
(`cutover_at` + 24 hours), and every check's output. Auto-deploy was never turned off.

Remove the environment's Tailscale forwarder service, and revoke its auth key in the Tailscale
admin console.

**Check:** the record is complete and posted; `tailscale status` no
longer lists the forwarder; the forwarder's key shows as revoked in the Tailscale admin console.
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
- **A sign-up, password change or reset during the maintenance window does not carry over**
  (owner-accepted residual, step 3): a sign-up has an app row and no auth account, so the user
  signs up again and the orphan-row procedure (above) clears the email conflict; a password change
  or reset is not in the auth database, so the user resets again. The maintenance notice says so.
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
