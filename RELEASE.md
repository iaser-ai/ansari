# Release Process

How Ansari's backend goes from `develop` to production. This codifies the
process that was previously in architect notes; the smoke sequence and the
migration runbook were both proven in real releases on 2026-08-02.

## Deployment model

- **`develop`** is the integration branch. It is protected: PRs only, with the
  required CI checks from `.github/workflows/ci.yml` —
  `backend (lint, typecheck, test, build)`, `frontend (lint, typecheck)`, and
  `gitleaks (secret scan)`. Of these, `develop`'s protection currently *requires*
  `backend (lint, typecheck, test, build)` and `gitleaks (secret scan)`.

  > **Naming note (spec 48) — deferred follow-up, not an action before merge.**
  > The first check's name looks stale and is stale **on purpose**. The monorepo
  > restructure moved the backend app under `apps/api/` and renamed that CI job's
  > **ID** to `api`, but its **emitted name** is deliberately left as
  > `backend (lint, typecheck, test, build)`.
  >
  > Required status checks are matched by **name**. Changing what the job emits
  > would mean the required check never reports again, leaving every PR
  > unmergeable until a repo admin edits the protection rule — and a job's ID and
  > emitted name are independent, so keeping the name costs nothing.
  >
  > Renaming it is a follow-up that must be done as one coordinated change: edit
  > `develop`'s required-check name **and** the `name:` line in
  > `.github/workflows/ci.yml` together. It needs repo-admin access. Do not change
  > either half on its own.
> ### Railway service configuration (spec 48 — monorepo layout)
>
> Both services build with the **repo root** as their Root Directory: the pnpm
> workspace needs the root `pnpm-lock.yaml`, and both Dockerfiles now also
> `COPY packages packages`. Do **not** set Root Directory to the app folder.
>
> | Service | Dockerfile path |
> |---|---|
> | backend | `apps/api/Dockerfile` |
> | frontend (web) | `apps/frontend/Dockerfile.web` |
> | auth | `apps/auth/Dockerfile` |
>
> **Watch paths** — set these per service, or Railway rebuilds *both* on every push
> (any commit touches the root lockfile):
>
> ```
> backend:   apps/api/**       packages/**  package.json  pnpm-lock.yaml  pnpm-workspace.yaml
> frontend:  apps/frontend/**  packages/**  package.json  pnpm-lock.yaml  pnpm-workspace.yaml
> auth:      apps/auth/**      packages/**  package.json  pnpm-lock.yaml  pnpm-workspace.yaml
> ```
>
> `packages/**` is **not optional**. The shared config packages are copied into both
> images, so a packages-only change alters the built artifact. Omit the pattern and
> that change ships nothing — no rebuild, no deploy, and no error. The image simply
> drifts from the repo.
>
> **Deploy settings** — backend healthcheck `/api/health` (timeout 300s), frontend
> healthcheck `/`, auth healthcheck `/health` (200 only when the auth database
> answers; timeout 300s); restart ON_FAILURE, max 3 retries.
>
> **auth service (spec 300)** — one listener: the public domain
> (`auth.askansari.ai`, `auth-staging.askansari.ai`) targets `PORT` (3100); set it as
> a service variable. `backend` reaches it at that domain too (`AUTH_URL`), like any
> client: no private-network hop, no shared secret (spec amendment H-1).
> It has its OWN Railway Postgres, the auth database, with snapshots or PITR
> enabled before its first real row, on Postgres 18 (C-4: the owner's service; in staging it
> already exists, empty; in production it is created or found, and checked empty in window step 1).
> Its image is the service only: no Postgres client
> and no migration SQL. The cutover runs from the owner's machine over the Tailscale route
> (spec amendment H-8; the runbook's "operator environment"). The two operator scripts run from
> a checkout with the auth database's `DATABASE_URL` (`pnpm exec tsx scripts/grant-admin.ts …`,
> `… scripts/ban-user.ts …`), or in the image from `/repo/apps/auth` with
> `./node_modules/.bin/tsx scripts/…` (tsx directly: the image has no pnpm for its non-root user).
>
> **frontend (web) build variables** — `Dockerfile.web` bakes `EXPO_PUBLIC_API_URL`
> and `EXPO_PUBLIC_AUTH_URL` into the bundle at build time, so both are set on the
> Railway service and a change needs a redeploy. They name the SAME environment:
> production `https://api.askansari.ai` + `https://auth.askansari.ai`, staging
> `https://api-staging.askansari.ai` + `https://auth-staging.askansari.ai` (the
> defaults when unset). The web app signs in at `EXPO_PUBLIC_AUTH_URL` (spec 300).
>
> **`apps/*/railway.toml` are not read by Railway here.** This project configures
> deployment through the dashboard with a Dockerfile path (confirmed by the operator,
> 2026-08-21). Railway does support a config-as-code path setting; this project does
> not use it. The tomls record the same values in git so the intended configuration
> stays reviewable — update them in the same PR whenever you change a dashboard
> setting, or the record drifts from reality.

- **`main`** is the production branch. The Railway service `backend` (a name in the
  Railway dashboard — unrelated to the `apps/api/` directory, and not stale)
  auto-deploys every push to `main`. Its effective settings are in the block above:
  root directory = repo root, dockerfile build from `apps/api/Dockerfile`,
  healthcheck `/api/health` with a 300s timeout, restart `ON_FAILURE` up to 3 times.
  `apps/api/railway.toml` records those same values in git.
- **Promotion is a fast-forward, nothing else.** `main` is moved to `develop`'s
  tip with `--ff-only` — no merge commits, no cherry-picks, so `main` is always
  an exact prefix of `develop`'s history.

## Standard release checklist (develop → main)

1. **CI green** on the `develop` tip you intend to ship.
2. **Pre-promotion local smoke test passes** (next section) on that same tip.
3. **Explicit human go.** A human says "release" — green CI alone is never a
   reason to promote.
4. **Promote (fast-forward only):**

   ```bash
   git fetch origin
   git checkout main
   git pull --ff-only
   git merge --ff-only origin/develop
   git push origin main
   ```

   If `--ff-only` refuses, stop: `main` has diverged. Investigate — never
   force-push `main`.

5. **Watch the Railway auto-deploy** until the new deployment is live.
   `/api/health` is a real deploy gate: it returns 200 only when the database
   answers `SELECT 1` (within 2s) and 503 otherwise, so a deploy with a broken
   `DATABASE_URL` fails its healthcheck instead of going live broken.
6. **Health-check both production domains** (both serve the Railway `backend`
   service):

   ```bash
   curl -fsS https://api.askansari.ai/api/health
   curl -fsS https://api-35.ansari.chat/api/health
   ```

   Both must return 200 with `{"status":"ok","service":"ansari-backend",...}`.
7. **Sentry watch, 15 minutes.** Watch the backend Sentry project for new or
   spiking issues (wired via `apps/api/sentry.server.config.ts`). Only after a
   quiet 15 minutes is the release considered done.
8. Anything wrong → **Rollback** (last section).

## Pre-promotion local smoke test

Proven 2026-08-02; rewritten for Better Auth (spec 300, closes #33). Run on the exact
`develop` tip you are about to promote, with real env files for both services (see the env
tables in `docs/self-hosting.md` — the chat step needs real AI/search keys, because it
exercises the real model and tools, not mocks). `apps/api` no longer signs anyone in: it
verifies JWTs from `apps/auth`, so both services run, each on its own database.

1. **Build** (from `apps/api/`):

   ```bash
   (cd ../.. && pnpm install) && pnpm build && (cd ../auth && pnpm build)
   ```

2. **Migrate two fresh databases.** Start a disposable Postgres 18 (the production major), create the app and auth
   databases, and apply both full journals to them — this proves a from-scratch install
   works, not just the incremental step:

   ```bash
   docker run --rm -d --name ansari-smoke -e POSTGRES_PASSWORD=postgres -p 5433:5432 postgres:18
   psql postgresql://postgres:postgres@localhost:5433/postgres -X -c 'create database ansari_auth'
   export DATABASE_URL=postgresql://postgres:postgres@localhost:5433/postgres
   pnpm db:migrate
   DATABASE_URL=postgresql://postgres:postgres@localhost:5433/ansari_auth pnpm --filter @ansari/auth db:migrate
   ```

   `pnpm db:migrate` applies `apps/api/drizzle/0000_baseline.sql` → latest to the app
   database; the second command applies `packages/auth/drizzle/` (from
   `0000_auth_schema.sql`) to the auth database.

3. **Boot both production builds.** `apps/auth` first, in its own shell, from `apps/auth/`,
   with its `DATABASE_URL` set to the auth database and its env file loaded (it listens on
   3100):

   ```bash
   DATABASE_URL=postgresql://postgres:postgres@localhost:5433/ansari_auth pnpm start
   ```

   Then `apps/api`, in this shell (the `DATABASE_URL` override wins over `.env`; its
   `AUTH_URL` is `http://localhost:3100`, `apps/auth`'s origin):

   ```bash
   pnpm start
   ```

4. **Health:**

   ```bash
   curl -fsS localhost:3000/api/health   # 200 {"status":"ok",...}
   curl -fsS localhost:3100/health       # 200 {"status":"ok"}
   ```

5. **Auth round-trip, both paths.** Use a strong throwaway passphrase (the strength policy
   rejects weak passwords with a 400; 8 to 128 characters).

   The compatibility layer the released mobile app uses (`apps/api` calls `apps/auth`):

   ```bash
   curl -s localhost:3000/api/v2/users/register -H 'Content-Type: application/json' \
     -d '{"email":"smoke@example.com","password":"<strong throwaway passphrase>"}'
   TOKEN=$(curl -s localhost:3000/api/v2/users/login -H 'Content-Type: application/json' \
     -d '{"email":"smoke@example.com","password":"<same passphrase>"}' | jq -r .access_token)
   curl -s localhost:3000/api/v2/users/me -H "Authorization: Bearer $TOKEN"
   ```

   Directly at `apps/auth`, as `apps/frontend` does (sign in, then exchange the session for a
   JWT; the `Origin` is one of `apps/auth`'s `CORS_ORIGIN` values):

   ```bash
   SESSION=$(curl -s localhost:3100/api/auth/sign-in/email -H 'Content-Type: application/json' \
     -H 'Origin: http://localhost:8081' \
     -d '{"email":"smoke@example.com","password":"<same passphrase>"}' | jq -r .token)
   JWT=$(curl -s localhost:3100/api/auth/token -H "Authorization: Bearer $SESSION" | jq -r .token)
   curl -s localhost:3000/api/v2/users/me -H "Authorization: Bearer $JWT"
   ```

   Both `me` calls return the same id.

6. **Real streamed chat with tool use:**

   ```bash
   THREAD=$(curl -s -X POST localhost:3000/api/v2/threads \
     -H "Authorization: Bearer $TOKEN" | jq -r .thread_id)
   curl -N -s localhost:3000/api/v2/threads/$THREAD/chat \
     -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
     -d '{"message":"What does the Quran say about patience?"}'
   ```

   Expect a live SSE stream showing tool activity followed by a substantive,
   cited answer. A Quran/hadith question reliably triggers tool use.

7. **Admin bootstrap** (#33): from `apps/auth/`, with the auth database's `DATABASE_URL`,
   grant the smoke account and confirm the admin route answers:

   ```bash
   DATABASE_URL=postgresql://postgres:postgres@localhost:5433/ansari_auth \
     pnpm exec tsx scripts/grant-admin.ts smoke@example.com
   curl -s -o /dev/null -w '%{http_code}\n' localhost:3000/api/v2/admin/stats -H "Authorization: Bearer $TOKEN"   # 200
   ```

8. **Teardown:** `docker stop ansari-smoke` (the container was started with
   `--rm`).

## Migration release (variant)

Use this variant whenever the release includes a schema change: a new file in
`apps/api/drizzle/` (the **app database**) or in `packages/auth/drizzle/` (the **auth
database**, spec 300). The two databases are separate Railway Postgres services; every step
below names the one it touches, as `APP_DATABASE_URL` or `AUTH_DATABASE_URL`. Those two names
exist only in the operator's Railway shell, for that session: never on a service, never in
a file. Each service's own variable is `DATABASE_URL`.

> **NEVER run `pnpm db:push` (drizzle-kit push) against production.** It
> diffs the live schema and can drop or recreate tables — and data. The rule
> for schema changes is: `pnpm db:generate` → review the generated SQL →
> apply that SQL explicitly at release time (below). `pnpm db:migrate` is
> for local/fresh databases (as in the smoke test above); production gets the
> reviewed SQL via `psql`.

Order proven for migration `0003` on 2026-08-02:
**inspect → apply via psql → bootstrap → deploy.**

1. **Inspect production data** the migration (especially any backfill) will
   touch, via `psql` — e.g. before `0003`, the rows its system-account
   backfill would match. Know what the migration will do to real rows before
   it does it.
2. **Apply the reviewed SQL explicitly**, from the `develop` commit being promoted, and record
   that commit with the file name in the release notes:

   ```bash
   psql "$APP_DATABASE_URL" -X -v ON_ERROR_STOP=1 --single-transaction -f apps/api/drizzle/000N_<name>.sql
   psql "$AUTH_DATABASE_URL" -X -v ON_ERROR_STOP=1 --single-transaction -f packages/auth/drizzle/000N_<name>.sql
   ```

   **Both flags, on every apply, for both databases.** `ON_ERROR_STOP` alone stops at the
   first error but leaves the statements before it committed; `--single-transaction` rolls
   them back too, so a failed migration applies nothing. A statement that cannot run inside a
   transaction (`CREATE INDEX CONCURRENTLY` and similar) goes in a migration file of its own,
   applied without `--single-transaction`, and its PR says so. A migration's own guard (a
   check that must abort the migration) is written as one `DO` block, so it aborts the file
   whatever flags it is run with. For the auth journal, record `auth-journal-applied: <tag>`
   in the release notes with the commit.

3. **Run bootstrap scripts** (after the migration, before the deploy):
   - **Admins** live in `apps/auth` (spec 300): from `apps/auth/`, with the
     auth database's `DATABASE_URL`, `pnpm exec tsx scripts/grant-admin.ts <email>`
     (in the auth service's Railway shell: `./node_modules/.bin/tsx scripts/grant-admin.ts <email>`).
     It grants the admin role to an account that already exists, in two
     steps: `grant-admin.ts <email>` shows the account (id, email, created_at,
     email_verified, role) and grants nothing; `grant-admin.ts <email> --confirm
     <id>` grants exactly that account. It never creates an account or touches a
     password, and it refuses the system domain. A new admin signs up first; a
     warning on a recent or unverified account means: confirm the person out of
     band before `--confirm`. There is no `ADMIN_EMAILS` on `apps/auth` (spec
     H-7): the role in the auth database is the only admin truth.
   - **System accounts** (`ai-skill`, `leaderboard`) self-provision lazily by
     `system_key` — no manual step.
4. **Then run the standard release checklist above.** Nothing at `apps/auth`'s
   boot checks admins (spec H-7); verify them with `grant-admin.ts --list` (or
   the cutover's `05-audit-admins-auth.sql`).

Migrations must be backward-compatible with the currently-deployed code: the
SQL is applied while the previous deployment is still serving traffic.

**The Better Auth cutover is the exception** (spec 300): it runs in a maintenance window with
`apps/api` offline, by its own runbook, [`docs/cutover/better-auth-cutover.md`](docs/cutover/better-auth-cutover.md),
with its rollback in [`docs/cutover/rollback.md`](docs/cutover/rollback.md). From the merge of
the cutover PR to the end of the window, **no other migration merges** to `develop`, in either
journal (schema freeze).

**The contract migration is the second exception.** The cutover drops nothing the legacy code
reads, so the 24-hour rollback stays a redeploy. The destructive half (dropping
`public.users.password_hash`, `is_admin` and `session_version`, and the `tokens` table, in the
app database) is its own reviewed PR, merged and applied only **after** the rollback deadline,
because it is not backward-compatible with the previous deployment and rollback cannot survive
it. Its checklist also removes `backend`'s legacy variables (`JWT_SECRET`,
`ACCESS_TOKEN_EXPIRY_HOURS`, `REFRESH_TOKEN_EXPIRY_HOURS`, `ADMIN_EMAILS`), which stay set until
then so the rollback can boot the previous `apps/api`.

**No app migration is generated between the cutover merge and the contract PR.** The latest
`apps/api` drizzle snapshot (`0010_snapshot.json`) still records `tokens` and the three legacy
`users` columns, and the hand-written `0011` has no snapshot. Any `drizzle-kit generate` for
`apps/api` in that interval therefore emits their drops as a surprise diff, inside an unrelated
migration that would run before the rollback deadline. The contract PR is the first generate; its
SQL is checked in review to contain **only** those drops (the three columns and `tokens`), and
nothing else.

## Rollback

- **Code:** Railway dashboard → `backend` service → Deployments → select the
  previous good deployment → **Redeploy**. No git operation required. Re-run
  the health checks on both domains afterwards. Follow up by reverting the
  offending change on `develop` through the normal PR flow — never by
  force-pushing `main`.
- **Within 24 hours of the Better Auth cutover:** follow
  [`docs/cutover/rollback.md`](docs/cutover/rollback.md) instead (it also removes the users
  created after the cutover). After that deadline, fix forward.
- **Database:** migrations are not rolled back. They are applied manually and
  must be backward-compatible, so the previous code runs fine on the new
  schema. If a migration itself is bad, ship a corrective forward migration —
  never `db:push`.

## Native builds and updates

Native binaries and over-the-air updates for `apps/frontend` are produced on
EAS, dispatched from GitHub Actions. No laptop is involved, and this is the
only supported path. Each GitHub workflow is a thin dispatcher: it installs the
workspace at the repo root (the EAS CLI evaluates the app config on the
runner) and runs `eas workflow:run` on an EAS Workflow in
`apps/frontend/.eas/workflows/`. Follow the run from the EAS URL printed in
the dispatcher's last step. **EAS Build** goes green once EAS accepts the
run, not once the build finishes. **EAS Update** runs with `--wait`, so
it goes green only when the publish finishes, and fails if the publish fails.

**Build:** Actions tab → **EAS Build** (`.github/workflows/eas-build.yml`) →
*Run workflow* → pick `platform` (all | ios | android) and `profile`:

| Profile | Produces | Update channel | GitHub Environment |
|---|---|---|---|
| `development` | dev-client build, internal distribution | `development` | `development` |
| `preview` | release build, internal distribution | `preview` | `preview` |
| `production-internal` | production build, internal distribution | `production` | `production` |
| `production` | store build; build number auto-increments | `production` | `production` |

**Update:** Actions tab → **EAS Update** (`.github/workflows/eas-update.yml`) →
pick `platform` and `channel` (development | preview | production). The
channel also names the EAS environment and the GitHub Environment.

- **Build numbers are managed by EAS.** `eas.json` sets
  `appVersionSource: remote`, so the iOS build number and Android version code
  live on EAS, not in `app.json`. Only `production` auto-increments them.
- **`runtimeVersion: fingerprint` decides which binaries an update reaches.**
  An update is delivered only to builds on its channel whose native fingerprint
  matches the commit it was published from. After any native change (a
  dependency with native code, a config plugin, `app.json` native fields), ship
  a new build first; an update alone reaches no one. The fingerprint contract
  is tracked in #267.
- **Concurrent dispatches queue, they never cancel** (`queue: max`, so every
  pending run is kept). **Build** serializes the *dispatch* per
  profile/platform pair, not the EAS build. The dispatcher does not wait, so
  two builds of one pair can still run on EAS at the same time. **Update**
  serializes per channel (all platforms) and waits for each EAS run, so
  updates to a channel publish in dispatch order.

**Token and Environments (prerequisite, not yet done).** No `EXPO_TOKEN`
exists yet, and neither do the three Environments (the repo's existing
Environments are Railway's). Do these steps **in this order**:

1. **Create the GitHub Environments** `development`, `preview` and
   `production`. Each gets a **deployment branch policy that allows only
   `develop`**. `production` also gets **required reviewers**, so every
   production build or update waits for a human approval.
2. **Only then add the token.** Create an Expo **robot** access token with
   access to the `ansari-project` / `ansari-chat` EAS project, and store it as
   the `EXPO_TOKEN` secret in each of the three Environments.
3. **Only then dispatch.** A dispatch that names an Environment which does not
   exist yet auto-creates it **unprotected**, with no branch policy and no
   reviewer. Dispatching before step 1 would therefore create exactly the
   hole this setup closes.

The branch policy is what makes the reviewer meaningful. A `workflow_dispatch`
runs the *selected branch's own copy* of the workflow. Without a branch
restriction, anyone who can push a branch can edit the dispatcher there,
dispatch it against the `development` environment (no reviewer), and send the
same token to `eas` with a production profile or channel. The production
reviewer would never be asked. Restricting every Environment to `develop`
means only reviewed workflow code ever receives the token. The dispatchers are
the only place the token is used.
