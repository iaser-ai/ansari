# Self-Hosting Ansari Backend

This guide covers running the Ansari backend (`backend/`) yourself: prerequisites,
the complete environment-variable contract, and deployment notes.

## Prerequisites

- **Node.js ≥ 20** (`backend/.nvmrc` pins the version)
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

The source of truth is the strict Zod schema in `backend/lib/config.ts` plus a few
direct `process.env` reads. `backend/.env.example` mirrors this contract. Validation
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
| `ACCESS_TOKEN_EXPIRY_HOURS` | `2` | JWT access-token lifetime |
| `REFRESH_TOKEN_EXPIRY_HOURS` | `2160` | Refresh-token lifetime (90 days) |
| `USUL_BASE_URL` | `https://api.usul.ai/v1/vector-search` | |
| `ADMIN_EMAILS` | empty | Comma-separated allowlist for the admin dashboard (`/admin/analytics`, `/api/v2/admin/stats`) |
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

## Running it

```bash
cd backend
npm ci

cp .env.example .env        # fill in per the tables above
npm run db:migrate          # applies drizzle/ migrations to DATABASE_URL

npm run dev                 # dev server on :3000
```

Verify your setup:

```bash
npm run typecheck
npm test                    # full Vitest suite; no external services needed
npm run build
curl localhost:3000/api/health   # {"status":"ok",...,"service":"ansari-backend"}
```

CI runs exactly typecheck + test + build with the committed dummy env in
`backend/.env.ci` — proof that none of them require real secrets.

## Deployment

Any host that runs a Next.js server works (`npm run build` && `npm run start`).

The production instance runs on **Railway** with the repository's
`backend/railway.toml` (nixpacks builder, healthcheck on `/api/health`, restart on
failure). For a Railway deploy from this monorepo, set the service's root directory
to `backend/` so the lockfile and `railway.toml` are picked up.

Database migrations are applied with `npm run db:migrate` against the production
`DATABASE_URL` (never `db:push`).
