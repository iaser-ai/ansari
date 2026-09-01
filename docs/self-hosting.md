# Self-Hosting Ansari Backend

This guide covers running the Ansari backend (`apps/api/`) yourself: prerequisites,
the complete environment-variable contract, and deployment notes.

## Prerequisites

- **Node.js ≥ 22** (the root `.nvmrc` pins the version)
- **pnpm ≥ 10** — `corepack enable` provides the exact pinned version (the
  `packageManager` field in the root `package.json`); the repo is a pnpm workspace
- **PostgreSQL** (any recent version; the schema is managed by Drizzle migrations)
- A **Gemini** credential — either a [Google AI Studio API key](https://aistudio.google.com/)
  or a Google Cloud project with Vertex AI enabled
- (For full search functionality) **Kalemat** and **Usul** API keys — see the caveat below

## The Kalemat / Usul caveat (read this first)

Ansari's Islamic search tools are backed by two third-party services whose keys are
**not self-serve**:

- **Kalemat** (`KALEMAT_API_KEY`) — Quran and Hadith search
- **Usul** (`USUL_API_TOKEN`) — Mawsuah (Kuwaiti fiqh encyclopedia) and Tafsir vector search

You must request keys from the respective providers. **Environment validation requires
these variables to be non-empty**, so a self-hoster without real keys must supply
placeholder values (any non-empty string). The engine then boots and works: when a
search tool is called with an invalid key, the failure is caught by the resilience
layer and the assistant answers from its other sources, noting which source could not
be consulted. You get a functioning assistant with degraded search rather than a crash.

## Environment contract

The source of truth is the strict Zod schema in `apps/api/lib/config.ts` plus a few
direct `process.env` reads. `apps/api/.env.example` mirrors this contract. Validation
runs at first config access; missing required values fail loudly at startup.

### Required (validation throws when absent)

| Variable | Notes |
|----------|-------|
| `DATABASE_URL` | Postgres connection string |
| `JWT_SECRET` | Min 32 characters. Generate with `openssl rand -hex 32` |
| `KALEMAT_API_KEY` | Non-empty required — see caveat above |
| `USUL_API_TOKEN` | Non-empty required — see caveat above |

### Gemini facilitator (one of two paths, checked at first use)

If `GOOGLE_CLOUD_PROJECT` is set, **Vertex AI** is used; otherwise the **public Gemini
API** via `GEMINI_API_KEY`. One of the two must be configured or chat requests fail.

| Variable | Default | Notes |
|----------|---------|-------|
| `GEMINI_API_KEY` | — | Public Gemini API path |
| `GOOGLE_CLOUD_PROJECT` | — | Setting this selects Vertex AI |
| `GOOGLE_CLOUD_LOCATION` | `global` | Vertex region |
| `GOOGLE_APPLICATION_CREDENTIALS` | — | Path to a service-account JSON file (local dev) |
| `GOOGLE_APPLICATION_CREDENTIALS_JSON` | — | Inline JSON contents of the service account — for hosts without a writable filesystem (e.g. Railway) |
| `GEMINI_MODEL` | `gemini-3.1-pro-preview` | Primary model |
| `GEMINI_FALLBACK_MODEL` | `gemini-3.1-pro-preview` | Used only when the primary exhausts retries on transient (e.g. 429 shared-capacity) errors; draws on a separate capacity pool |

### Optional / defaulted

| Variable | Default | Notes |
|----------|---------|-------|
| `TINKER_API_KEY` | unset | Enables the Inkling off-Vertex backup (empty-final retry ladder rung + terminal-error rescue). When unset, both are skipped cleanly |
| `INKLING_MODEL` | `thinkingmachines/Inkling` | Which Inkling model the backup requests — e.g. a fine-tuned LoRA via a `tinker://...` sampler-weights id |
| `INKLING_MAX_TOKENS` | `8192` | Inkling completion cap (budgets thinking+answer). Must be within 8192–32768: below 8K the hidden reasoning pass starves the visible answer. Out-of-window values fail validation (no clamping) |
| `INKLING_TIMEOUT_MS` | `180000` | Per-call timeout for Inkling requests: the default when a caller passes no timeout, and a cap on the facilitator's budget-derived Inkling call timeouts (`min(remaining request budget, this value)`) — it can shorten Inkling calls, never lengthen them past the request budget. Must be within 30000–600000; out-of-window values fail validation (no clamping) |
| `ACCESS_TOKEN_EXPIRY_HOURS` | `2` | JWT access-token lifetime |
| `REFRESH_TOKEN_EXPIRY_HOURS` | `2160` | Refresh-token lifetime (90 days) |
| `USUL_BASE_URL` | `https://api.usul.ai/v1/vector-search` | |
| `ADMIN_EMAILS` | empty | Comma-separated addresses that are **reserved** (public registration of them is refused) and **asserted at production boot** to already exist as admins. It does **not** grant admin on its own — admin access is gated on the durable `users.is_admin` DB flag. See the admin-provisioning note below. |
| `LEADERBOARD_API_KEY` | unset | Bearer token for `/api/v1/chat/completions` (OpenAI-compat endpoint for evaluation harnesses). Min 32 chars when set; the endpoint returns 503 when unset |
| `MAINTENANCE_MODE` | `false` | Served by `/api/v2/app-check` |
| `IOS_MINIMUM_BUILD_VERSION` | `1` | App-version gate (`/api/v2/app-check`) |
| `IOS_LATEST_BUILD_VERSION` | `1` | |
| `ANDROID_MINIMUM_BUILD_VERSION` | `1` | |
| `ANDROID_LATEST_BUILD_VERSION` | `1` | |
| `NODE_ENV` | `development` | `development` / `production` / `test` |

### Outside the config schema (direct `process.env` reads)

| Variable | Where used | Notes |
|----------|-----------|-------|
| `RESEND_API_KEY` | `lib/email.ts` | Password-reset email via [Resend](https://resend.com). Password reset fails cleanly when unset |
| `FRONTEND_URL` | `lib/email.ts` | Base URL for password-reset links (defaults to `https://askansari.ai` — set this to YOUR frontend) |
| `MARKETMAKER_URL` | `lib/newsletter.ts` | Optional newsletter-subscribe endpoint. **When unset, newsletter subscriptions are skipped entirely** (logged once). Self-hosters should leave this unset unless they run their own newsletter service |
| `SENTRY_DSN` | `sentry.*.config.ts` | Optional. Sentry is disabled when unset (and always disabled under test). No user content is ever sent to Sentry |
| `RAILWAY_ENVIRONMENT` | `sentry.server.config.ts` | Auto-injected by Railway; used as the Sentry environment tag. Falls back to `NODE_ENV`; never set manually |
| `SENTRY_AUTH_TOKEN` | build-time only | Optional — source-map uploads during `next build`. The build succeeds without it |

### Provisioning admins

Admin access is gated on the durable `users.is_admin` DB flag, not on `ADMIN_EMAILS`. Because public registration of an `ADMIN_EMAILS` address is refused and a production server asserts at boot that every configured admin account exists, the **only** way to create an admin is the bootstrap script. Deploy in this order:

1. **Apply the migration** (`pnpm db:migrate` from `apps/api/`, or your managed-DB apply step). Before applying, inspect for any pre-existing account holding a reserved admin/system address and remediate it.
2. **Bootstrap each admin**: `pnpm exec tsx scripts/grant-admin.ts <email>` (from `apps/api/`). You are securely prompted for the password (input is hidden). This creates the account with that password (or promotes and password-resets an existing one, revoking its old sessions).
3. **Deploy.** Production boot then asserts the configured admins exist; if the bootstrap step was skipped it fails fast (identifying the missing entry by its position in `ADMIN_EMAILS`, not by address). The same check also fails when the database is unreachable at boot — see [Troubleshooting: crash loop at boot](#troubleshooting-crash-loop-at-boot-admin-bootstrap-check) before assuming a provisioning error.

## Running it

```bash
corepack enable             # provides pnpm
pnpm install                # at the REPO ROOT (single workspace lockfile)

cd apps/api
cp .env.example .env        # fill in per the tables above
pnpm db:migrate             # applies drizzle/ migrations to DATABASE_URL

pnpm dev                    # dev server on :3000
```

Verify your setup (from `apps/api/`):

```bash
pnpm lint
pnpm typecheck
pnpm test                   # full Vitest suite; no external services needed
pnpm build
# The healthcheck now verifies the database: 200 only if a live DATABASE_URL
# answers SELECT 1, otherwise 503. With a running DB and DATABASE_URL set:
curl localhost:3000/api/health   # {"status":"ok",...,"service":"ansari-backend"}
```

CI runs lint + typecheck + test (with coverage) + build with the committed dummy
env in `apps/api/.env.ci` — proof that none of them require real secrets.

## Deployment

Any host that runs a Next.js server works (`pnpm build` && `pnpm start` from
`apps/api/`), as does any Docker host via `apps/api/Dockerfile` (build from the
repo root: `docker build -f apps/api/Dockerfile .` — the image builds with the
committed dummy `apps/api/.env.ci`; real environment variables are injected at
runtime).

The production instance runs on **Railway**: a dockerfile build from
`apps/api/Dockerfile`, healthcheck on `/api/health`, restart on failure.

For a Railway deploy from this monorepo, configure the service in the dashboard:

- **Root directory: the repo root** — not `apps/api`. The Docker build context
  needs the root `pnpm-lock.yaml`, and the image also copies `packages/`.
- **Dockerfile path:** `apps/api/Dockerfile`
- **Watch paths:** `apps/api/**`, `packages/**`, `package.json`, `pnpm-lock.yaml`,
  `pnpm-workspace.yaml`. `packages/**` is required — the shared config packages are
  copied into the image, so omitting it means a packages-only change ships nothing:
  no rebuild, no deploy, and no error.

`apps/api/railway.toml` records these same values in version control but is **not read
by Railway in this deployment** — the dashboard settings above are the live
configuration. (Railway does support a config-as-code path setting; this project does
not use it.) RELEASE.md carries the full per-service table.

Because `/api/health` now returns 503 when the database is unreachable, it is a real
deploy gate: a deploy with a broken or unset `DATABASE_URL` will fail its healthcheck
and be rolled back rather than going live in a broken state. Make sure `DATABASE_URL`
is set and reachable before deploying.

Database migrations are applied with `pnpm db:migrate` (from `apps/api/`) against
the production `DATABASE_URL` (never `db:push`).

### Troubleshooting: crash loop at boot (admin bootstrap check)

A production server (`NODE_ENV=production`) runs the admin bootstrap check at boot
(`assertConfiguredAdminsExist` in `apps/api/lib/auth/startup-checks.ts`): it queries
the database to verify that every `ADMIN_EMAILS` entry already exists as an admin,
and **throws if it cannot verify this** — including when the database is simply
unreachable. Coupling boot to database reachability is deliberate fail-fast
behavior: a server that cannot verify its admins refuses to start rather than
serving with unknown admin state.

**Symptom.** On platforms that restart on crash (e.g. Railway with
`restartPolicyType = "ON_FAILURE"`), a database blip while the process boots
presents as a **crash loop** that looks identical to a mis-provisioned deploy. The
check runs only on a real production boot — never during `next build`, dev, or
tests — so this only ever appears in production.

**Triage: read the boot error text — it distinguishes the two cases.**

| Boot error contains | Meaning | What to do |
|---|---|---|
| `Admin bootstrap check could not reach the database` | The database was unreachable when boot ran. This is an **outage, not a provisioning error** — do not re-run the bootstrap script. | Restore database reachability (`DATABASE_URL` correct, network path open, database up). The next restart succeeds once the database answers; on restart-on-crash platforms recovery is automatic. |
| `has no account` or `exists but is not flagged is_admin` | A real provisioning gap: the configured admin was never bootstrapped, or was deleted/demoted since. Restarting will not fix it. | Run `pnpm exec tsx scripts/grant-admin.ts <email>` for the identified entry (see [Provisioning admins](#provisioning-admins)), then restart. |

The error identifies the failing entry by its **position** in `ADMIN_EMAILS`
(e.g. `configured admin #2 of 3`), never by the address itself — boot logs carry
no email content. Map the index back to your configured list.

Timing note: during a fresh deploy, a database outage surfaces as a failed
`/api/health` healthcheck and a rollback (the old version keeps serving). The
crash-loop presentation above is what you see when an **already-deployed** instance
restarts (crash, platform maintenance, scale event) while the database is
unreachable.
