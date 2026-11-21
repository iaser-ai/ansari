# Better Auth cutover: the window runbook (spec 300)

The production cutover from `apps/api`'s legacy JWT auth to `apps/auth` (Better Auth). Read
it whole before the window. Every step names the file it runs, the commit it is applied from,
a **check** that is mechanical (a command and the output it must show) and the **abort**
action if the check fails. Rollback, within 24 hours, is [`rollback.md`](rollback.md). The
operator SQL is described in
[`apps/auth/scripts/cutover/README.md`](../../apps/auth/scripts/cutover/README.md).
The commands alone, in order, are in [`deploy-guide.md`](deploy-guide.md).

**A backend-only release (owner, 2026-11-21; #416).** The production window releases `apps/api`
and `apps/auth`. Production web **stays on `legacy/frontend-web`**, served by the legacy web
service, which is the only web service in production. `apps/frontend` is **not** released to
production in this window, and nothing in this runbook swaps the web app. The production `auth`
service and its `auth.askansari.ai` domain stay serving until the window, and the auth schema
(`0000_auth_schema`, `0001_api_key`) was applied ahead of it. The user copy, the app migrations
`0009` to `0011` and the admin grants stay in the window. The record is
[`release-record.md`](release-record.md).

**What the promotion carries (measured 2026-11-21).** `main` is **not** "current except for spec
300". It is the 2026-09-24 release (`debee8e8`, PR #180) plus the #383 hotfix (PR #384, merged
2026-11-13): `origin/main` is `27531c8f`. `git rev-list --count origin/main..origin/develop`
printed `1469` against `develop` at `3a30749c`, and `git rev-list --count origin/develop..origin/main`
printed `0`, so step 10's push is a fast-forward that promotes **all** of those commits, spec 300
among them. Re-measure both counts on the day, against the commit being promoted, and record them.
The app journal of `origin/main` ends at `0008_model_provenance` and `develop`'s at
`0011_better_auth_window`, so step 7's three files are the whole app-schema difference.
`legacy/frontend-web` is identical on both (`git diff --stat origin/main origin/develop -- legacy/frontend-web`
prints nothing). Not established: which Railway services rebuild on the push (watch paths are
dashboard configuration). If the legacy web service rebuilds, it builds the same sources.

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
- **The checkout is a fresh clone at the commit being promoted** (#416), the one step 1 records,
  never a builder worktree. The `builder-spir-300` worktree named here before is at `6ed22431`
  (2026-10-19). It has no `auth-journal.mjs` and no `0001_api_key.sql`, and its `copy.sh`,
  `02-import-auth.sql` and `grant-admin.ts` are older. Before anything else, verify the checkout.
  `<recorded commit>` is the full hash in the release record:

  ```bash
  git fetch origin && git checkout --detach <recorded commit>
  [ "$(git rev-parse HEAD)" = "<recorded commit>" ] && echo checkout-at-recorded-commit
  ls apps/auth/scripts/cutover/auth-journal.mjs packages/auth/drizzle/0001_api_key.sql
  pnpm install --frozen-lockfile
  ```

  The second line prints `checkout-at-recorded-commit`, and `ls` lists both files with no error.
  `pnpm install` is there because the operator scripts run through `pnpm exec tsx`, which a
  fresh clone does not have yet.
- **No edits in the checkout during the window.** Nothing checks the checkout after this, so an
  edit made mid-window would run unnoticed.
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

> **Production, 2026-11-21:** production's auth journal is already applied
> ([`release-record.md`](release-record.md)), so there the dry run finds the schema and adds no
> baseline; it still leaves zero users and accounts behind, which `copy.sh` checks.

**`psql`.** Every `psql` that applies a migration is `psql -X -v ON_ERROR_STOP=1 --single-transaction -f <file>`:
with both flags, a failed statement stops the run **and** rolls back everything before it. The
cutover scripts are the exception named in their README: they open their own transaction and
run without `--single-transaction`.

**Release record.** Keep one record for the window, in the release notes. It gets the promoted
commit, every SQL file with the commit it was applied from, `cutover_at`, every check's output
(counts and checksums only) and every decision taken.

> **Production, 2026-11-21:** the production record is [`release-record.md`](release-record.md);
> it already holds the early apply of the auth journal.

**Freeze.** From the merge of the cutover PR to the end of the production window, **nothing**
merges to `develop` except the staging rehearsal's docs-only evidence PR (owner amendment R-2).
So the staging rehearsal runs on exactly what production receives. Before its merge, the cutover
PR is brought current with `develop` and nothing else merges ahead of it: on staging the
scripts run from the PR head, and step 10 checks that the merge commit's tree equals it.

**Auto-deploy stays on (owner decision, 2026-10-19).** Railway deploys `backend` and `auth` from
the branch on every push, and nothing turns that off; the web service too where its watch paths
match the push (dashboard configuration, not established from the repo; in production the web
service is legacy web, whose sources the promotion does not change). So the new code's
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
| Step 10 promotes `develop` to `main`; Railway auto-deploys `auth` and `backend` from `main` (production web is legacy web, which this release does not change) | Step 10 **merges the cutover PR** to `develop`; Railway auto-deploys the staging services from `develop` |
| The scripts run from the `develop` tip about to be promoted | The scripts run from the **cutover PR's head**, current with `develop` (the freeze); step 10 checks that the merge commit's tree equals it |
| The operator environment, with production's URLs | The **same machine, forwarder setup and checkout path**, with staging's forwarder and URLs (the rehearsal proves this environment, not only the SQL); `CUTOVER_ENV=staging`, which the seed also requires |
| `api.askansari.ai`, `api-35.ansari.chat`; `auth.askansari.ai`; the production web domain | `api-staging.askansari.ai`; `auth-staging.askansari.ai`; the staging web domain. Service names are on main's sheet |
| The `auth` service has a live deployment and its domain attached, and keeps both (owner, 2026-11-21; [`release-record.md`](release-record.md)) | Staging `auth` already exists and runs the PIR #59 code: **remove its active deployment before step 9** (record its ID), so the domain attached in step 9 serves nothing until the merge deploys the new code |
| The auth database is created for the window, or found (C-4). **2026-11-21:** it exists and the auth journal is already applied ([`release-record.md`](release-record.md)); step 1 checks it holds no users and no accounts | It already exists, empty, on Postgres 18. Step 1's empty and version checks apply as written |
| The app database is production's | The staging app database (Postgres 18) with its **existing staging users**, no production restore (R-1), plus the anomaly seed below |
| Step 1 records the rollback targets: `backend`, the legacy web service and `auth` (deployment ID and commit, or none) | `backend`, the **staging web service** (it already serves `apps/frontend`) and `auth` (the PIR #59 deployment removed before step 9) |
| Step 2: the public maintenance notice | The team only; no public notice |
| Step 3 detaches the production web domain from the legacy web service; step 13 re-attaches it to the **same** legacy web service (no web swap: backend-only, owner 2026-11-21); [`rollback.md`](rollback.md) steps 1 and 4 detach and re-attach it the same way | Staging web **already serves `apps/frontend`**. Step 3 detaches its domain and step 13 re-attaches it, after the merge rebuilt it with `EXPO_PUBLIC_AUTH_URL`. Legacy web against the new `apps/api` is **not** part of this rehearsal ([`rehearsal.md`](rehearsal.md), residuals) |
| Step 9 **skips the attach** (the domain is already attached and serving) and expects `/health` `200`; steps 11 and 12 probe the production domains | `auth-staging.askansari.ai` attaches at step 9, after the admin roles and before the merge; its DNS record exists, unattached, before the run, and staging `backend`'s `AUTH_URL` is that domain before the merge. The staging domains are probed on **both paths**: via Cloudflare once the owner orange-clouds `api-staging` and `auth-staging`, and direct with `--resolve` ([`edge-check.md`](edge-check.md)). The staging verdict is recorded only after both paths are measured |
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

- **What the promotion carries is measured and recorded** (#416; the top of this runbook). The
  earlier precondition here, that `main` is current except for spec 300, is **false**. `main` is
  the 2026-09-24 release plus the #383 hotfix, and the promotion carries every commit of
  `origin/main..<commit being promoted>`. Record that count, the `origin/main` commit, and the
  commit of the `backend` deployment that is serving (the rollback target below). That deployment
  is the `apps/api` serving during steps 3 to 9. Step 7's table is derived from `origin/main`'s
  code. If the recorded `backend` commit is not `origin/main`'s tip, re-derive the table against it
  before starting.
- **The rollback targets are recorded, before anything changes.** In the release record, write
  the **current Railway deployment ID and its commit** for the `backend` service, the legacy web
  service and the `auth` service (`none` if it has no deployment; production, 2026-11-21: it has
  one, see [`release-record.md`](release-record.md)). On staging there is no legacy web, so record
  the staging web service instead. Rollback step 3 returns each service to exactly
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
    - **Production, 2026-11-21:** production's auth journal is already applied
      ([`release-record.md`](release-record.md)), so there the `auth` schema count prints `1`, not
      `0`; the auth database's emptiness is step 1's users-and-accounts count below.
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
  > **Production, 2026-11-21:** production's auth journal is already applied
  > ([`release-record.md`](release-record.md)), so the table count above is not `0` there. In
  > production the emptiness check is
  > `psql "$AUTH_DATABASE_URL" -X -At -c "select (select count(*) from auth.users) + (select count(*) from auth.account)"`,
  > which prints `0`, and step 5 runs only the journal check.
- Every **collision** the preflight lists is decided and resolved (the copy and `0011` abort on
  any), the preflight shows no NULL `created_at`/`updated_at` (the copy aborts on any: it
  copies timestamps exactly), and `not_bcrypt = 0` (the copy aborts on any hash that is not
  bcrypt `$2a$`/`$2b$` of length 60: apps/auth would send it to scrypt and the user could not
  sign in).
- **No web precondition.** `apps/frontend`'s pages (phases 10b #304 and 10c #306, and #307) and
  its web image's build guard (#317, parent #305) were preconditions only while `apps/frontend`
  replaced legacy web in this window. In the backend-only release (owner, 2026-11-21) they are
  not. Production web stays legacy web, which has its own reset-password page
  (`legacy/frontend-web/src/app/(public)/reset-password.tsx`) and delete-account page
  (`legacy/frontend-web/src/app/(app)/delete-account.tsx`).
- **Auto-deploy is ON for `backend`, the web service and `auth`, and stays on** (owner decision,
  2026-10-19). The next deploy of `backend` and `auth` is step 10's; the web service's is too
  only if its watch paths match the push (not established; legacy web's sources do not change).
  So **every variable the new code reads is set before step 3** (below), and nothing is pushed to the deploying branch between step 3 and step
  10 except step 10 itself. Applying a variable change in Railway redeploys the service's current
  deployment, so the `backend` edits restart the legacy api: make them at a quiet hour the day
  before, and check its health afterwards.
- Railway (main architect's runbook section): the `auth` service exists with its variables set
  (see `docs/self-hosting.md`; `auth` has no `ADMIN_EMAILS`: spec H-7); one port, `PORT=3100`;
  its own Postgres with snapshots or PITR **on**. Then, by environment:
  - **Production (owner's decision, 2026-11-21; [`release-record.md`](release-record.md)):**
    `auth` **has** a live deployment and `auth.askansari.ai` **is attached**, and both stay so
    through the window. Check: `curl -s -o /dev/null -w '%{http_code}' https://auth.askansari.ai/health`
    prints `200`, and the deployment's ID and commit are in the release record (above). The auth
    database holds the applied auth journal and no rows.
  - **Staging, and any environment without that decision:** **no domain yet** and **no active deployment**
    (staging: the PIR #59 deployment is removed, its ID recorded above). The auth database is
    **empty** (no schema yet). Neither `auth` nor `backend` carries
  `AUTH_INTERNAL_SECRET`, `AUTH_INTERNAL_URL` or `INTERNAL_PORT` (spec H-1: there is no internal
  hop). `backend` has the four variables the new code requires in production (it does not boot
  without them), read from its first deploy in step 10: `AUTH_URL=https://auth.askansari.ai` (the
  public domain), `AUTH_JWT_ISSUER=https://auth.askansari.ai` (set separately),
  `AUTH_JWT_AUDIENCE` and `AUTH_LAYER_ORIGIN=https://api.askansari.ai`, the last two equal to
  `auth`'s; and `MAINTENANCE_MODE=false` (step 3 sets it). `auth` has every variable
  `packages/auth/src/env.ts` requires, including `RESEND_API_KEY` and `FRONTEND_URL` (it now
  sends the reset emails). **`FRONTEND_URL` on `auth` is the web origin, which legacy web
  serves.** Legacy web and the new web share one origin (owner's statement, 2026-11-21), so the
  value needs no change. `auth`'s reset link is `${FRONTEND_URL}/reset-password?token=<token>`
  (`packages/auth/src/reset-email.ts`), and it lands on legacy web's `(public)/reset-password`
  page. That page reads `?token=` (`legacy/frontend-web/src/hooks/useTokenFromUrl.ts:5`,
  `src/app/(public)/reset-password.tsx:29`) and posts it as `reset_token` to
  `/api/v2/reset_password` (`src/services/UserService.ts:50,59`).
- **`MCP_COMPLETE_KEY_MODE=log-only` on `backend` is confirmed before the window** (#416). It is
  already set on the production `backend` service (owner's statement, 2026-11-21, not verified
  from the repo). Confirm it in the dashboard on the day and record it. This is a precondition
  to confirm, not a window step: setting it inside the window would redeploy `backend`. **No
  service key is issued in this window** (end of step 8), so after step 10 `log-only` is the only
  thing that keeps `mcp.ansari.chat` and the agent skill served: both send no key (#409), and an
  absent value means `enforce` (`apps/api/lib/config.ts`, `mcpCompleteKeyMode`), which answers
  every such call with 401. **If the variable is absent, or `enforce`, do not start.**
- **WhatsApp is out of this window** (owner's decision, 2026-11-21; #336 open). Not established:
  what serves production WhatsApp today. `origin/main` has no `legacy/whatsapp` and no WhatsApp
  reference under `apps/api/src` or `apps/api/lib` (`git grep -i whatsapp origin/main -- apps/api/src apps/api/lib`
  prints nothing; the same pattern on `origin/main` matches the `ansari-3-announce.md` files under
  `legacy/`, so it can match).
- **`backend` keeps its legacy variables** `JWT_SECRET`, `ACCESS_TOKEN_EXPIRY_HOURS`,
  `REFRESH_TOKEN_EXPIRY_HOURS`, `ADMIN_EMAILS`, `RESEND_API_KEY` and `FRONTEND_URL` until the
  contract PR: the legacy code serves until step 10, and the rollback redeploys it. It does not
  boot without `JWT_SECRET`, and its admin access and reset emails need the others.
- `CORS_ORIGIN` on `auth` lists the **real web origins** (`packages/auth/src/env.ts` requires
  it). No CI check can see this. In this release no production web client calls `auth`
  directly: legacy web sends every request to its one base URL, `EXPO_PUBLIC_API_V2_URL`
  (`legacy/frontend-web/src/services/ApiService.ts:35`, `ChatService.ts:19`,
  `UserService.ts:11`), which is `apps/api`. A wrong value would fail a browser client that signs
  in at `auth` itself (`apps/frontend`, on staging).
- **The web service needs no change** (backend-only, owner 2026-11-21). The production web
  service is legacy web. Its API base URL is baked in at build time
  (`legacy/frontend-web/Dockerfile:7,18`), and its value lives in the Railway dashboard, not in the
  repo. The `EXPO_PUBLIC_*` variables of `apps/frontend`'s web image are not set for this window.
- **The DNS record for `auth.askansari.ai` exists before the window and is not attached** (spec
  H-5): `dig +short auth.askansari.ai` answers (the Railway target, or Cloudflare's proxy if it is
  orange-clouded), and the `auth` service lists no custom domain. Step 9 attaches it.
  (**Production, 2026-11-21:** already attached and serving, by the owner's decision; see
  [`release-record.md`](release-record.md).)
- **The window's migrations are safe for the `apps/api` that is serving** while they apply
  (`origin/main`'s code in production, `27531c8f` when measured; the `develop` tip before the
  merge on staging): the table in step 7.

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
code). Detach the web domain from the web service (the legacy web service in production, the only
web service there; the staging web service on staging). Step 13 re-attaches it to the same
service (owner, 2026-11-21). Then take **`cutover_at`** from the app database's own clock:

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

**Why the web domain is detached (owner, 2026-11-21): legacy web does not honour maintenance
mode, so only the detach stops web traffic.** Read from the tree:
- `MAINTENANCE_MODE` changes only the `/api/v2/app-check` answer. Its only readers are
  `apps/api/lib/config.ts`, which exposes it as `appVersion.maintenanceMode`, and
  `apps/api/src/app/api/v2/app-check/route.ts:21` (answered at `:26` and `:66`). This holds on
  `develop` and on `origin/main` (`git grep -n MAINTENANCE_MODE <ref> -- apps/api/lib apps/api/src`
  and `git grep -n maintenanceMode <ref> -- apps/api/lib apps/api/src`). No route refuses because
  of it: the api keeps serving every route.
- `legacy/frontend-web` never asks. `git grep -n -i -E "maintenance|app-check|app_check" <ref> -- legacy/frontend-web`
  prints nothing for `origin/develop` or `origin/main`. The same pattern on
  `legacy/frontend-app` finds its maintenance screen (`src/app/_layout.tsx:124-125`), so the scan
  can match. Legacy web has no handler for an api that is down or answers 5xx either. Its fetch
  wrapper acts on 401 only (`src/services/ApiService.ts:157`). A failed session restore at
  launch leaves the user signed out (`src/store/slices/authSlice.ts:160`), and a failed message
  send is only logged to the console (`src/components/chat/ChatContainer.tsx:33-34`).

So while the domain is attached, legacy web keeps signing users up and in, resetting passwords
and chatting against whichever `apps/api` is serving: the legacy code until step 10, then the new
code. The residual above would then hold for every web user in the window, not only for a client
that ignores maintenance mode.

`MAINTENANCE_MODE` takes effect only once that redeploy is healthy: until then the probe below
prints `false`, which is not a failure; wait and re-run it.

**Check:**
`curl -s https://api.askansari.ai/api/v2/app-check -H 'Content-Type: application/json' -d '{"platform":"ios","native_application_version":"1.0.0","native_build_version":"1"}' | jq .maintenance_mode`
prints `true`, and the same for `https://api-35.ansari.chat`; the web domain no longer serves the
web app; `cutover_at` and the session start are in the record.
**Abort:** `MAINTENANCE_MODE=false`, re-attach the web domain. Nothing else has changed.

## 4. Snapshots

Take a Railway snapshot (or note the PITR mark) of the **app database**, and of the (empty)
**auth database** (production, 2026-11-21: schema applied, no rows; see
[`release-record.md`](release-record.md)).

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

> **Production, 2026-11-21:** production's auth journal (`0000_auth_schema`, `0001_api_key`) is
> already applied, ahead of the window ([`release-record.md`](release-record.md)). In production
> this step runs **only the journal check** below (the `set -o pipefail` and `check` lines), and
> applies only a file the check reports missing (a journal file newer than the record), one at a
> time, with `psql "$AUTH_DATABASE_URL" -X -v ON_ERROR_STOP=1 --single-transaction -f packages/auth/drizzle/<tag>.sql`.
> The `for` loop is **not** run in production: it would re-apply `0000_auth_schema` and stop on
> its error. **Exception:** after a `DROP SCHEMA auth CASCADE` (an abort, or
> [`rollback.md`](rollback.md)'s restart), every file is missing, so the loop **is** run as
> printed. Record an `auth-journal-applied` line only for a file applied in the
> window. The empty check is
> `psql "$AUTH_DATABASE_URL" -X -At -c "select (select count(*) from auth.users) + (select count(*) from auth.account)"`,
> which prints `0`.

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

> **Production, 2026-11-21:** no `create-service` or `create-key` in production before this
> step's `copy.sh: audit OK`: a service user is a row in `auth.users` and `auth.account`, and the
> copy then refuses (`auth.users is not empty`). No service keys are issued in this window at all
> (owner's decision, 2026-11-21; the end of step 8). The `auth` domain
> serves until the window, so a sign-up there would also make the copy refuse. In production,
> therefore, the second line below (the users-and-accounts count) runs **immediately before** the
> copy and must print `0`. If it does not, empty the auth database (`DROP SCHEMA auth CASCADE`)
> and re-run from step 5, running its `for` loop as printed, then reverse the apply record.

Re-run the preflight first; it must show no collision, `no_password_hash = 0`, `not_bcrypt = 0` and no NULL timestamp. Then copy:

```bash
psql "$APP_DATABASE_URL" -X -v ON_ERROR_STOP=1 -f apps/auth/scripts/cutover/00-preflight-app.sql
psql "$AUTH_DATABASE_URL" -X -At -c "select (select count(*) from auth.users) + (select count(*) from auth.account)"
apps/auth/scripts/cutover/copy.sh
```

**Check:** the users-and-accounts count prints `0`; `copy.sh` exits 0 and prints `copy.sh: audit OK`, with the same six lines for the app
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

**Why the serving `apps/api` is unaffected** (main, M1; re-derived for #416). The evidence is
the code `origin/main` serves, `27531c8f`, read with `git show origin/main:<path>` and
`git grep <pattern> origin/main -- apps/api` on 2026-11-21. It is not `develop` minus spec 300.
Its schema (`apps/api/db/schema/index.ts` on `origin/main`) exports exactly `users`, `tokens`,
`threads`, `messages`, `feedback`, `shares`, `preferences` and `tool-call-orphans`. Its journal
ends at `0008_model_provenance`. If the recorded `backend` commit (step 1) is not `origin/main`'s
tip, re-run these reads against that commit.

| File | What it does | The serving `apps/api` (`origin/main`) |
|---|---|---|
| `0009_better_auth_scaffold_cleanup.sql` | Drops the #59 scaffold tables `public.user`, `session`, `account` and `verification`, and refuses if any holds rows | Has no schema for them (no `pgTable` of those names under `apps/api/db/schema/`), and none of its migrations `0000` to `0008` creates them |
| `0010_deleted_users.sql` | Creates `public.deleted_users` | Additive. `git grep -E "deleted_users\|deletedUsers" origin/main -- apps/api` finds nothing: it never reads or writes it |
| `0011_better_auth_window.sql` | Sets `users.email` to `lower(trim(email))`; drops `NOT NULL` from `users.password_hash` | No column is dropped or renamed. Every insert it makes writes a hash: register's hash (`src/app/api/v2/users/register/route.ts`), and `'nologin'` for system rows (`lib/db/users.ts:64`). So dropping a `NOT NULL` cannot fail a write. Its one email lookup, `findUserByEmail` (`lib/db/users.ts:16`), is `eq(users.email, email.toLowerCase())`. Login, the reset request and the `ADMIN_EMAILS` boot check (`lib/auth/startup-checks.ts:33`) use it, and `createUser` stores `email.toLowerCase()` (`lib/db/users.ts:106`). So a mixed-case legacy row, which it could never match before, matches during the window. Its login schema does not trim (`z.string().email(...)`), so a typed address with surrounding spaces still fails, as before |

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

**No service keys in this window** (owner's decision, 2026-11-21). There is no `create-service`
and no `create-key` anywhere in the window. The `ansari-mcp` and WhatsApp keys are issued
**after the window closes**, by [`service-keys-runbook.md`](service-keys-runbook.md), and never
before step 6's `copy.sh: audit OK` (a service user is a row in `auth.users` and `auth.account`,
and the copy refuses a non-empty `auth.users`). Until then `mcp.ansari.chat` and the agent skill
are served only because `MCP_COMPLETE_KEY_MODE=log-only` (step 1).

## 9. Attach `auth.askansari.ai` (spec H-5)

After the copy (step 6) and the admin roles (step 8), and before step 10 deploys anything
(main, M3). The same probe in both branches; what it must print differs:

```bash
curl -s -o /dev/null -w '%{http_code}' https://auth.askansari.ai/health
```

### Production: skip the attach (owner's decision, 2026-11-21)

The domain is already attached to `auth` and served by its existing deployment, which stays
([`release-record.md`](release-record.md), deviation and owner decisions). **Do not attach,
detach or remove anything.** Run the probe.

**Check (production):** the domain is listed on the `auth` service; the probe prints `200` over
https with a valid certificate (plain `curl`, never `-k`; `000` is a certificate or network
failure, not a pass); and the `auth` deployment live in the dashboard is the one step 1 recorded
(no new deployment has appeared).
**Abort (production):** do **not** detach the domain or remove the deployment. Empty the auth
database (`psql "$AUTH_DATABASE_URL" -X -c 'DROP SCHEMA auth CASCADE'`), reverse the apply record
in [`release-record.md`](release-record.md) (its "Reversing it" paragraph), then step 3's abort.
Nothing new has deployed.

### Staging, and any environment without that decision: attach

Attach the domain to the `auth` service, targeting **`PORT` (3100)**. Never before the
copy: a reachable `apps/auth` would accept sign-ups into `auth.users`, and the copy's empty-target
guard would abort. `auth` has **no active deployment** yet (step 1), so the domain serves nothing
until step 10, while Railway issues its certificate.

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
and deploys `auth` and `backend` from this commit (on staging, the staging web service too). The
production web service is legacy web, which this release does not change (`legacy/frontend-web`
is identical on both sides of the push; see the top of this runbook).

```bash
git fetch origin && [ "$(git rev-parse origin/develop)" = "$(git rev-parse HEAD)" ] && echo develop-unchanged   # production, before the push
git fetch origin && git push origin origin/develop:main          # production
git fetch origin && git diff-tree --quiet HEAD origin/main && echo same-tree   # origin/develop on staging
```

**Check:** in production, the first line prints `develop-unchanged` **before** the push (a
`develop` tip that moved during the session is caught before anything deploys: do not push), and
afterwards `git rev-parse origin/main` equals the checkout's `HEAD`; on both, the
`diff-tree` line prints `same-tree` (the deployed tree is the one every script ran from), and a
deployment of that commit has started on `auth` and `backend` (staging: and the web service). Record the commit
and the session's elapsed time from step 3.
**Abort:** a rejected push deployed nothing: take step 9's abort. A tree that differs means the
deploys run code the scripts did not run from: follow [`rollback.md`](rollback.md).

## 11. The deploys: `auth` and `backend`

Wait for the deployments of step 10's commit on `auth` and `backend` (and on the web service
only if it rebuilt: staging's always does; production's legacy web only if its watch paths
matched).

- **Production:** `auth` already has a live deployment (owner's decision, 2026-11-21;
  [`release-record.md`](release-record.md)), so step 10's is its first deploy **from `main`**,
  replacing that one. Until the new one passes its healthcheck, Railway keeps the previous one
  serving (`RELEASE.md`: a deploy that fails its healthcheck leaves the previous deployment).
- **Staging, and any environment without that decision:** this is the `auth` service's **first build and
  deploy**.

The staging rehearsal is what proves the image builds. Until `auth` is healthy, the new
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

**Check:** `auth` and `backend` are healthy and their deployed commit is step 10's (production:
the `auth` deployment ID differs from the one step 1 recorded); `/health`
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

## 13. The web domain back on legacy web

Re-attach the web domain, detached in step 3, to the **same** web service: in production the
legacy web service, the only web service there (backend-only release, owner 2026-11-21; this
replaces the earlier swap to `apps/frontend`, and the owner's 2026-10-16 "legacy web retires at
go-live" does not apply to this window). On staging, the staging web service.

**Check:** the web domain serves legacy web again (production; staging: the staging web
service), and that service's deployed commit is the one step 1 recorded for it, or step 10's if
the push rebuilt it.
**Abort:** detach the domain; follow [`rollback.md`](rollback.md).

## 14. Public smoke tests (scenario 31)

On **legacy web** (production's web app; #416), in a private window. Each flow and the
`/api/v2` route it calls, read from `legacy/frontend-web/src` (base URL
`EXPO_PUBLIC_API_V2_URL`, which includes `/api/v2`):

| Flow | Route | Where |
|---|---|---|
| Continue as a guest | `POST /users/register`, then `POST /users/login` with `guest: true` | `store/actions/authActions.ts` (`guestLogin`) |
| Sign up a throwaway account | `POST /users/register` | `services/ApiService.ts:47-48` |
| Sign out | `POST /users/logout` | `services/ApiService.ts:183-184` |
| Sign in (and the session restore at launch) | `POST /users/login`; `GET /users/me` | `services/ApiService.ts:64-65`; `store/slices/authSlice.ts` |
| Ask one question | `POST /threads`, then `POST /threads/<id>` (streamed), then `GET /threads/<id>` | `services/ChatService.ts:46-48`, `:83-84`, `:100-102` |
| Request a password reset | `POST /request_password_reset` | `services/UserService.ts:21-23` |
| Complete it from the email | the link opens `/reset-password?token=…`, which posts `POST /reset_password` | `app/(public)/reset-password.tsx:29,57`; `services/UserService.ts:48-50` |
| Delete the account at `/delete-account` | `DELETE /users/me` | `services/ApiService.ts:201-202` |

Then sign in with the new password before the delete, and try to sign in again after it.

**Check:** each succeeds; the reset email's link has the shape
`https://<web domain>/reset-password?token=…` and opens legacy web's reset page; after the
delete, a sign-in with that account **fails**. The page alone does not show the delete
succeeded: legacy web's delete page goes to `/welcome` even when the `DELETE` failed (the thunk is
dispatched without `.unwrap()`, `src/hooks/useDeleteAccount.ts:12`;
`src/app/(app)/delete-account.tsx:34-35`). On staging, step 14 runs on the staging web service
(`apps/frontend`). Legacy web against the new `apps/api` has not been run on staging (#416,
evidence still blank).
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
- **Users signed in to a real account before the cutover** open legacy web signed out: their
  stored legacy tokens are refused by the new `apps/api`, and a failed session restore at launch
  leaves them signed out (`legacy/frontend-web/src/store/slices/authSlice.ts:160`). Their account
  is unchanged; they sign in with the same email and password. Say this in the release note and
  the maintenance notice.
- **Key rotation is not revocation.** A rotated signing key does not invalidate existing JWTs
  until `apps/api`'s cached key set expires (10 minutes, plus a 15-minute grace while `apps/auth`
  is unreachable) or `apps/api` restarts. To cut a user off, ban them (`ban-user.ts`, which
  deletes their sessions); their JWT still verifies until it expires (15 minutes).
- **Reset links in access logs.** `GET /reset-password?token=…` is logged by the web host on every
  click. The token is single-use and expires after an hour. Changing the link shape is with the
  owner.
- **If the offline mechanism detaches domains,** `backend`'s `*.up.railway.app` domain stays
  reachable during the window. Accepted; the rehearsal records it.
