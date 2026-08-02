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

## 2026-08-01 — Spec drafted + 3-way review (specify iter 1)
- Wrote full spec (canonical template) → committed "[Spec 4] Initial specification draft".
- porch checks pass; ran 3-way consult (gemini/codex/claude).
  - **Gemini: APPROVE.** Codex: REQUEST_CHANGES. Claude: REQUEST_CHANGES. Both
    change-requests HIGH-confidence and code-grounded — genuinely useful.
- Key contradictions the reviewers caught + how I resolved them (all baked into spec):
  1. Rotated-reuse detection vs. the deleteExpiredTokens sweep destroy the same rows
     → sweep keys on natural expires_at; retain rotated rows until expiry.
  2. Concurrent-refresh-both-succeed (issue #34) vs. reuse rejection → in-grace accept /
     post-grace detect / unknown forge, defined precisely.
  3. `source='system'` can't disambiguate ai-skill vs leaderboard → unique `system_key`.
  4. Logout has no refresh token in the request → full deleteUserTokens(user.id) (all-device).
  5. Session-version must be checked on access path too (it's FREE — join already returns user).
  6. Admin bootstrap deadlock (reserved-addr registration blocked + boot-fail) → documented
     create-or-flag script; assertion gated to NODE_ENV=production.
  7. Blind backfill could promote a hijacked row → conditional (password_hash='nologin' + legit source).
  8. Factual: no email-change endpoint today (updateUser only from reset_password) — corrected wording.
- Two items left genuinely OPEN for the plan (not architect): deleteExpiredTokens trigger
  (opportunistic vs cron); rotated-reuse response strength (reject+log vs revoke session).
- Wrote rebuttal (4-specify-iter1-rebuttals.md) — all REQUEST_CHANGES points ACCEPTED,
  none rejected. `porch done 4` → **GATE: spec-approval**. Notified architect via afx send.
  **STOPPED, waiting for human approval.** Will NOT self-approve (strict mode + Waleed's rule).

## 2026-08-02 — spec-approval APPROVED by Waleed → Plan phase
- Two NON-NEGOTIABLE requirements to carry into the plan (from architect review):
  1. **Reserved-address registration rejections (admin + system) MUST return the
     IDENTICAL response to the existing "account already exists" 409** —
     `createErrorResponse('An account with this email already exists', 409)`
     (register/route.ts:36). Otherwise registration is an oracle for admin emails.
  2. **Deploy runbook ordering: migration → admin bootstrap → deploy** (prod boot
     asserts admin existence). Bake into plan's runbook + Phase 3/4.
- Phasing (foundation-first, then severity order): 1 config-centralize, 2 issueTokenPair,
  3 schema migration (is_admin/system_key/session_version + conditional backfill),
  4 admin authz+reservation+startup assertion+bootstrap script, 5 system_key reservation,
  6 logout full revoke, 7 atomic rotation+session_version+reset-kill+reuse detect,
  8 feedback IDOR+oracle uniformity, 9 smaller hardening.

## 2026-08-02 — Plan drafted + 3-way review (plan iter 1)
- Wrote 9-phase plan → "[Spec 4] Initial implementation plan". porch checks pass.
- 3-way consult: **Gemini APPROVE. Codex REQUEST_CHANGES. Claude REQUEST_CHANGES**
  (both HIGH confidence; Claude verified against actual worktree code — very valuable).
- Concrete mid-phase defects caught + fixed (all ACCEPTED, verified against code):
  1. `db.transaction()` illusory — helpers close over global `db`. → thread `Executor`
     param through issueTokenPair/storeToken (P2) + markTokenRotated/findToken/
     deleteUserTokens/updateUser (P7).
  2. Phase 3 NOT "schema-only safe" — adding cols breaks hand-DDL pglite suites
     (token-grace.test.ts:37, attribution-schema.test.ts:35 CREATE TABLE users;
     schema.test.ts col assertions; User-literal fixtures). → same-commit DDL/fixture
     sync deliverable; dropped new-migrator harness.
  3. Session-version race: capture version at refresh-auth time, pass into tx issuance
     (equality, missing=0); don't re-fetch after reset increment.
  4. Admin bootstrap must create WITH bcrypt hash (admin UI logs in email+pw); removed
     register-then-flag; `npx tsx scripts/grant-admin.ts <email>`, pw via prompt/env.
  5. Startup assertion fires during `next build` → add NEXT_PHASE!=='phase-production-build' guard.
  6. System lazy-create: hijacked conflict is on unique EMAIL not system_key →
     explicit fail-fast + operator log (not re-read loop); defined created email.
  7. Anti-oracle needs check PLACEMENT before strength check (register 409 is at :36,
     before strength at :39-46), not just same error string.
  8. Logout keeps 401 on no/invalid token (don't change to success/no-op).
  9. Phase 9 must rewrite token-grace.test.ts:147 (asserts the sweep behavior we reverse).
- Closed the 2 open design choices: opportunistic sweep (no cron; railway.toml has none),
  reuse = reject+log (no session bump).
- Wrote rebuttal (4-plan-iter1-rebuttals.md). Committed.
- `porch done 4` → **GATE: plan-approval**. Notified architect. **STOPPED, waiting for
  human approval.** Will NOT self-approve. After approval → Implement phase (Phase 1 first).

## 2026-08-02 — plan-approval APPROVED → Implement Phase 1 (config centralization)
- Installed backend deps (worktree had no node_modules). Baseline: 471 passed, 3 skipped.
- Implemented Phase 1:
  - config.ts: expiry vars now `int().positive()`; added test-only `resetEnvCache()`.
  - db/index.ts: connection string via `config.database.url` (safe — proven no test loads
    db/index unmocked, since DATABASE_URL unset & suite green).
  - middleware.ts: dropped `getJwtSecret()`, uses `config.auth.jwtSecret`.
  - request_password_reset + reset_password routes: `config.auth.jwtSecret`.
- Test fallout (as predicted): password-reset.test.ts (11) broke because routes now hit
  config → full getEnv() validation (KALEMAT/USUL unset). Fix = mock `@/lib/config` in
  that test (established pattern from admin-auth.test.ts). Dropped its stale
  process.env.JWT_SECRET line.
- Added tests/config.test.ts (9 tests): secret<32 reject, empty reject, expiry 0/neg/
  non-int reject, positive-int accept, missing-required reject, resetEnvCache re-parse.
- Result: typecheck clean; **480 passed, 3 skipped**; `next build` green with .env.ci.
  No `process.env.JWT_SECRET/DATABASE_URL` left in the 5 touched files.
- drizzle.config.ts left reading process.env.DATABASE_URL directly (build-time CLI,
  documented exception per plan).
- Phase 1 impl 3-way review: **Gemini APPROVE. Codex + Claude REQUEST_CHANGES** — both
  flag ONE blocker: the listed deliverable "middleware verifies using the config secret"
  had no test (all suites mock middleware wholesale → the swap had no regression guard).
  → Added tests/middleware.test.ts (4 tests): real JWT signed with config secret accepted;
  signed with a DIFFERENT secret rejected (proves middleware passes config.auth.jwtSecret
  to verifyToken). Now 484 passed, 3 skipped; build green.
  Non-blocking notes acknowledged: db/index import now triggers full env schema (intended
  fail-fast; confirm Railway build carries all vars — PR note); `.int()` rejects fractional
  hours (matches plan; no deploy sets one).
- **Phase 1 committed** myself (16bfe9d) — porch only makes chore commits, does NOT
  commit my code. WORKFLOW NOTE for phases 2-9: after unanimous approval, I commit the
  phase's code+tests myself with explicit paths ([Spec 4][Phase: name] ...), no git add -A.

## 2026-08-02 — Implement Phase 2 (issueTokenPair consolidation)
- Added `Executor` type (`typeof db | tx`) + `issueTokenPair(userId, exec=db)` in users.ts;
  storeToken gained `exec=db` param. Sources secret/expiries from config.auth.
- Migrated register/login/refresh_token to `issueTokenPair`; removed their inline
  process.env.JWT_SECRET + parseInt blocks and now-unused generateToken/storeToken imports.
- request_password_reset stays single-reset-token (excluded), already on config from Phase 1.
- Test fallout: refresh-token-route.test.ts + api/register-newsletter.test.ts mocked
  storeToken; swapped to mock issueTokenPair → {accessToken,refreshToken}. Both green.
- New tests: issue-token-pair.test.ts (pglite: two tokens, config-secret signed, exp from
  config 2h/2160h, both stored hashed) + auth-config-bypass.test.ts (guard: no
  process.env.JWT_SECRET/expiry in the 6 auth files).
- Result: typecheck clean; **499 passed, 3 skipped**; build green. Config bypass (item 6)
  fully closed across login/register/refresh/reset/middleware.
- Phase 2 review iter1: **Gemini + Claude APPROVE. Codex REQUEST_CHANGES** — (1) said the
  new tests weren't in the diff (they were untracked → not shown; staged them now); (2) real
  gap: no login route test. → Added tests/login-route.test.ts (3 tests: valid creds issue
  pair + response contract + issueTokenPair called with user.id; unknown user 401 no-issue;
  wrong pw 401 no-issue). Now 502 passed, 3 skipped; build green. Staged all Phase 2 files
  so the re-review diff includes the 3 new test files.
- Phase 2 iter2: unanimous APPROVE. Committed (063c2e2).

## 2026-08-02 — Implement Phase 3 (schema migration + backfill + DDL sync)
- Schema: users +is_admin(bool,notNull,default false) +system_key(text,nullable,unique index
  idx_users_system_key) +session_version(int,notNull,default 0).
- `db:generate` → drizzle/0003_lying_dracula.sql: 3 ADD COLUMN + CREATE UNIQUE INDEX
  (additive, no destructive stmts; NULLs-distinct so many real users don't collide).
- Appended CONDITIONAL backfill to 0003 SQL: mark ai-skill/leaderboard system rows with
  system_key ONLY where password_hash='nologin' AND matching source (hijacked real-hash rows
  NOT promoted → manual remediation via runbook).
- Synced hand-DDL (else drizzle column-enumeration breaks pglite selects): token-grace.test.ts,
  attribution-schema.test.ts, issue-token-pair.test.ts CREATE TABLE users +3 cols;
  schema.test.ts +3 col assertions. User-literal fixtures did NOT break typecheck (not
  strictly typed as User).
- New test: system-key-backfill.test.ts — legit row marked, hijacked (real hash) refused,
  ordinary user untouched, many NULLs allowed under unique index.
- Result: typecheck clean; **504 passed, 3 skipped**; build green; `db:generate` reports
  "No schema changes" (no drift). Migration NOT applied (human applies at deploy; no db:push).


