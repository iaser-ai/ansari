# Self-Hosting Ansari Backend

This guide covers running the Ansari backend (`apps/api/`) yourself: prerequisites,
the complete environment-variable contract, and deployment notes.

## Prerequisites

- **Node.js ≥ 22** (the root `.nvmrc` pins the version)
- **pnpm ≥ 10** — `corepack enable` provides the exact pinned version (the
  `packageManager` field in the root `package.json`); the repo is a pnpm workspace
- **PostgreSQL** (any recent version) with **two databases**: the app database (`apps/api`) and
  the auth database (`apps/auth`). Each has its own Drizzle migration journal, and neither
  service ever connects to the other's database.
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
runs at first config access, and a production server also runs it at boot
(`apps/api/lib/boot-check.ts`), so missing required values fail loudly at startup.

Accounts, passwords, sessions, roles and password-reset email belong to the auth
service, `apps/auth` (spec 300). `apps/api` holds no credential and no
signing secret, and shares no secret with `apps/auth`: it reaches `apps/auth` at its
public origin like any other client, verifying its JWTs against the public JWKS and
calling its account endpoints with the user's own JWT.

### Required (validation throws when absent)

| Variable | Notes |
|----------|-------|
| `DATABASE_URL` | Postgres connection string |
| `KALEMAT_API_KEY` | Non-empty required — see caveat above |
| `USUL_API_TOKEN` | Non-empty required — see caveat above |

### Auth service (`apps/auth`; required when `NODE_ENV=production`)

Optional in development and test (suites that never reach `apps/auth` run without
them); a production server refuses to boot when any is unset, naming the missing ones.

| Variable | Notes |
|----------|-------|
| `AUTH_URL` | `apps/auth`'s public origin (its domain). The JWKS, the account endpoints and the `/v2/users/*` layer's calls go here, with no shared secret |
| `AUTH_JWT_ISSUER` | Must equal `apps/auth`'s `AUTH_JWT_ISSUER`. Set on its own, never derived from `AUTH_URL` |
| `AUTH_JWT_AUDIENCE` | Must equal `apps/auth`'s `AUTH_JWT_AUDIENCE` |
| `AUTH_LAYER_ORIGIN` | `apps/api`'s own public origin, sent as `Origin` on the `/v2/users/*` layer's calls. `apps/auth` trusts it for CSRF only, never for CORS; the same value as `apps/auth`'s |

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

### Primary backend switch (⚠️ experimental — NOT a supported production configuration)

`PRIMARY_BACKEND=inkling` routes **every** facilitator primary call through the
OpenAI-compatible Inkling client instead of Gemini — the whole request (tool loop,
continuations, synthesis) runs against `INKLING_BASE_URL`, and Gemini is never
called. This is an experimentation escape hatch for benchmark/eval runs and
externally hosted checkpoints (e.g. exported LoRAs); do **not** run production
traffic on it. The default (`gemini`, or the variable unset) is byte-identical to
the pre-switch behavior.

Under `PRIMARY_BACKEND=inkling`, the terminal-error rescue rung (which rescues a
failed *Gemini* call on Inkling) is inherently disabled — an Inkling-primary
failure surfaces loudly instead of being "rescued" by the same backend. The
empty-final retry ladder still applies as same-model retries.

| Variable | Default | Notes |
|----------|---------|-------|
| `PRIMARY_BACKEND` | `gemini` | `gemini` \| `inkling`. Validation fails fast (at first config access) when set to `inkling` without an API key (below) |
| `INKLING_BASE_URL` | the Tinker prod `/chat/completions` URL | Full URL of any OpenAI-compatible `/chat/completions` endpoint (https required; plain http only for localhost). Also used by the fallback rungs |
| `INKLING_API_KEY` | unset | Bearer token for `INKLING_BASE_URL`; falls back to `TINKER_API_KEY` when unset |

### Optional / defaulted

| Variable | Default | Notes |
|----------|---------|-------|
| `TINKER_API_KEY` | unset | Enables the Inkling off-Vertex backup (empty-final retry ladder rung + terminal-error rescue). When unset, both are skipped cleanly |
| `INKLING_MODEL` | `thinkingmachines/Inkling` | Which Inkling model the backup requests — e.g. a fine-tuned LoRA via a `tinker://...` sampler-weights id |
| `INKLING_MAX_TOKENS` | `8192` | Inkling completion cap (budgets thinking+answer). Must be within 8192–32768: below 8K the hidden reasoning pass starves the visible answer. Out-of-window values fail validation (no clamping) |
| `INKLING_TIMEOUT_MS` | `180000` | Per-call timeout for Inkling requests: the default when a caller passes no timeout, and a cap on the facilitator's budget-derived Inkling call timeouts (`min(remaining request budget, this value)`) — it can shorten Inkling calls, never lengthen them past the request budget. Must be within 30000–600000; out-of-window values fail validation (no clamping) |
| `USUL_BASE_URL` | `https://api.usul.ai/v1/vector-search` | |
| `TINKER_API_KEY` | unset | Enables the Inkling off-Vertex fallback rung and terminal-error rescue (issues #74/#79). When unset (and `INKLING_API_KEY` too), both are skipped cleanly |
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
| `SENTRY_DSN` | `sentry.*.config.ts` | Optional. Sentry is disabled when unset (and always disabled under test). No user content is ever sent to Sentry |
| `RAILWAY_ENVIRONMENT` | `sentry.server.config.ts` | Auto-injected by Railway; used as the Sentry environment tag. Falls back to `NODE_ENV`; never set manually |
| `SENTRY_AUTH_TOKEN` | build-time only | Optional — source-map uploads during `next build`. The build succeeds without it |

### Provisioning admins

Admins are an `apps/auth` concern: admin access is the auth user's `role`, the only
admin truth, set out of band with `apps/auth/scripts/grant-admin.ts`, run from
`apps/auth/`. It works in two steps: `grant-admin.ts <email>` shows the account (id,
email, `created_at`, `email_verified`, role) and grants nothing, and
`grant-admin.ts <email> --confirm <id>` grants exactly that account. It warns on a recent
or unverified account; confirm the person out of band before `--confirm`. `apps/api` asks
`apps/auth` for the role on every admin request. There is no `ADMIN_EMAILS` on
`apps/auth`. `apps/api`'s **legacy** `ADMIN_EMAILS` (old code only) stays set on the
`backend` service until the contract PR, because a rollback redeploys the previous
`apps/api`, which needs it. RELEASE.md carries the onboarding order.

## Running it

```bash
corepack enable             # provides pnpm
pnpm install                # at the REPO ROOT (single workspace lockfile)

cd apps/api
cp .env.example .env        # fill in per the tables above
pnpm db:migrate             # applies drizzle/ migrations to DATABASE_URL (the app database)
cd ../..

# The auth service, on its own database (apps/api signs no one in; it verifies
# apps/auth's JWTs, so both run). apps/api's AUTH_URL is apps/auth's origin.
createdb ansari_auth
cd apps/auth
cp .env.example .env        # DATABASE_URL = the auth database
pnpm db:migrate             # applies packages/auth/drizzle/ to DATABASE_URL (the auth database)
cd ../..

pnpm auth dev               # apps/auth on :3100
pnpm api dev                # apps/api on :3000, in a second terminal
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

Production migrations are **not** applied with `pnpm db:migrate`. Each reviewed SQL file
is applied by hand with `psql -X -v ON_ERROR_STOP=1 --single-transaction -f <file>`,
naming the database it belongs to (the app database for `apps/api/drizzle/`, the auth
database for `packages/auth/drizzle/`), as `RELEASE.md` describes. Never `db:push`.
`apps/auth`'s `/health` is the same kind of gate: it answers 200 only while the auth
database does.

### Boot checks

`apps/auth` runs no admin check at boot (spec 300 amendment H-7): a stale admin list can never
stop sign-in. Its only boot requirement is the environment validation. `/health` answers 200
only while the auth database does, so a deploy with an unreachable database fails its
healthcheck instead of serving. Verify admins with `grant-admin.ts --list` from `apps/auth/`.

`apps/api`'s own boot check is the environment validation above; it queries nothing.
