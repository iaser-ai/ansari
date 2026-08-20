# ansari-api — Claude Code Instructions

> Claude Code instructions for the Ansari backend.
> This is the Claude Code twin of `AGENTS.md` (same content).

## What this is

The Ansari backend: a Next.js API serving an Islamic AI assistant. A
Gemini-powered facilitator (`lib/facilitator/`) answers questions by calling
Islamic search tools (`lib/tools/`: Quran, Hadith, Mawsuah, Tafsir) and citing
results. Postgres via Drizzle (`db/schema/`, migrations in `drizzle/`), JWT auth
(`lib/auth/`), SSE streaming responses.

## Commands

This repo is a **pnpm workspace** driven by **Turborepo**: install once at the
repo root. Root tasks (`pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`,
`pnpm dev`) run through the task graph and cover every package that defines them.
To target this app specifically, use `pnpm api <script>` from the root, or run
the script from inside `apps/api/`.

`pnpm build`/`pnpm test` for this app need the env loaded the way CI loads it —
`set -a && . ./apps/api/.env.ci && set +a` — because Turborepo's strict env mode
only forwards variables declared in the root `turbo.json`.

```bash
pnpm install          # at the REPO ROOT (Node >= 22; pnpm via corepack)

# inside apps/api/
pnpm typecheck        # tsc --noEmit
pnpm test             # vitest — the full suite runs without external services
pnpm build            # next build
pnpm dev              # dev server
pnpm db:generate      # drizzle-kit generate (after editing db/schema/)
pnpm db:migrate       # apply migrations
```

Never use npm or yarn here — the single lockfile is the root `pnpm-lock.yaml`
(there are no per-package lockfiles). Never use `db:push` against a real
database; generate + migrate.

## Layout

- `lib/` — engine (facilitator agent, gemini client, tools, auth, db helpers)
- `lib/ai/prompts/facilitator.ts` — the system prompt; changes need cited justification
- `src/app/api/` — HTTP surface (`v2/*` product API, `v1/chat/completions` OpenAI-compat, `health`)
- `tests/` — Vitest suites (`*.test.ts`); the full suite runs without external services

## Conventions

- Strict env validation lives in `lib/config.ts` — new env vars go there (or are
  documented in `docs/self-hosting.md` if read directly) AND in `.env.example`.
- Fail fast; no silent fallbacks. Tool-call failures go through
  `lib/tools/resilience.ts` and degrade gracefully.
- No user content in logs or Sentry.
- Tests accompany every behavior change; suite must stay green with only the
  dummy env in `.env.ci`.
- Stage files explicitly in commits (no `git add -A`).
