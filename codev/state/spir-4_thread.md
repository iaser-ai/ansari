# spir-4 — Auth hardening thread

Project 4 (SPIR, strict mode): Auth hardening — admin roles in DB, system-account
reservation, logout/rotation fixes, feedback IDOR, config-validation bypass.

## 2026-08-01 — Specify phase start
- Started in `specify` phase. No spec exists yet (only .gitkeep in codev/specs/).
- Issue #4 is a highly detailed 7-item security-hardening brief from a 2026-08-02
  multi-model review. Ordered by severity; scope is authz/authn correctness only
  (rate-limiting / cost-abuse explicitly deferred).
- Spawned an Explore agent to map current state of all referenced auth files so the
  spec's Current State section is accurate.
- Treating the issue's per-item "Fix" directives + Constraints as strong architect
  guidance (no explicit "Baked Decisions" heading, but constraints are firm:
  no streaming/prompt changes, DB schema changes via drizzle-kit generate + manual
  apply, all changes need tests, `npm run typecheck && npm test && npm run build`
  green from backend/).

## Grounding notes (verified directly)
- `users` schema: id, email(unique), passwordHash, firstName, lastName,
  source(default 'web'), registeredVia, createdAt, updatedAt. **No role/is_admin,
  no verified, no session_version, no system marker.** `source` default 'web'
  (issue suggests source='system' marker for system accounts).
- `lib/config.ts`: Zod env schema. `JWT_SECRET` min(32), `ACCESS_TOKEN_EXPIRY_HOURS`
  coerce.number default 2 (no positive bound), `DATABASE_URL` min(1). `config.auth`,
  `config.database`, `config.admin.emails` getters exist. `LEADERBOARD_API_KEY` min(32) optional.
- `admin.ts`: `isAdmin(email)` = `config.admin.emails.includes(email.toLowerCase())`.
  Pure email match, no DB flag.
- `password.ts`: custom scoring (NOT zxcvbn), `valid: score >= 2`, no max length.
  bcrypt SALT_ROUNDS=12. `aaaaaaaa` → score 2 → valid (confirmed).
- Migrations: drizzle/ has 0000_baseline, 0001_add_tokens_rotated_at, 0002_keen_inhumans.
  Convention: `NNNN_name.sql` + meta snapshots + _journal.json. Next = 0003.
  Deps: bcrypt ^6, jsonwebtoken ^9, drizzle-orm ^0.45, zod ^4, vitest ^4.
- Spawned Explore agent for full current-state map of routes/db/middleware.

