# Plan: Auth Hardening — Durable Admin Roles, System-Account Reservation, Session-Revocation & Config-Validation Fixes

## Metadata
- **ID**: plan-2026-08-02-auth-hardening
- **Status**: complete — all 9 phases implemented & reviewed (PR #15)
- **Specification**: [codev/specs/4-auth-hardening-admin-roles-in-.md](../specs/4-auth-hardening-admin-roles-in-.md)
- **Created**: 2026-08-02

## Executive Summary

Implements the spec's **Approach 1** (durable identity attributes + a single validated config/token path). The work is decomposed **foundation-first, then in issue severity order**: two low-risk refactor phases (centralize config, consolidate token issuance) establish the shared plumbing; one schema-migration phase adds the three durable columns (`is_admin`, `system_key`, `session_version`) in a single reviewable migration; then the six feature phases each close one vulnerability, building on the foundation.

This ordering deviates from pure issue-severity order (admin authz is issue #1) deliberately: the config/token consolidation and schema are foundations that the admin, system, and session-version phases depend on, and the reviewers explicitly endorsed "config/token consolidation as a shared foundation." Every phase is an independently-testable, single atomic **git commit**; **all phase-commits ship in ONE PR** (opened during/after the final phase) per the project PR strategy — not one PR per phase.

**Two architect-pinned, non-negotiable requirements** thread through the plan:
1. **Anti-oracle**: reserved-address registration rejections (admin **and** system) return the *identical* response to the existing conflict — `createErrorResponse('An account with this email already exists', 409)` (`register/route.ts:36`) — so registration never reveals which emails are admin/system.
2. **Deploy runbook ordering**: **migration → admin bootstrap → deploy** (production boot asserts admin existence). See Documentation Updates / Runbook.

## Success Metrics
- [ ] All specification Success Criteria met (admin durability, registration guard + bootstrap, system reservation by `system_key`, conditional backfill safety, logout revocation, feedback ownership + oracle uniformity, atomic rotation + session-version on both paths + reuse detection, sweep/retention reconciliation, config routing, smaller items).
- [ ] Reserved-address rejections are byte-identical to the existing 409 (anti-oracle) — asserted by test.
- [ ] `npm run typecheck && npm test && npm run build` green from `backend/`; suite green with only `.env.ci`; no coverage reduction.
- [ ] Exactly the schema migrations generated (via `drizzle-kit generate`, **never** `db:push`); SQL reviewed; human-applied at deploy.
- [ ] Zero new external runtime dependency on the request path.

## Phases (Machine Readable)

```json
{
  "phases": [
    {"id": "phase_1", "title": "Centralize auth config through config.ts"},
    {"id": "phase_2", "title": "Consolidate token issuance into issueTokenPair"},
    {"id": "phase_3", "title": "Schema migration: is_admin, system_key, session_version + conditional backfill"},
    {"id": "phase_4", "title": "Durable admin authorization + reserved-address reservation + startup assertion + bootstrap"},
    {"id": "phase_5", "title": "System-account reservation via system_key"},
    {"id": "phase_6", "title": "Logout: full session revocation"},
    {"id": "phase_7", "title": "Atomic rotation + session version + reliable reset kill + reuse detection"},
    {"id": "phase_8", "title": "Feedback IDOR fix + oracle uniformity"},
    {"id": "phase_9", "title": "Smaller hardening: timing-safe compare, password policy, generic error, token sweep"}
  ]
}
```

## Phase Breakdown

### Phase 1: Centralize auth config through `config.ts`
**Dependencies**: None

#### Objectives
- Make every auth path obtain the JWT secret, token expiries, and DB URL from validated `config`, so `min(32)` / positive-bounds validation always runs. No schema change.

#### Deliverables
- [ ] `lib/config.ts`: add positive bounds to the env schema — `ACCESS_TOKEN_EXPIRY_HOURS` and `REFRESH_TOKEN_EXPIRY_HOURS` as `z.coerce.number().int().positive()` (keep existing defaults 2 / 2160). Confirm `config.auth` exposes `jwtSecret`, `accessTokenExpiryHours`, `refreshTokenExpiryHours`; `config.database.url` already exists.
- [ ] Export a test-only cache reset (e.g. `resetEnvCache()` clearing `cachedEnv`) so config-validation tests can re-parse `process.env` (needed because `getEnv()` memoizes and existing tests set `JWT_SECRET` in `beforeAll`).
- [ ] `lib/db/index.ts`: read the connection string from `config.database.url` instead of `process.env.DATABASE_URL`.
- [ ] `lib/auth/middleware.ts`: source the JWT secret from `config.auth.jwtSecret` (remove the direct `getJwtSecret()`/`process.env.JWT_SECRET` read).
- [ ] `v2/request_password_reset/route.ts` and `v2/reset_password/route.ts`: replace `process.env.JWT_SECRET!` with `config.auth.jwtSecret` (these are verify/sign-reset sites; the generate-and-store sites are Phase 2).
- [ ] Tests: short (`<32`), empty, and non-positive/zero expiry values are rejected via config validation; middleware verifies using the config secret.

#### Implementation Details
- `drizzle.config.ts` reads `process.env.DATABASE_URL!` directly — this is a **build-time CLI config**, not a request path; leave it (documented exception) to avoid importing the runtime `config` into the drizzle CLI context.
- The cache-reset export is `NODE_ENV==='test'`-guarded or simply exported and only called from tests; it must not change production behavior.

#### Acceptance Criteria
- [ ] No request-time code in Phase 1's files reads `process.env.JWT_SECRET` / `DATABASE_URL` directly.
- [ ] Config rejects `JWT_SECRET` < 32 chars and expiry ≤ 0. All existing tests still pass.

#### Test Plan
- **Unit**: config schema accept/reject boundaries (secret length, expiry positivity) using the cache-reset hook; middleware verifies a token signed with the config secret.
- **Integration**: existing auth suites (`auth.test.ts`, `refresh-token-route.test.ts`) stay green.

#### Rollback Strategy
Revert the single phase commit; the routes fall back to direct env reads (prior behavior).

#### Risks
- **Risk**: `getEnv()` memoization makes the short-secret test flaky. **Mitigation**: the exported cache-reset hook, called in the test's `beforeEach`.
- **Risk**: importing `config` into `lib/db/index.ts` creates an import cycle. **Mitigation**: `config.ts` has no db import; verify no cycle via `typecheck`/build.

---

### Phase 2: Consolidate token issuance into `issueTokenPair`
**Dependencies**: Phase 1

#### Objectives
- Replace the duplicated generate-and-store blocks in the three **pair-issuing** routes with one `issueTokenPair` helper that reads expiries from `config.auth` and stores hashed access + refresh tokens — and give it a **transaction-executor parameter up front** so Phase 7 can call it inside a transaction.

#### Deliverables
- [ ] New helper `issueTokenPair(userId: string, exec: Executor = db)` (in `lib/db/users.ts` alongside token storage) returning `{ accessToken, refreshToken }`, using `generateToken` + `storeToken` and `config.auth` expiries. **The `exec` (Drizzle db-or-tx) parameter is defined now** even though Phase 1/2 always pass the default `db`; Phase 7 passes a `tx`. `storeToken` also gains the `exec` parameter so the inserts run on the caller's executor.
- [ ] Migrate the **pair-issuing** sites only — `v2/users/register`, `v2/users/login`, `v2/users/refresh_token` — to call `issueTokenPair`; remove their inline `process.env.JWT_SECRET!` / `parseInt(...)` blocks.
- [ ] `v2/request_password_reset` issues a **single reset token**, not a pair — it is **explicitly excluded** from `issueTokenPair`. In this phase it only has its `process.env.JWT_SECRET!` read replaced with `config.auth.jwtSecret` (already partly covered by Phase 1; ensure its reset-token generate/store uses config, not `issueTokenPair`).
- [ ] Tests: `issueTokenPair` unit (returns two valid, correctly-typed, stored tokens; token `exp` matches `config.auth`); each migrated route still issues working tokens; a **repo-wide assertion test** that greps the auth routes for `process.env.JWT_SECRET` and fails if any remain.

#### Implementation Details
- Define an `Executor` type (Drizzle `PgDatabase` | transaction) once so Phase 7's threading is type-clean. `issueTokenPair(userId, exec=db)` and `storeToken(..., exec=db)` default to the module-level `db`, so Phase 1/2 behavior is identical to today.
- Preserve exact response shapes each route returns today (e.g. register's `{ status: 'success', ... }`) — pure internal refactor, no wire change.
- `refresh_token` still performs rotation/mark-rotated around the issuance; only the generate-and-store block is replaced here (rotation *atomicity* is Phase 7).

#### Acceptance Criteria
- [ ] Single generate-and-store implementation; no direct `process.env.JWT_SECRET` in any migrated route.
- [ ] Login/register/refresh flows behave identically (tests green).

#### Test Plan
- **Unit**: `issueTokenPair` returns/stores two tokens; types are `access`/`refresh`.
- **Integration**: login→me, register→me, refresh happy-path unchanged.

#### Rollback Strategy
Revert commit; routes revert to inline issuance.

#### Risks
- **Risk**: subtle divergence in expiry between routes post-consolidation. **Mitigation**: assert token `exp` matches `config.auth` values in a unit test.

---

### Phase 3: Schema migration — `is_admin`, `system_key`, `session_version` + conditional backfill
**Dependencies**: None (foundation for Phases 4, 5, 7)

#### Objectives
- Add the three durable, server-controlled columns in **one reviewable migration**, with a legitimacy-checked backfill for existing system rows — **and keep the repo's hand-written test DDL in sync** so the existing pglite suites don't break.

#### Deliverables
- [ ] `db/schema/users.ts`: add
  - `isAdmin: boolean('is_admin').notNull().default(false)`
  - `systemKey: text('system_key')` with a **unique** index (nullable; non-null only on system rows)
  - `sessionVersion: integer('session_version').notNull().default(0)`
- [ ] `npm run db:generate` → produces `drizzle/0003_*.sql` (+ meta snapshot, `_journal.json`). **Review the SQL. Do NOT `db:push`.**
- [ ] Author the **conditional backfill** as SQL applied with the migration:
  `UPDATE users SET system_key = 'ai-skill'    WHERE email = 'ai-skill@system.ansari.chat'    AND password_hash = 'nologin' AND source = 'ai-skill';`
  `UPDATE users SET system_key = 'leaderboard' WHERE email = 'leaderboard@system.ansari.chat' AND password_hash = 'nologin' AND source = 'leaderboard';`
- [ ] **Sync the hand-written pglite DDL and fixtures (REQUIRED — adding columns breaks these otherwise):**
  - `tests/token-grace.test.ts` (hand `CREATE TABLE users` at ~line 37): add `is_admin`, `system_key`, `session_version` columns — because drizzle `select()`/`innerJoin(users)` in `findToken` enumerates every schema column, so a missing DB column throws `column users.is_admin does not exist`.
  - `tests/attribution-schema.test.ts` (hand `CREATE TABLE users` at ~line 35; the file states its DDL "MUST stay in sync with db/schema/*.ts"): add the three columns.
  - `tests/schema.test.ts` (~lines 5-15): add `expect(users.isAdmin/systemKey/sessionVersion).toBeDefined()` assertions.
  - Typecheck fixtures that build `User` literals — `tests/refresh-token-route.test.ts:~40` (and any other `User`-typed literal) — now need `isAdmin`/`sessionVersion` (non-optional in `$inferSelect`). Add the fields.
- [ ] Tests: on hand-DDL pglite, insert a legit system row (`password_hash='nologin'`, matching `source`) and a hijacked row (real bcrypt hash, same email shape) and run the **exact backfill UPDATE** — assert it marks only the legit row. (This validates the backfill *predicate* using the repo's existing hand-DDL pattern; it does **not** introduce a new SQL-file migrator harness.)

#### Implementation Details
- Unique index on `system_key` must permit multiple NULLs (Postgres unique indexes treat NULLs as distinct by default; verify the generated DDL does **not** use `NULLS NOT DISTINCT`).
- **This phase is NOT "schema-only, safe to land" in isolation** — the schema change ripples into the hand-DDL test harness (above). The application code does not yet *read* the new columns, but the column *enumeration* on every `users` select means the DDL sync is mandatory in the same commit. Existing rows get `is_admin=false`, `session_version=0`, `system_key=NULL` via defaults.
- The repo has **no SQL-file migrator in tests** (tests hand-write DDL); do not add one here. The generated `drizzle/0003_*.sql` is for the human deploy apply, reviewed by eye.

#### Acceptance Criteria
- [ ] `db:generate` produces a reviewed additive migration; `system_key` unique index allows multiple NULLs; backfill predicate is legitimacy-checked.
- [ ] `npm run typecheck && npm test` green — including the updated hand-DDL suites and `User`-literal fixtures.

#### Test Plan
- **Unit/Integration** (pglite, hand-DDL): backfill legit-vs-hijacked predicate; updated `schema.test.ts` column assertions; existing token-grace/attribution suites still green with the synced DDL.
- **Manual**: read the generated SQL diff; confirm additive-only, no destructive statements, no `db:push`.

#### Rollback Strategy
The migration is additive (new nullable/defaulted columns). Rollback = a follow-up migration dropping the columns; not expected. Revert the schema commit (which also reverts the DDL/fixture sync) before the human applies the migration if needed.

#### Risks
- **Risk**: adding columns silently breaks the hand-DDL pglite suites. **Mitigation**: the DDL/fixture sync is an explicit same-commit deliverable above.
- **Risk**: a system email is already hijacked, so the legit row doesn't exist and backfill marks nothing → Phase 5 must provision by key and fail-fast on the taken email. **Mitigation**: Phase 5 resolves identity by `system_key`; the runbook inspect-before-apply step (a hard precondition) surfaces a hijacked row for manual remediation before deploy.

---

### Phase 4: Durable admin authorization + reserved-address reservation + startup assertion + bootstrap
**Dependencies**: Phase 3 (`is_admin`), Phase 1 (config)

#### Objectives
- Gate admin on `users.is_admin`; reserve admin addresses at registration (anti-oracle 409); assert admin existence at production boot; provide a bootstrap path.

#### Deliverables
- [ ] `lib/auth/admin.ts`: `requireAdmin` grants iff `authResult.user.isAdmin === true` (DB flag). The email-based `isAdmin(email)` is **removed**; its reservation role moves to a shared `isReservedAddress` helper (below). `/api/v2/admin/stats` is unaffected structurally.
- [ ] **Rewrite `tests/admin-auth.test.ts`**: it currently tests `isAdmin(email)` (lines 29-57), which no longer exists. Replace with tests for `requireAdmin` gating on the `is_admin` flag and for `isReservedAddress`.
- [ ] Reserved-address check (shared helper `lib/auth/reserved.ts` `isReservedAddress(normalizedEmail): boolean`): returns true for any configured admin address (`config.admin.emails`). (Phase 5 extends it to system addresses/domain.)
- [ ] `v2/users/register`: call `isReservedAddress(email.toLowerCase())` and, on match, return **exactly** `createErrorResponse('An account with this email already exists', 409)`. **Placement is load-bearing (architect-pinned anti-oracle):** the check MUST sit **immediately adjacent to the existing conflict check (register/route.ts:34-36), BEFORE the password-strength check at lines 39-46.** Otherwise `reserved + weak-password` returns 400 while `taken + weak-password` returns 409 — reopening the oracle. Ideally fold reserved-address into the same branch as the existing-account check so both yield the identical 409 at the same point.
- [ ] Production startup assertion in `src/instrumentation.ts` `register()`: assert every `config.admin.emails` address has a matching user row with `is_admin=true`; throw (fail-fast) otherwise. **Gating (all must hold to run): `NODE_ENV==='production'` AND `NEXT_RUNTIME==='nodejs'` AND `NEXT_PHASE !== 'phase-production-build'`** — the build-phase guard prevents the assertion (a DB query) from executing during `next build`, which CI runs with `.env.ci`'s unreachable `DATABASE_URL`. Verify with a real `npm run build` that boot-assert does not fire at build time.
- [ ] `scripts/grant-admin.ts` — **the sole bootstrap path** (reserved-address registration is blocked): given an email (and password via prompt/env, NOT a CLI arg that lands in shell history), **create the user with a real bcrypt `password_hash` (via `hashPassword`) and `is_admin=true`**, or set `is_admin=true` if the row already exists (idempotent upsert on email). Invoked as `npx tsx scripts/grant-admin.ts <email>` from `backend/`. It must produce an account that can log in (the admin UI `src/app/admin/analytics/page.tsx:~84` authenticates with email+password before reaching stats).
- [ ] Tests: (a) allowlisted-email + `is_admin=false` → `/admin/stats` 403; (b) `is_admin=true` → 200; (c) registering a reserved admin address → **byte-identical** 409 as the existing conflict (assert status + message + body shape), including the `reserved + weak-password` case still returning 409 (placement test); (d) startup assertion throws in prod-sim when the admin row is missing, and is skipped when `NEXT_PHASE==='phase-production-build'` / in test; (e) bootstrap script creates a login-capable admin and is idempotent.

#### Implementation Details
- **Anti-oracle (architect-pinned)**: reuse the exact `createErrorResponse('An account with this email already exists', 409)` call AND place it before the strength check. Both the string/status AND the placement are required.
- The startup DB query couples prod boot to DB reachability (accepted fail-fast); log a clear message on assertion failure (no user content). The `NEXT_PHASE` build guard is mandatory, not optional.
- Bootstrap password handling: prompt interactively or read from an env var the operator sets for the run; never accept the password as a positional CLI arg (shell-history leak).

#### Acceptance Criteria
- [ ] Admin authorization derives solely from `is_admin`; email allowlist is used only for reservation + startup assertion.
- [ ] Reserved-admin registration is indistinguishable from an existing-account conflict.
- [ ] Prod boot fails fast when a configured admin account is absent; dev/CI unaffected.

#### Test Plan
- **Integration**: admin-stats allow/deny by flag; register reserved-address oracle-uniformity.
- **Unit**: startup assertion function (inject a mock user lookup); bootstrap script logic.

#### Rollback Strategy
Revert commit → admin reverts to email-match (pre-fix). Because it's one commit, revert is clean.

#### Risks
- **Risk**: startup assertion breaks a prod deploy where admin isn't yet provisioned. **Mitigation**: the runbook ordering (migration → **admin bootstrap** → deploy) guarantees the admin exists before boot; documented explicitly.

---

### Phase 5: System-account reservation via `system_key`
**Dependencies**: Phase 3 (`system_key`), Phase 4 (shared reserved-address helper)

#### Objectives
- Resolve system users by `system_key` (never by attacker-registerable email) and reserve the system domain at registration (anti-oracle 409).

#### Deliverables
- [ ] `lib/db/users.ts`: `findSystemUser(systemKey: 'ai-skill' | 'leaderboard')` (lookup by `system_key`) and idempotent `getOrCreateSystemUser(systemKey)`.
- [ ] **Define the exact identity of a lazily-created system row.** The row sets `system_key`, `password_hash='nologin'`, `source=systemKey`, and a **deterministic email that cannot collide with a public registration** — the reserved system addresses (`ai-skill@system.ansari.chat` / `leaderboard@system.ansari.chat`). Because registration of the `@system.ansari.chat` domain is blocked (this phase), that email is only ever creatable by this helper going forward.
- [ ] **Hijacked-row handling (explicit fail-fast, not a retry loop).** If `findSystemUser(key)` returns nothing AND the insert fails on the **unique `email`** constraint (meaning a pre-existing row already holds that email but has no `system_key` — i.e. it was hijacked before the reservation landed), do **not** re-read by `system_key` (that returns nothing and would loop). Instead **fail fast**, logging an operator-actionable message ("system email X is occupied by a non-system account; run the inspect-before-apply remediation"). This case is prevented in normal deploys by the runbook's inspect-before-apply hard precondition; the code fails loudly rather than silently misbehaving.
- [ ] `v2/mcp-complete/route.ts` and `v1/chat/completions/route.ts`: replace `findUserByEmail(SYSTEM_USER_EMAIL) || createUser(...)` with `getOrCreateSystemUser('ai-skill' | 'leaderboard')`. Keep the module-level id cache.
- [ ] Extend the shared `isReservedAddress` helper (Phase 4) to also match the configured system domain (`@system.ansari.chat`) / configured system addresses; `register` returns the **identical** 409 on match, **at the same pre-strength-check placement** as Phase 4 (anti-oracle).
- [ ] Config: add the system-address/domain source (a `config.system` getter or a constant list) so reservation and lookup share one source of truth.
- [ ] Tests: (a) registering `ai-skill@system.ansari.chat` / `leaderboard@system.ansari.chat` / arbitrary `@system.ansari.chat` → identical 409 (incl. reserved + weak-password → still 409); (b) `findSystemUser('ai-skill')` and `('leaderboard')` each resolve the correct row; (c) a pre-registered look-alike (no `system_key`) is **not** returned by `findSystemUser`; (d) the hijacked-email insert path fails fast with the operator log (not an infinite retry).

#### Implementation Details
- System identity is fully decoupled from email *for authorization/attribution* (lookup is by `system_key`), but the row still carries the canonical email as a value; the unique-email constraint is what the hijack case trips, hence the explicit fail-fast above.
- Concurrent provisioning (normal case): on a unique-`system_key` conflict from a race between two lazy creators, re-read by `system_key` and use that row.

#### Acceptance Criteria
- [ ] No system endpoint resolves its identity by email; lookup is by `system_key`.
- [ ] System-domain registration is indistinguishable from an existing-account conflict (same 409, same placement).
- [ ] The hijacked-email case fails fast with an actionable log, never a silent misroute or loop.

#### Test Plan
- **Integration**: system-address registration oracle-uniformity; system lookup-by-key for both identities; hijack-attempt not resolved; fail-fast on occupied email.
- **Unit**: `getOrCreateSystemUser` idempotency (existing-row race) and fail-fast (occupied email) branches.

#### Rollback Strategy
Revert commit → endpoints revert to email lookup. (Do not revert Phase 3 columns.)

#### Risks
- **Risk**: an already-hijacked system email blocks lazy creation (unique email). **Mitigation**: runbook inspect-before-apply is a hard precondition; code fails fast with an operator-actionable log instead of misrouting.

---

### Phase 6: Logout — full session revocation
**Dependencies**: Phase 1 (middleware/config) — otherwise standalone

#### Objectives
- Make logout reliably end the session by revoking all of the user's tokens.

#### Deliverables
- [ ] `v2/users/logout/route.ts`: resolve the user from the access token (verify it and load the user), then call `deleteUserTokens(user.id)` (full, all-device logout) instead of `deleteToken(token)`.
- [ ] **Preserve the existing wire contract for the auth-failure paths**: the route currently returns `createErrorResponse('Not authenticated', 401)` when no bearer token is present (`logout/route.ts:12`). **Keep the 401** for missing token; an **invalid/unverifiable** token also returns 401 (do not silently succeed). Only a valid access token proceeds to `deleteUserTokens`.
- [ ] Tests: after logout with a valid token, the user's refresh token is rejected by `refresh_token` and the access token is rejected by an authenticated endpoint; **no-token → 401; invalid-token → 401** (contract preserved).

#### Implementation Details
- Full logout is the pinned decision (spec Desired State #3): the request carries only the bearer access token and there's no per-device session grouping. **Update the existing logout test** (`tests/refresh-token-route.test.ts` currently asserts `deleteToken('at')` single-token deletion) to the new `deleteUserTokens(user.id)` contract.
- Do **not** change the no-token behavior to success/no-op — it returns 401 today and must continue to.

#### Acceptance Criteria
- [ ] Valid-token logout revokes all the user's tokens (post-logout refresh rejected); all-device behavior documented.
- [ ] No-token and invalid-token both return 401 (unchanged contract).

#### Test Plan
- **Integration**: login → logout → refresh (expect reject) and authed request (expect 401); no-token logout → 401; invalid-token logout → 401.

#### Rollback Strategy
Revert commit → logout reverts to access-token-only deletion.

#### Risks
- **Risk**: broadening deletion changes the (currently single-token) logout test. **Mitigation**: update that test to the full-logout contract as a listed deliverable; keep the 401 auth-failure assertions intact.

---

### Phase 7: Atomic rotation + session version + reliable reset kill + reuse detection
**Dependencies**: Phase 2 (`issueTokenPair`), Phase 3 (`session_version`)

#### Objectives
- Make refresh rotation atomic; bump `session_version` on password reset; check it on **every** token validation (access + refresh); retain rotated rows until natural expiry so rotated-token reuse is detected.

#### Deliverables
- [ ] **Thread the transaction executor through every helper the rotation/reset paths touch** (this is what makes atomicity real — `db.transaction()` is a no-op unless inner queries use the `tx` handle, and today `storeToken`, `markTokenRotated`, `findToken`, `deleteUserTokens`, `updateUser`, and `issueTokenPair` all close over the module-level `db`). Add the `exec: Executor = db` parameter (introduced in Phase 2 for `issueTokenPair`/`storeToken`) to `markTokenRotated`, `findToken`, `deleteUserTokens`, and `updateUser`. Enumerate each signature change as a deliverable.
- [ ] `lib/db/users.ts`: wrap validate → mark-rotated → issue-pair in a **DB transaction** (`db.transaction(async (tx) => …)`), passing `tx` to every inner helper. Preserve issue #34 concurrent-refresh-both-succeed within the 60s grace.
- [ ] Session version: embed the issuing `session_version` in the token payload (extend `generateToken`/`issueTokenPair`); `authenticateRequest` and `validateRefreshToken` reject when the token's version **≠** the user's current `session_version` (equality check; a **missing claim is treated as version 0**). The compare piggybacks on the existing `findToken` `innerJoin users` (no extra query).
- [ ] **Capture the session version at authorization time, not re-fetch after mutation.** During a refresh, read the user's `session_version` when the refresh token is validated and pass **that captured value** into transactional issuance, so a refresh racing a concurrent reset cannot mint version-*current* tokens: if the reset already incremented the version, the captured (pre-reset) value is stale and the newly-issued tokens carry the stale version → rejected. Do **not** have `issueTokenPair` re-read `session_version` inside the transaction.
- [ ] `v2/reset_password/route.ts`: **inside one reset transaction**, `updateUser({passwordHash}, tx)` + increment `users.session_version` (`tx`) + `deleteUserTokens(user.id, tx)`, so revocation and version bump commit atomically.
- [ ] Rotated-token reuse: `findToken` distinguishes (a) valid, (b) rotated-within-grace (accept), (c) rotated-past-grace but **not yet past natural `expires_at`** (retained row → **detected reuse**: reject + log), (d) unknown hash (forged: reject). Log detected reuse at `warn` (no user content, no raw/unhashed token). **Decision: reject + log only; do NOT bump `session_version` on reuse** (revoke-on-reuse is noted as a future option, not implemented here).
- [ ] Tests: reset-vs-refresh interleavings (both orderings) as **deterministic sequences** prove no post-reset-valid pair survives; session-version (≠, missing=0) invalidates a pre-reset access token on the access path; rotated-token replay past grace is detected; in-grace concurrent refresh still both succeed.

#### Implementation Details
- **pglite is a single in-process connection and cannot exercise real concurrency** — the existing "concurrent refresh" coverage (`refresh-token-route.test.ts:~67`) is fully mocked. Test races as **deterministic interleavings** (call the steps in a fixed order), not true parallelism. Also verify `db.transaction()` interacts cleanly with the existing pglite hand-DDL patterns (it may serialize; ensure no deadlock/hang in the suite).
- The retention rule lives with the sweep (Phase 9): `deleteExpiredTokens` deletes only rows past natural `expires_at`, never merely past grace — this keeps a rotated row available for reuse detection. If Phase 9 lands after Phase 7, retention is already the default (nothing sweeps yet).
- Embedding `session_version` in the JWT keeps the access-path check to a comparison against the joined user row.

#### Acceptance Criteria
- [ ] Rotation is genuinely atomic (all inner queries use `tx`) and preserves concurrent-refresh semantics.
- [ ] Password reset reliably kills sessions on both token paths (version captured at auth-time, checked by equality, missing=0).
- [ ] Rotated-token reuse past grace (pre-expiry) is detected and logged.

#### Test Plan
- **Integration (pglite, deterministic interleavings)**: reset/refresh both orderings; reuse-detection; grace-window concurrency (mocked/sequenced); access-path version rejection.
- **Unit**: `findToken` state machine (valid / in-grace / past-grace-reuse-pre-expiry / unknown); executor threading (helper called with `tx` writes within the transaction).

#### Rollback Strategy
Revert commit → rotation reverts to non-transactional soft-mark; `session_version` column remains unused (harmless).

#### Risks
- **Risk**: transaction serialization regresses refresh throughput / hangs pglite. **Mitigation**: row-scoped locking; verify the suite doesn't deadlock; deterministic-interleaving tests.
- **Risk**: embedding version in the JWT changes token payload. **Mitigation**: additive claim; missing claim treated as version 0 for pre-existing tokens.
- **Risk**: re-fetching version inside issuance would defeat the race fix. **Mitigation**: capture-at-auth-time is an explicit deliverable; a test asserts a reset-before-issue interleaving yields a rejected token.

---

### Phase 8: Feedback IDOR fix + oracle uniformity
**Dependencies**: None (independent)

#### Objectives
- Accept feedback only for threads owned by the authenticated user, via a single owner-scoped query; make failure responses uniform to close the existence oracle.

#### Deliverables
- [ ] `lib/db/threads.ts` (or `lib/db/feedback.ts`): a single scoped repository function that resolves the message **only when** `messages.thread_id = threadId AND threads.user_id = authUserId` (join `messages → threads`).
- [ ] `v2/feedback/route.ts`: use the scoped function; if it returns nothing, respond with a **uniform** status + body shape covering nonexistent thread, foreign-owned thread, and mismatched message (a single 404/generic response — not distinct codes/messages).
- [ ] Tests: cross-user `(thread_id, message_id)` rejected; owner's own pair accepted; nonexistent / foreign / mismatched all return the same status + shape.

#### Implementation Details
- Prefer one query (owner-scoped join) over fetch-then-check to avoid a TOCTOU gap and to keep the response uniform.

#### Acceptance Criteria
- [ ] No cross-user feedback write is possible; failure responses do not distinguish the three failure modes.

#### Test Plan
- **Integration**: the three-way oracle-uniformity matrix + positive path.

#### Rollback Strategy
Revert commit → feedback reverts to message-in-thread-only check.

#### Risks
- **Risk**: a legitimate client relied on a specific error code. **Mitigation**: uniform response is a security requirement; note the (minor) client-facing error-shape change in the PR.

---

### Phase 9: Smaller hardening — timing-safe compare, password policy, generic error, token sweep
**Dependencies**: Phase 7 (retention rule alignment for the sweep)

#### Objectives
- Close the four low-cost items without over-engineering.

#### Deliverables
- [ ] `v1/chat/completions/route.ts` `authorize()`: replace `match[1].trim() !== expected` with a constant-time comparison — `crypto.timingSafeEqual` on equal-length buffers (length-check first to avoid throwing; unequal length ⇒ reject).
- [ ] `lib/auth/password.ts`: raise `checkPasswordStrength` to `valid: score >= 3`; enforce a maximum length via the Zod schemas (`register` `password: z.string().min(8).max(128)`, `reset_password` `.max(128)`). Note in code/comment that bcrypt still truncates at 72 bytes (residual, not eliminated).
- [ ] `v2/users/register/route.ts`: catch block returns a generic message (e.g. `'Registration failed'`) and logs the detailed error server-side (no user content). (System routes' `error.message` leakage may be addressed here too if low-cost.)
- [ ] Wire `deleteExpiredTokens` as a **low-probability, non-blocking opportunistic sweep** on token operations (**DECISION: opportunistic, not cron** — `railway.toml` has no cron and adding one is infra work outside this PR's shape). Fire-and-forget (don't block the request). Adjust its predicate so it deletes **only tokens past natural `expires_at`** (retaining post-grace-but-unexpired rotated rows for reuse detection, per Phase 7).
- [ ] **Rewrite the existing green assertion** `tests/token-grace.test.ts:~147` ("deleteExpiredTokens sweeps spent rotated tokens but keeps fresh ones") — it asserts exactly the behavior this phase reverses (post-grace rotated rows must now be **retained** until natural expiry). Update it to the new retention contract so a future builder doesn't "fix" the code back. Explicit deliverable.
- [ ] Tests: timing-safe compare correctness (match / mismatch / length-mismatch); `aaaaaaaa` rejected (now score < 3), 129-char rejected, strong accepted; register returns generic error (detail not in body, logged server-side); sweep deletes past-`expires_at` rows but **retains** post-grace unexpired rotated rows.

#### Implementation Details
- **Sweep decision is now closed: opportunistic**, low-probability, non-blocking. No Railway cron. Honor the natural-`expires_at` retention rule so it never deletes a rotated row still needed for reuse detection.
- Constant-time compare must handle the unconfigured-key path (existing 503) unchanged, and the **length-mismatch case** (reject without calling `timingSafeEqual` on unequal-length buffers, which throws).
- `score >= 3` at reset/registration only affects new passwords; login compares bcrypt hashes and is unaffected.

#### Acceptance Criteria
- [ ] Leaderboard compare is constant-time; password policy is `score>=3` + `.max(128)`; register error is generic (detail logged); `deleteExpiredTokens` runs and honors retention.

#### Test Plan
- **Unit**: timing-safe helper; password boundaries; register error shape.
- **Integration**: sweep retention (expired deleted, rotated-non-expired kept).

#### Rollback Strategy
Each item is small; revert the phase commit to restore prior behavior.

#### Risks
- **Risk**: raising to `score>=3` rejects some existing weak-but-accepted passwords at *reset* time only (login unaffected — it compares hashes). **Mitigation**: policy applies to new/reset passwords only; documented.
- **Risk**: opportunistic sweep adds latency to token ops. **Mitigation**: low probability + indexed delete; or choose cron.

---

## Dependency Map
```
Phase 1 (config) ──→ Phase 2 (issueTokenPair) ─────────────→ Phase 7 (rotation+session+reset+reuse) ──→ Phase 9 (smaller: sweep retention)
                                                              ↑
Phase 3 (schema: is_admin, system_key, session_version) ─────┤
      ├──→ Phase 4 (admin authz + reservation + bootstrap) ──┤ (shared reserved-address helper)
      └──→ Phase 5 (system_key reservation) ─────────────────┘
Phase 6 (logout) ── independent (uses Phase 1 middleware)
Phase 8 (feedback IDOR) ── independent
```

## Resource Requirements
### Development Resources
- **Engineers**: backend (auth/db/Next.js API) familiarity.
- **Environment**: local dev + pglite for DB-backed tests; `.env.ci` dummy env for CI.

### Infrastructure
- **Database changes**: one migration (`0003_*`) adding `is_admin`, `system_key` (unique), `session_version` + conditional backfill. Human-applied at deploy; **never `db:push`**.
- **New services**: none. `deleteExpiredTokens` runs as an in-process opportunistic sweep (decided — no Railway cron).
- **Configuration updates**: possibly a `config.system` source for reserved system addresses/domain; document any new env in `lib/config.ts` + `.env.example`.

## Integration Points
### Internal Systems
- **`lib/config.ts`** — Phases 1, 4, 5 (config surface, reserved addresses). Fallback: N/A (fail-fast by design).
- **`lib/db/users.ts` / `lib/db/threads.ts`** — Phases 2, 5, 7, 8 (helpers). 
- **`src/instrumentation.ts`** — Phase 4 (prod startup assertion; `NEXT_RUNTIME==='nodejs'`).
- **`v1/chat/completions`, `v2/mcp-complete`** — Phases 5, 9 (system identity, timing-safe compare). These endpoints' *auth* is otherwise **out of scope**.

## Risk Analysis
### Technical Risks
| Risk | Probability | Impact | Mitigation | Owner |
|------|------------|--------|------------|-------|
| Transactional rotation breaks issue #34 concurrent-refresh | M | H | Row-scoped locks; regression-test both-succeed | builder |
| Reserved-address rejection leaks an oracle (wrong status/message) | M | H | Reuse the exact existing 409 call; assert indistinguishability in test | builder |
| Blind backfill promotes a hijacked system row | M | H | Conditional predicate (`password_hash='nologin'` + `source`); inspect-before-apply runbook | builder + operator |
| Admin bootstrap deadlock (reserved reg + boot assertion) | M | H | Bootstrap script; runbook ordering migration→bootstrap→deploy; assertion prod-only | builder + operator |
| Config-cache memo defeats short-secret test | L | M | Exported cache-reset hook | builder |
| Reuse-detection defeated by sweep deleting rotated rows | M | M | Sweep keys on natural `expires_at`; retain post-grace unexpired rotated rows | builder |
| Session-version JWT claim breaks pre-existing tokens | L | M | Treat missing claim as version 0 (additive) | builder |
| Adding schema columns breaks hand-DDL pglite suites (`token-grace`, `attribution-schema`, `schema.test`) | H | M | Same-commit DDL/fixture sync is a Phase 3 deliverable | builder |
| `db.transaction()` non-atomic because helpers close over global `db` | H | H | Thread an `exec`/`tx` executor param through all rotation/reset helpers (Phase 2 + 7 deliverables) | builder |
| Startup assertion fires during `next build` (CI/deploy build fails on unreachable `.env.ci` DB) | M | H | Add `NEXT_PHASE !== 'phase-production-build'` guard; verify with real build | builder |
| Admin bootstrap can't log in (no bcrypt hash) | M | H | `grant-admin.ts` creates the account WITH a bcrypt `password_hash`; register-then-flag removed | builder |
| System lazy-create fails on occupied (hijacked) email, silent misroute/loop | M | H | Fail fast with operator log; inspect-before-apply runbook precondition | builder + operator |
| Anti-oracle reopened by check placement after strength check | M | H | Place reserved-address check before the strength check, adjacent to the existing 409 | builder |

### Schedule Risks
| Risk | Probability | Impact | Mitigation | Owner |
|------|------------|--------|------------|-------|
| Scope creep into deferred items (rate limiting, spend caps) | M | M | Enforce the spec's explicit out-of-scope list at review | builder + architect |

## Validation Checkpoints
1. **After Phase 2**: no direct `process.env.JWT_SECRET` remains in auth routes (grep test); flows unchanged.
2. **After Phase 3**: migration SQL reviewed (no destructive statements, no `db:push`); backfill is legitimacy-checked.
3. **After Phase 5**: registration is not an oracle for admin OR system addresses (uniform 409).
4. **After Phase 7**: password reset reliably kills sessions on both paths; reuse detected.
5. **Before PR**: full `npm run typecheck && npm test && npm run build` green from `backend/`; deploy runbook present.

## Monitoring and Observability
### Metrics / Logging
- Log detected rotated-token reuse at `warn` (no user content, no raw/unhashed token, hashed identifiers only).
- Log the startup admin-assertion outcome (pass/fail) at boot.
- Log registration failures server-side with detail (client gets generic message).

### Alerting
- (Operator's discretion) alert on repeated rotated-token-reuse warnings (possible token theft) and on boot-time admin-assertion failure.

## Documentation Updates Required
- [ ] **Deploy runbook (architect-pinned ordering)**: **(1) apply migration `0003_*` → (2) run admin bootstrap (`scripts/grant-admin.ts`) so every `ADMIN_EMAILS` account exists with `is_admin=true` → (3) deploy** (production boot asserts admin existence and fails fast otherwise). Include the **inspect-before-apply** step: before applying, check whether any `@system.ansari.chat` / admin email is already registered with a real password hash (a hijacked row) and remediate manually.
- [ ] `.env.example` / `docs/self-hosting.md`: document any new config (reserved system addresses) and the `ADMIN_EMAILS` → `is_admin` relationship (allowlist reserves + asserts; the DB flag authorizes).
- [ ] `backend/CLAUDE.md` / `AGENTS.md`: note the admin bootstrap + migration-first deploy ordering if it belongs there.
- [ ] Update spec/plan/review status at the end.

## Post-Implementation Tasks
- [ ] Confirm the generated migration is committed but **not** applied by CI (human applies at deploy).
- [ ] Security spot-check: attempt the original attacks (register admin/system address, cross-user feedback, post-logout refresh, reset-vs-refresh race) against the built app.

## Expert Review
**Date**: 2026-08-02 (porch 3-way verify — plan iteration 1)
**Models**: Gemini Pro **APPROVE**; GPT-5 Codex **REQUEST_CHANGES**; Claude **REQUEST_CHANGES** (both HIGH confidence, code-grounded).
**Key Feedback & Plan Adjustments** (all accepted; details in `codev/projects/4-.../4-plan-iter1-rebuttals.md`):
- **Tx executor threading** (codex, claude): `db.transaction()` is a no-op unless inner helpers use the `tx` handle → introduced an `Executor` param in Phase 2 (`issueTokenPair`/`storeToken`) and threaded it through `markTokenRotated`/`findToken`/`deleteUserTokens`/`updateUser` in Phase 7.
- **Phase 3 not "schema-only safe"** (claude): adding columns breaks the hand-DDL pglite suites (`token-grace`, `attribution-schema`, `schema.test`) and `User`-literal fixtures → made the DDL/fixture sync a same-commit Phase 3 deliverable; dropped the new-migrator harness in favor of the repo's hand-DDL pattern.
- **Session-version race** (codex): capture the version at refresh-auth time and pass it into transactional issuance (equality check, missing=0); don't re-fetch after the reset increment → Phase 7.
- **Admin bootstrap** (codex, claude): must create the account WITH a bcrypt hash (admin UI logs in); removed "register-then-flag"; concrete `npx tsx scripts/grant-admin.ts <email>`, idempotent, password not via CLI arg → Phase 4.
- **Startup assertion during `next build`** (claude): added `NEXT_PHASE !== 'phase-production-build'` guard → Phase 4.
- **System lazy-create on occupied email** (codex, claude): unique conflict is on `email`, not `system_key` → explicit fail-fast with operator log + inspect-before-apply precondition; defined the created row's email → Phase 5.
- **Anti-oracle placement** (claude): reserved-address check must precede the password-strength check (adjacent to the existing 409) → Phase 4/5.
- **Logout 401 contract** (codex, claude): keep the existing 401 on no/invalid token; don't change to success/no-op → Phase 6.
- **Phase 9 inverts a green test** (claude): explicitly rewrite `token-grace.test.ts:~147` → Phase 9.
- **Resolve the two open choices** (codex, claude): closed both — opportunistic sweep, reject+log reuse → Phase 7/9 + Notes.

## Approval
- [ ] Technical Lead Review
- [ ] Engineering Manager Approval
- [ ] Resource Allocation Confirmed
- [ ] Expert AI Consultation Complete

## Change Log
| Date | Change | Reason | Author |
|------|--------|--------|--------|
| 2026-08-02 | Initial plan | Decompose approved spec into 9 phases | builder spir-4 |
| 2026-08-02 | Plan iter-1 review revisions | Address codex/claude REQUEST_CHANGES: tx-executor threading, Phase 3 hand-DDL sync, session-version race capture, executable admin bootstrap, build-phase startup guard, system lazy-create fail-fast, anti-oracle placement, logout 401, Phase 9 test rewrite, closed 2 open choices | builder spir-4 |

## Notes
- **PR strategy**: all nine phase-commits ship in **one PR**, opened during/after Phase 9 — not one PR per phase. The architect may request an earlier/interim PR; only then do we open one early.
- **Phase ↔ issue-item map**: P1+P2 = item 6; P3 = schema foundation for items 1/2/5; P4 = item 1; P5 = item 2; P6 = item 3; P7 = item 5; P8 = item 4; P9 = item 7.
- **Deferred / out of scope** (do NOT implement): rate limiting, spend caps, message-size caps, mcp-complete auth, `x-forwarded-for`, CORS, disconnect cancellation.
- **The two previously-open design choices are now CLOSED** (resolved in this plan iteration per reviewer guidance): (1) `deleteExpiredTokens` trigger = **opportunistic low-probability non-blocking sweep** (no cron; `railway.toml` has none); (2) rotated-reuse response = **reject + log only** (no `session_version` bump on reuse; revoke-on-reuse noted as a future option).
- Every phase ends with a green `npm run typecheck && npm test && npm run build` from `backend/` and a single atomic commit before the next phase begins.
