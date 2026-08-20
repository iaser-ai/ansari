# Release Process

How Ansari's backend goes from `develop` to production. This codifies the
process that was previously in architect notes; the smoke sequence and the
migration runbook were both proven in real releases on 2026-08-02.

## Deployment model

- **`develop`** is the integration branch. It is protected: PRs only, with the
  required CI checks from `.github/workflows/ci.yml` —
  `backend (lint, typecheck, test, build)`, `frontend (lint, typecheck)`, and
  `gitleaks (secret scan)`.
- **`main`** is the production branch. The Railway service `backend`
  auto-deploys every push to `main` (service root directory = repo root, config
  in `apps/api/railway.toml`: dockerfile builder using `apps/api/Dockerfile`,
  healthcheck on `/api/health` with a 300s timeout, restart `ON_FAILURE` up to
  3 times).
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

Proven 2026-08-02. Run from `apps/api/` on the exact `develop` tip you are
about to promote, with a real `.env` (see the env tables in
`docs/self-hosting.md` — the chat step needs real AI/search keys, because it
exercises the real model and tools, not mocks).

1. **Build:**

   ```bash
   (cd ../.. && pnpm install) && pnpm build
   ```

2. **Migrate a fresh database.** Start a disposable Postgres 16 and apply the
   full migration chain (`apps/api/drizzle/0000_baseline.sql` → latest) to an empty
   database — this proves a from-scratch install works, not just the
   incremental step:

   ```bash
   docker run --rm -d --name ansari-smoke -e POSTGRES_PASSWORD=postgres -p 5433:5432 postgres:16
   export DATABASE_URL=postgresql://postgres:postgres@localhost:5433/postgres
   pnpm db:migrate
   ```

3. **Boot the production build** against that database (same shell, so the
   `DATABASE_URL` override wins over `.env`):

   ```bash
   pnpm start
   ```

4. **Health:**

   ```bash
   curl -fsS localhost:3000/api/health   # 200 {"status":"ok",...}
   ```

5. **Auth round-trip** — register, log in, fetch the authenticated profile.
   Use a strong throwaway passphrase (the strength policy rejects weak
   passwords with a 400; max 128 chars):

   ```bash
   curl -s localhost:3000/api/v2/users/register -H 'Content-Type: application/json' \
     -d '{"email":"smoke@example.com","password":"<strong throwaway passphrase>"}'
   TOKEN=$(curl -s localhost:3000/api/v2/users/login -H 'Content-Type: application/json' \
     -d '{"email":"smoke@example.com","password":"<same passphrase>"}' | jq -r .access_token)
   curl -s localhost:3000/api/v2/users/me -H "Authorization: Bearer $TOKEN"
   ```

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

7. **Teardown:** `docker stop ansari-smoke` (the container was started with
   `--rm`).

## Migration release (variant)

Use this variant whenever the release includes a schema change (a new file in
`apps/api/drizzle/`).

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
2. **Apply the reviewed SQL explicitly:**

   ```bash
   psql "$DATABASE_URL" -f apps/api/drizzle/000N_<name>.sql
   ```

3. **Run bootstrap scripts** (after the migration, before the deploy):
   - **Admins:** from `apps/api/`, `pnpm exec tsx scripts/grant-admin.ts <email>`
     (securely prompts for a password; creates a login-capable admin, or
     promotes an existing account while resetting its password and revoking
     its sessions).
   - **System accounts** (`ai-skill`, `leaderboard`) self-provision lazily by
     `system_key` — no manual step.
4. **Then run the standard release checklist above.** The order matters:
   production boot asserts that every `ADMIN_EMAILS` entry already exists as
   an admin, so deploying before migration + bootstrap fails fast at startup
   — by design.

Migrations must be backward-compatible with the currently-deployed code: the
SQL is applied while the previous deployment is still serving traffic.

## Rollback

- **Code:** Railway dashboard → `backend` service → Deployments → select the
  previous good deployment → **Redeploy**. No git operation required. Re-run
  the health checks on both domains afterwards. Follow up by reverting the
  offending change on `develop` through the normal PR flow — never by
  force-pushing `main`.
- **Database:** migrations are not rolled back. They are applied manually and
  must be backward-compatible, so the previous code runs fine on the new
  schema. If a migration itself is bad, ship a corrective forward migration —
  never `db:push`.
