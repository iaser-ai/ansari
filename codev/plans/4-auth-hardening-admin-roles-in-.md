# Plan: Auth Hardening — Durable Admin Roles, System-Account Reservation, Session-Revocation & Config-Validation Fixes

## Metadata
- **ID**: plan-2026-08-02-auth-hardening
- **Status**: draft
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
- Replace the ~4 duplicated generate-and-store blocks with one `issueTokenPair(userId)` helper that reads expiries from `config.auth` and stores hashed access + refresh tokens.

#### Deliverables
- [ ] New helper `issueTokenPair(userId: string)` (in `lib/db/users.ts` alongside token storage, or a new `lib/auth/token-pair.ts`) returning `{ accessToken, refreshToken }`, using `generateToken` + `storeToken` and `config.auth` expiries.
- [ ] Migrate `v2/users/register`, `v2/users/login`, `v2/users/refresh_token`, `v2/request_password_reset` (reset-token issuance stays its own single-token path if it differs) to call the helper; remove their inline `process.env.JWT_SECRET!` / `parseInt(...)` blocks.
- [ ] Tests: `issueTokenPair` unit (returns two valid, correctly-typed, stored tokens); each migrated route still issues working tokens; a **repo-wide assertion test** that greps the auth routes for `process.env.JWT_SECRET` and fails if any remain.

#### Implementation Details
- Preserve exact response shapes each route returns today (e.g. register's `{ status: 'success', ... }`) — this is a pure internal refactor, no wire change.
- `refresh_token` still performs rotation/mark-rotated around the issuance; only the generate-and-store block is replaced (rotation atomicity is Phase 7).

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
- Add the three durable, server-controlled columns in **one reviewable migration**, with a legitimacy-checked backfill for existing system rows.

#### Deliverables
- [ ] `db/schema/users.ts`: add
  - `isAdmin: boolean('is_admin').notNull().default(false)`
  - `systemKey: text('system_key')` with a **unique** index (nullable; non-null only on system rows)
  - `sessionVersion: integer('session_version').notNull().default(0)`
- [ ] `npm run db:generate` → produces `drizzle/0003_*.sql` (+ meta snapshot, `_journal.json`). **Review the SQL. Do NOT `db:push`.**
- [ ] Append/author the **conditional backfill** in the migration (or a clearly-named companion statement, applied together):
  `UPDATE users SET system_key = 'ai-skill'    WHERE email = 'ai-skill@system.ansari.chat'    AND password_hash = 'nologin' AND source = 'ai-skill';`
  `UPDATE users SET system_key = 'leaderboard' WHERE email = 'leaderboard@system.ansari.chat' AND password_hash = 'nologin' AND source = 'leaderboard';`
- [ ] Tests: apply migration on pglite; assert the three columns + unique index on `system_key` exist; assert the backfill marks a legit (`password_hash='nologin'`) row and **does not** mark a hijacked (real-hash) row.

#### Implementation Details
- Unique index on `system_key` must permit multiple NULLs (Postgres unique indexes treat NULLs as distinct — default behavior; verify the generated DDL does not use `NULLS NOT DISTINCT`).
- No application code reads the new columns in this phase — it is schema-only, so it is safe to land before the feature phases. Existing rows get `is_admin=false`, `session_version=0`, `system_key=NULL` via defaults.

#### Acceptance Criteria
- [ ] Migration applies cleanly on a fresh pglite DB; columns/index present; backfill predicate is legitimacy-checked.
- [ ] `typecheck` passes with the new `$inferSelect` types.

#### Test Plan
- **Unit/Integration** (pglite): migration-apply test; backfill legit-vs-hijacked assertions.
- **Manual**: read the generated SQL diff; confirm no destructive statements, no `db:push`.

#### Rollback Strategy
The migration is additive (new nullable/defaulted columns). Rollback = a follow-up migration dropping the columns; not expected. Revert the schema commit before the human applies it if needed.

#### Risks
- **Risk**: a system email is already hijacked, so the legit row doesn't exist and backfill marks nothing → the endpoint later provisions a fresh system row (Phase 5) but the email is taken (unique). **Mitigation**: Phase 5 resolves system identity by `system_key`, not email; the runbook's inspect-before-apply step surfaces a hijacked row for manual remediation before deploy.

---

### Phase 4: Durable admin authorization + reserved-address reservation + startup assertion + bootstrap
**Dependencies**: Phase 3 (`is_admin`), Phase 1 (config)

#### Objectives
- Gate admin on `users.is_admin`; reserve admin addresses at registration (anti-oracle 409); assert admin existence at production boot; provide a bootstrap path.

#### Deliverables
- [ ] `lib/auth/admin.ts`: `requireAdmin` grants iff `authResult.user.isAdmin === true` (DB flag). `isAdmin(email)` is removed or repurposed as `isReservedAdminAddress(email)` (see below). `/api/v2/admin/stats` is unaffected structurally.
- [ ] Reserved-address check (shared helper, e.g. `lib/auth/reserved.ts` `isReservedAddress(normalizedEmail)`): returns true for any configured admin address (`config.admin.emails`). `v2/users/register` calls it on the normalized (lowercased) email and, on match, returns **exactly** `createErrorResponse('An account with this email already exists', 409)` — identical to the existing conflict branch. (Phase 5 extends this helper to system addresses.)
- [ ] Production startup assertion in `src/instrumentation.ts` `register()`: when `NODE_ENV==='production'` and `NEXT_RUNTIME==='nodejs'`, assert every `config.admin.emails` address has a matching user row with `is_admin=true`; throw (fail-fast) otherwise. Gated off in dev/test/CI.
- [ ] `scripts/grant-admin.ts` (Typer-free Node/ts script): given an email, create-or-flag — set `is_admin=true` on the existing user, or document the register-then-flag ordering. This is the sole path to create the first admin (reserved-address registration being blocked).
- [ ] Tests: (a) account whose email ∈ allowlist but `is_admin=false` → `/admin/stats` 403; (b) `is_admin=true` → 200; (c) registering a reserved admin address → **byte-identical** 409 as the existing conflict (assert message + status); (d) startup assertion throws in prod-sim when admin row missing, no-ops in test; (e) bootstrap script sets the flag.

#### Implementation Details
- **Anti-oracle (architect-pinned)**: the reserved-address branch MUST reuse the same `createErrorResponse('An account with this email already exists', 409)` call — same string, same status, same body shape — as line 36. A test asserts the two responses are indistinguishable.
- The startup DB query couples prod boot to DB reachability (accepted fail-fast); log a clear message on assertion failure (no user content).

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
- [ ] `lib/db/users.ts`: `findSystemUser(systemKey: 'ai-skill' | 'leaderboard')` (lookup by `system_key`) and idempotent `getOrCreateSystemUser(systemKey)` that creates a row with `system_key` set and a non-conflicting identity (e.g. `passwordHash='nologin'`, `source=systemKey`); relies on the unique `system_key` index for concurrent-safety.
- [ ] `v2/mcp-complete/route.ts` and `v1/chat/completions/route.ts`: replace `findUserByEmail(SYSTEM_USER_EMAIL) || createUser(...)` with `getOrCreateSystemUser('ai-skill' | 'leaderboard')`. Keep the module-level id cache.
- [ ] Extend the shared reserved-address helper (Phase 4) to also match the configured system domain (`@system.ansari.chat`) / configured system addresses; `register` returns the **identical** 409 on match.
- [ ] Config: add the system-address/domain source (a `config.system` getter or a constant list) so reservation and lookup share one source of truth.
- [ ] Tests: (a) registering `ai-skill@system.ansari.chat` / `leaderboard@system.ansari.chat` / arbitrary `@system.ansari.chat` → identical 409; (b) `findSystemUser('ai-skill')` and `('leaderboard')` each resolve the correct row; (c) a pre-registered look-alike (no `system_key`) is **not** returned by `findSystemUser`.

#### Implementation Details
- System identity is fully decoupled from email: lookup is by `system_key`. Existing legit rows were marked by Phase 3's backfill; new deploys create them lazily by key.
- Concurrent provisioning: rely on the unique index; on insert conflict, re-read by `system_key`.

#### Acceptance Criteria
- [ ] No system endpoint resolves its identity by email.
- [ ] System-domain registration is indistinguishable from an existing-account conflict.

#### Test Plan
- **Integration**: system-address registration oracle-uniformity; system lookup-by-key for both identities; hijack-attempt not resolved.
- **Unit**: `getOrCreateSystemUser` idempotency (simulate existing row).

#### Rollback Strategy
Revert commit → endpoints revert to email lookup. (Do not revert Phase 3 columns.)

#### Risks
- **Risk**: an already-hijacked system email blocks lazy creation (unique email). **Mitigation**: identity is `system_key`, not email; runbook inspect-before-apply flags the hijacked row for manual cleanup.

---

### Phase 6: Logout — full session revocation
**Dependencies**: Phase 1 (middleware/config) — otherwise standalone

#### Objectives
- Make logout reliably end the session by revoking all of the user's tokens.

#### Deliverables
- [ ] `v2/users/logout/route.ts`: resolve the user from the access token (via `authenticateRequest`/`verifyToken`) and call `deleteUserTokens(user.id)` (full, all-device logout) instead of `deleteToken(accessToken)`.
- [ ] Tests: after logout, the user's refresh token is rejected by `refresh_token`; the access token is rejected by an authenticated endpoint.

#### Implementation Details
- Full logout is the pinned decision (spec Desired State #3): the request carries only the bearer access token and there's no per-device session grouping. Update the existing logout test (`refresh-token-route.test.ts` currently asserts single-token deletion) to the new contract.

#### Acceptance Criteria
- [ ] Post-logout refresh token is rejected; the all-device behavior is covered by a test and documented.

#### Test Plan
- **Integration**: login → logout → refresh (expect reject) and authed request (expect 401).

#### Rollback Strategy
Revert commit → logout reverts to access-token-only deletion.

#### Risks
- **Risk**: unauthenticated logout (no/invalid token) now needs graceful handling. **Mitigation**: return the existing success/no-op shape without throwing; test the no-token path.

---

### Phase 7: Atomic rotation + session version + reliable reset kill + reuse detection
**Dependencies**: Phase 2 (`issueTokenPair`), Phase 3 (`session_version`)

#### Objectives
- Make refresh rotation atomic; bump `session_version` on password reset; check it on **every** token validation (access + refresh); retain rotated rows until natural expiry so rotated-token reuse is detected.

#### Deliverables
- [ ] `lib/db/users.ts`: wrap validate → mark-rotated → issue-pair in a **DB transaction** (`db.transaction(...)`), row-scoped so concurrent unrelated requests aren't serialized. Preserve issue #34 concurrent-refresh-both-succeed within the 60s grace.
- [ ] Session version: embed the issuing `session_version` in the token payload (extend `generateToken`/`issueTokenPair`); `authenticateRequest` and `validateRefreshToken` reject when the token's version < the user's current `session_version`. The version compare piggybacks on the existing `findToken` `innerJoin users` (no extra query).
- [ ] `v2/reset_password/route.ts`: inside the reset transaction, bump `users.session_version` (increment) in addition to `deleteUserTokens(user.id)`, so a token minted by a racing refresh just before revocation is invalidated by the version bump even if its row survives.
- [ ] Rotated-token reuse: `findToken` distinguishes (a) valid, (b) rotated-within-grace (accept), (c) rotated-past-grace (retained row → **detected reuse**: reject + log), (d) unknown hash (forged: reject). Log detected reuse (no user content, no raw token). *(Open: whether detection also bumps `session_version` to kill the session — default reject+log; decide in review.)*
- [ ] Tests: reset-vs-refresh interleavings (both orderings) prove no post-reset-valid pair survives; session-version invalidates a pre-reset access token on the access path; rotated-token replay past grace is detected; in-grace concurrent refresh still both succeed.

#### Implementation Details
- The retention rule lives with the sweep (Phase 9): `deleteExpiredTokens` deletes only rows past natural `expires_at`, never merely past grace — this is what keeps a rotated row available for reuse detection. State this dependency explicitly; if Phase 9 lands after Phase 7, the retention is already the default (nothing sweeps yet).
- Embedding `session_version` in the JWT keeps the access-path check to a comparison against the joined user row.

#### Acceptance Criteria
- [ ] Rotation is transactional and preserves concurrent-refresh semantics.
- [ ] Password reset reliably kills sessions on both token paths (version-checked).
- [ ] Rotated-token reuse past grace is detected and logged.

#### Test Plan
- **Integration (pglite)**: interleaved reset/refresh; reuse-detection; grace-window concurrency; access-path version rejection.
- **Unit**: `findToken` state machine (valid / in-grace / past-grace-reuse / unknown).

#### Rollback Strategy
Revert commit → rotation reverts to non-transactional soft-mark; session_version column remains unused (harmless).

#### Risks
- **Risk**: transaction serialization regresses refresh throughput. **Mitigation**: row-scoped locking only; regression-test concurrent refresh.
- **Risk**: embedding version in the JWT changes token payload. **Mitigation**: additive claim; `verifyToken` tolerates its presence/absence (treat missing as version 0 for pre-existing tokens).

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
- [ ] Wire `deleteExpiredTokens`: default to an **opportunistic sweep** (probabilistic invocation on token operations) OR a Railway cron — *decide with the operator*. Adjust its predicate so it deletes only tokens past natural `expires_at` (retaining post-grace rotated rows for reuse detection, per Phase 7).
- [ ] Tests: timing-safe compare correctness (match / mismatch / length-mismatch); `aaaaaaaa` rejected (score 3), 129-char rejected, strong accepted; register returns generic error (detail not in body); sweep deletes expired but retains post-grace non-expired rotated rows.

#### Implementation Details
- `deleteExpiredTokens` trigger mechanism is an open design choice (spec Open Questions): opportunistic needs no infra; cron is deterministic. Pick in consultation/with operator; either way honor the retention rule.
- Constant-time compare must handle the unconfigured-key path (existing 503) unchanged.

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
- **New services**: none. Optional Railway cron if the operator prefers cron over opportunistic sweep for `deleteExpiredTokens`.
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
| Reuse-detection defeated by sweep deleting rotated rows | M | M | Sweep keys on natural `expires_at`; retain post-grace rotated rows | builder |
| Session-version JWT claim breaks pre-existing tokens | L | M | Treat missing claim as version 0 (additive) | builder |

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
**Date**: (pending — porch 3-way verify for the plan)
**Model**: GPT-5 Codex, Gemini Pro, Claude
**Key Feedback**: (to be filled after consultation)
**Plan Adjustments**: (to be filled)

## Approval
- [ ] Technical Lead Review
- [ ] Engineering Manager Approval
- [ ] Resource Allocation Confirmed
- [ ] Expert AI Consultation Complete

## Change Log
| Date | Change | Reason | Author |
|------|--------|--------|--------|
| 2026-08-02 | Initial plan | Decompose approved spec into 9 phases | builder spir-4 |

## Notes
- **PR strategy**: all nine phase-commits ship in **one PR**, opened during/after Phase 9 — not one PR per phase. The architect may request an earlier/interim PR; only then do we open one early.
- **Phase ↔ issue-item map**: P1+P2 = item 6; P3 = schema foundation for items 1/2/5; P4 = item 1; P5 = item 2; P6 = item 3; P7 = item 5; P8 = item 4; P9 = item 7.
- **Deferred / out of scope** (do NOT implement): rate limiting, spend caps, message-size caps, mcp-complete auth, `x-forwarded-for`, CORS, disconnect cancellation.
- **Two design choices deliberately open** (resolve in implementation/consultation, not with the architect): `deleteExpiredTokens` trigger (opportunistic vs cron); whether rotated-reuse detection also bumps `session_version` to revoke the session.
- Every phase ends with a green `npm run typecheck && npm test && npm run build` from `backend/` and a single atomic commit before the next phase begins.
