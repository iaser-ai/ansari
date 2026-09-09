# arch-critical.md — Always-On System-Shape Facts (HOT tier)

<!-- HOT tier: capped facts + a bounded map of arch.md. Always injected into every porch
phase prompt and into CLAUDE.md/AGENTS.md. CAP: <=10 facts, <=12 map topics, <=35 lines.
To add a fact, DEMOTE a weaker one into arch.md (displacement). MAINTAIN polices the cap
and keeps the map in sync with arch.md's top-level sections.
STARTER: replace the examples below with YOUR project's facts and arch.md sections. -->

## Critical facts (consult before deciding)
- Admin authorization is the `users.is_admin` DB flag, NEVER an email match; `ADMIN_EMAILS` only reserves addresses + asserts existence at boot.
- System accounts (`ai-skill`, `leaderboard`) are resolved by `users.system_key`, NEVER by email; `@system.ansari.chat` is reserved at registration.
- Auth code reads the JWT secret/expiries and DB URL ONLY through `config` (validated Zod) — never `process.env.JWT_SECRET`/`DATABASE_URL` directly.
- Every token embeds a `session_version`; auth checks it against the user row. Any revocation (password reset, logout) bumps it — this is the uniform "kill all sessions" primitive.
- Token rotation, password reset, logout, and admin-bump run inside a `db.transaction`; DB helpers take an `exec` param so inner writes use the tx (they otherwise close over the global `db`).
- DB schema changes: `drizzle-kit generate` → review SQL → human-applied at deploy. NEVER `db:push`. Deploy order: migration → admin bootstrap (`scripts/grant-admin.ts`) → deploy.
- Turborepo runs STRICT env mode: a var missing from `turbo.json` `globalEnv` is invisible to tasks AND absent from the cache key — a cached artifact can ship wrong values while reporting a hit. Derive additions four ways (Zod schema, static `process.env.X`, dynamic `process.env[`, documented env surface).
- A `workspace:*` dependency does NOT put a package's contents in a consumer's cache hash; shared packages must ALSO be listed in `globalDependencies`, or a warm cache replays stale results against changed shared config.
- Railway deploy config is the DASHBOARD, not `apps/*/railway.toml` — the tomls are the reviewable git record only. Watch paths must include `packages/**`, since both images copy it.
- Vertex rejects any turn after a `functionCall` model turn that lacks EXACTLY matching `functionResponse` parts; `messages.raw_payload` therefore stores only the FINAL model turn, guard-checked to carry zero functionCall parts. Tool history lives in `messages.tool_calls` (+ `tool_call_orphans` for error turns); the thread read helpers project it OUT and NO API response may serialize it or `raw_payload` — the mobile contract is frozen (single-text `content` must stay a bare string).

## Map of arch.md (consult when…)
- Authentication & Authorization — consult when touching login/register/refresh/logout/reset, tokens, admin/system access, or the JWT config.
- Gemini facilitator & message history — consult when touching the facilitator loop, Gemini history building/replay, message persistence, or the repetition guard.
- Monorepo layout, build & deploy — consult when changing the workspace layout, `turbo.json`, env vars, Docker builds, CI task wiring, or Railway deploy config.
