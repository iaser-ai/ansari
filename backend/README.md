# Ansari Backend

The production backend of [Ansari](https://ansari.chat) — an Islamic AI assistant that answers questions with evidence from the Quran, Hadith, and classical scholarship.

## Overview

Ansari Backend is a Next.js API service. At its core is a **facilitator**: a Gemini-powered agent that answers Islamic questions by calling specialized search tools and citing what it finds.

- **Quran search** — ayat with Arabic text and translation (Kalemat API)
- **Hadith search** — narrations with source references (Kalemat API)
- **Mawsuah search** — the Kuwaiti Encyclopedia of Islamic Jurisprudence (Usul vector search)
- **Tafsir search** — Quranic exegesis (Usul vector search)

Responses stream over SSE, threads and messages persist to Postgres, and the search tools degrade gracefully when a provider is unavailable — the assistant says what it couldn't consult rather than failing the request.

## API Surface

| Area | Endpoints |
|------|-----------|
| Health | `GET /api/health` |
| Auth & users | `POST /api/v2/users/register`, `login`, `logout`, `refresh_token`, `GET /api/v2/users/me`, password reset (`request_password_reset`, `reset_password`) |
| Chat | `POST /api/v2/threads` (create), `POST /api/v2/threads/{id}` (send message, SSE stream), thread naming, sharing |
| Feedback & prefs | `POST /api/v2/feedback`, `GET/POST /api/v2/preferences` |
| App support | `GET /api/v2/app-check` (version/maintenance gate) |
| OpenAI-compat | `POST /api/v1/chat/completions` (bearer-token gated, for evaluation harnesses) |
| MCP-style | `POST /api/v2/mcp-complete` (stateless completion for AI-skill integrations) |
| Admin | `GET /api/v2/admin/stats`, `/admin/analytics` dashboard |

Auth is JWT-based (access + rotating refresh tokens, bcrypt password hashing — compatible with hashes from the legacy Python backend).

## Tech Stack

- **Runtime**: Next.js 15 (App Router, API routes), Node ≥ 20, TypeScript
- **AI**: Google Gemini via Vertex AI (preferred) or the public Gemini API, with model fallback on capacity errors
- **Database**: PostgreSQL with Drizzle ORM (migrations in `drizzle/`)
- **Validation**: Zod (strict env + request validation)
- **Email**: Resend + react-email (password reset)
- **Observability**: Sentry (optional — disabled when `SENTRY_DSN` is unset; no user content is logged)
- **Tests**: Vitest (unit/integration), Playwright (e2e, run locally)

## Getting Started

```bash
# Install (Node >= 20, see .nvmrc)
npm ci

# Configure — see .env.example for the full contract
cp .env.example .env
# Required: DATABASE_URL, JWT_SECRET (32+ chars), KALEMAT_API_KEY, USUL_API_TOKEN,
#           and one Gemini path (GEMINI_API_KEY or GOOGLE_CLOUD_PROJECT + credentials).
# NOTE: Kalemat and Usul keys are not self-serve — request them from the providers.

# Database
npm run db:migrate

# Run
npm run dev
```

Verify: `npm run typecheck && npm test && npm run build`.

## Project Layout

```
lib/            Engine: facilitator agent, Gemini client, tools, auth, db helpers
  ai/prompts/   The facilitator system prompt ("the soul")
  tools/        Quran / Hadith / Mawsuah / Tafsir search + resilience wrapper
src/app/api/    HTTP surface (v1, v2 routes)
db/schema/      Drizzle schema (users, threads, messages, tokens, ...)
drizzle/        Generated SQL migrations
tests/          Vitest suites
emails/         react-email templates
```

## Deployment

Deployed on Railway (`railway.toml`: nixpacks, healthcheck `/api/health`), but any host that runs a Next.js server works. See the self-hosting guide in the monorepo `docs/` for the full environment contract.

## License

MIT
