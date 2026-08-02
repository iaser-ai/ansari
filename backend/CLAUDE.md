# ansari-backend — Claude Code Instructions

> Claude Code instructions for the Ansari backend.
> This is the Claude Code twin of `AGENTS.md` (same content).

## What this is

The Ansari backend: a Next.js API serving an Islamic AI assistant. A
Gemini-powered facilitator (`lib/facilitator/`) answers questions by calling
Islamic search tools (`lib/tools/`: Quran, Hadith, Mawsuah, Tafsir) and citing
results. Postgres via Drizzle (`db/schema/`, migrations in `drizzle/`), JWT auth
(`lib/auth/`), SSE streaming responses.

## Commands (run inside `backend/`)

```bash
npm ci                # install (Node >= 22)
npm run typecheck     # tsc --noEmit
npm test              # vitest — the full suite runs without external services
npm run build         # next build
npm run dev           # dev server
npm run db:generate   # drizzle-kit generate (after editing db/schema/)
npm run db:migrate    # apply migrations
```

Do not run npm at the repo root — `backend/package-lock.json` is the single
lockfile. Never use `db:push` against a real database; generate + migrate.

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
