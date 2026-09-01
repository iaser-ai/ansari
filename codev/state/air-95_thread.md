# air-95 thread — PRIMARY_BACKEND switch (issue #95)

## 2026-09-01 — orientation + implement start

AIR strict mode, implement phase. Read issue #95, config.ts, inkling-client.ts,
facilitator/agent.ts, v1 completions route, existing inkling tests.

Key discovery: most of the machinery already exists from #74/#79 — the facilitator
takes `options.provider: 'gemini' | 'inkling'` (leaderboard adapter's forced-primary
mode), seeding the sticky `useInklingRung` flag, which already disables the #79
rescue (`!useInklingRung` guard) and keeps every call incl. synthesis on Inkling.

So #95 reduces to:
1. config.ts: `PRIMARY_BACKEND` enum (default gemini), `INKLING_BASE_URL` (default =
   hardcoded Tinker URL), `INKLING_API_KEY` (falls back to TINKER_API_KEY), plus a
   superRefine fail-fast: PRIMARY_BACKEND=inkling requires a key.
2. inkling-client: use config.inkling.baseUrl instead of the hardcoded URL const.
3. agent.ts: `useInklingRung = (options?.provider ?? config.primaryBackend) === 'inkling'`
   — explicit caller option wins; env is the default. Rescue-rung mechanic under
   inkling-primary: inherently short-circuited by the existing `!useInklingRung`
   guard (documented + pinned by test).
4. v1 route: default model id's provider becomes config.primaryBackend (Gemini "not
   called at all" under the switch); explicit inkling model id unchanged.
5. turbo.json globalEnv + .env.example + docs/self-hosting.md (loud "not production").
6. Tests: config validation, pointable base URL, client-selection pins (default
   byte-identical), full facilitator loop (tool round + final) against a mocked
   OpenAI-compat server via fetch stub with REAL tools module + real inkling client.

## 2026-09-01 — implement done, PR open, CMAP running

Implementation committed (24f1cd7) and porch advanced implement → pr.
- Full suite: 70 files, 671 passed / 3 pre-existing skips. Typecheck clean,
  lint adds no new warnings, `pnpm build` green with CI env.
- Gotcha hit: `config.primaryBackend` at request start made four facilitator
  suites (budget, t1, degradation, parallel-responses) throw env validation —
  they ran with the REAL config and no env. Fixed by giving them the same
  minimal config mock their sibling suites already use.
- Four-way derivation verified for the 3 new vars (hit counts reported in PR):
  Zod ✓, no non-test process.env reads ✓, no dynamic reads ✓, docs ✓ + turbo.json.
- Also fixed a doc gap: TINKER_API_KEY was absent from docs/self-hosting.md's
  env contract; added a row (lessons-critical: fix doc defects everywhere).

PR #96 open with review-in-body. CMAP (gemini/codex/claude, --protocol air
--type pr) running in background; will record verdicts and fix real findings.
