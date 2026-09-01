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
