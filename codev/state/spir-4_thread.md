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
- Phase 3 iter1: unanimous APPROVE. Committed (e69ebad).

## 2026-08-02 — Implement Phase 4 (durable admin authz + reservation + startup + bootstrap)
- admin.ts: requireAdmin now gates on `user.isAdmin` (removed email-based isAdmin()).
- reserved.ts (new): isReservedAddress(normalizedEmail) → config.admin.emails (Phase 5 extends).
- register: fold reserved check into the existing 409 branch, BEFORE the strength check
  (architect anti-oracle: `existingUser || isReservedAddress(email.toLowerCase())` → identical
  409). Placement test proves reserved+weak-pw still returns 409 (not 400).
- startup-checks.ts (new): assertConfiguredAdminsExist() (throws if a configured admin is
  missing/unflagged) + shouldRunAdminStartupCheck() gate (prod + nodejs + NEXT_PHASE !=
  phase-production-build). Wired into instrumentation.ts register() (dynamic import).
- scripts/grant-admin.ts (new): create-or-flag with real bcrypt hash; idempotent; password
  via GRANT_ADMIN_PASSWORD env / prompt (never CLI arg); CLI guarded so imports don't run main.
- Tests: rewrote admin-auth.test.ts (flag-based, incl. admin-looking email w/ isAdmin=false →
  403); reserved.test.ts; startup-checks.test.ts (throw/pass/gating incl. build-phase skip);
  grant-admin.test.ts (pglite: create w/ bcrypt, idempotent flag, lowercase, min-len);
  register reserved cases (identical 409, case-insensitive, weak-pw placement guard).
- Result: typecheck clean; **513 passed, 3 skipped**; build green (startup check correctly
  skipped at build via NEXT_PHASE guard).
- Phase 4 iter1: Gemini+Claude APPROVE, **Codex REQUEST_CHANGES** — sharp catch: grant-admin
  blindly flagged an existing account while PRESERVING its password → could hand admin to an
  attacker who pre-registered the address (the very vuln being fixed), and could "succeed" on
  an unusable nologin hash. → Fix: password now ALWAYS required and SET on both create and
  promote; promotion resets the password (operator takes credential control, locks out
  pre-registrant, guarantees login-capable). Test now verifies real password auth: operator
  pw authenticates, attacker pw does not; + refuses promote without password. 514 passed.
- Phase 4 iter2: **Codex + Claude REQUEST_CHANGES** (same blocker) — password reset alone
  does NOT revoke the pre-registrant's EXISTING tokens; their 90-day refresh token survives
  promotion and resolves to the now-admin row → admin access. → Fix: promote branch now calls
  deleteUserTokens(existing.id) (precedent: reset_password). Test seeds a refresh token,
  asserts it's gone after promote. Also (Codex): startup-checks logged the admin email
  (plan: no user content) → report by index #N of M, not the address; + graceful DB-unreachable
  message (Claude/Codex non-blocking). Docs: fixed docs/self-hosting.md ADMIN_EMAILS
  (reserve+assert, not grant) + added admin-provisioning runbook. readline echo comment.
  Result: **517 passed, 3 skipped**; build green.
- Phase 4 iter3: Gemini+Claude APPROVE, **Codex REQUEST_CHANGES** — (1) promote+deleteTokens
  were separate statements (race: refresh can mint tokens between); (2) plan wants route-level
  /admin/stats integration test (existing one mocks requireAdmin). → Fix: promote now in ONE
  db.transaction (set is_admin+password+`session_version+1`+delete tokens); test asserts
  session_version bumped to 1 + tokens gone. Added admin-stats-authz.test.ts exercising REAL
  requireAdmin: is_admin=false→403, true→200, unauth→401. session_version bump is forward-compat
  (Phase 7 enforces). Result: **520 passed, 3 skipped**; build green.
- **porch has a 3-ITERATION SAFETY CEILING**: after iter3, porch force-advanced Phase 4
  (commit "force-advance (safety ceiling reached at iter 3)") to phase_5. My Phase 4 code
  IS committed (porch chore commits absorbed my staged files; verified grant-admin tx +
  session_version + admin.ts flag in HEAD). All Codex/Claude blockers were addressed in my
  iter3 fixes, so the committed state is fully corrected. Phase 4 ✓.
  NOTE: porch also pre-marked phase_5 "build-complete" on the phase_4 tree — I must implement
  phase_5, re-run porch done to re-validate, THEN consult.

## 2026-08-02 — Implement Phase 5 (system-account reservation via system_key)
- system-accounts.ts (new): SYSTEM_EMAIL_DOMAIN + SYSTEM_ACCOUNTS registry (ai-skill,
  leaderboard) + isSystemAddress() — single source of truth.
- users.ts: findSystemUser(key) (lookup by system_key), getOrCreateSystemUser(key) (lazy
  create w/ system_key + nologin + canonical email; on unique conflict re-read by key for
  race, else FAIL FAST — email held by non-system/hijacked row).
- reserved.ts: now normalizes internally + reserves the @system.ansari.chat domain
  (addresses Claude's Phase 4 note). register call unchanged (still passes lowercased; helper
  double-normalizes).
- mcp-complete + v1/chat/completions: getSystemUserId now uses getOrCreateSystemUser (by key),
  removed email-based findUserByEmail||createUser. Kept SOURCE_TAG (used elsewhere in v1).
- Tests: reserved.test.ts (admin + system domain + case-insensitive); system-user.test.ts
  (create-by-key, idempotent, two distinct identities, look-alike NOT resolved + fail-fast);
  updated mcp-complete + openai-compat mocks to getOrCreateSystemUser; register system-address
  409 case. Result: typecheck clean; **526 passed, 3 skipped**; build green.
- NOTE: porch pre-marked phase_5 build-complete on the phase_4 tree (force-advance artifact);
  re-running porch done to re-validate against the real phase_5 tree, then consult.
- Phase 5 iter1: Gemini+Claude APPROVE, **Codex REQUEST_CHANGES** — (1) catch-all in
  getOrCreateSystemUser reported "occupied email" for ANY insert failure (outage/schema
  would be misreported); (2) endpoint tests didn't assert the endpoint→identity key mapping.
  → Fix: added isUniqueViolation() (walks .cause chain — drizzle wraps the driver 23505);
  only 23505 → interpret (race re-read / occupied-email), else rethrow raw. Tests:
  isUniqueViolation unit (top-level + cause-nested 23505; other codes false); DROP-table
  non-unique propagation test (not masked as "already held"); mcp asserts
  getOrCreateSystemUser('ai-skill'), openai-compat asserts ('leaderboard').
  Result: **530 passed, 3 skipped**; build green.
- Phase 5 iter2: unanimous APPROVE. Committed (541c612).

## 2026-08-02 — Implement Phase 6 (logout: full session revocation)
- logout route: now authenticateRequest (401 for no/invalid/wrong-type/unknown token —
  preserves contract) → deleteUserTokens(user.id) full all-device logout. Dropped the
  single-token deleteToken path.
- Tests: new logout-route.test.ts (valid→deleteUserTokens(user.id)+200; no-token→401 no
  revoke; invalid→401 no revoke). Removed the obsolete deleteToken-based logout test from
  refresh-token-route.test.ts (kept its deleteToken mock — refresh "not called" assertion
  still uses it). Result: typecheck clean; **532 passed, 3 skipped**; build green.
- Phase 6 iter1: Gemini APPROVE, Codex REQUEST_CHANGES, Claude COMMENT (same point):
  logout-route test mocks deleteUserTokens → proves the route CALLS it but not that a
  post-logout refresh token is actually rejected; deleteUserTokens had zero DB coverage.
  → Added DB-level (pglite) test in token-grace.test.ts: deleteUserTokens revokes both
  access+refresh (findToken misses both) + user-scoping (other user's token survives).
  Fixed stale comments (refresh-token-route header, token-grace :127). **534 passed**.
  **PR-BODY RESIDUALS to document** (plan-conformant, not defects): (a) logout now returns
  401 for an unrecognized bearer (was 200) — client-visible tightening; (b) an EXPIRED access
  token → 401, so its 90-day refresh token can't be revoked (future POST /logout {refresh_token}
  would close it); (c) logout no longer idempotent (2nd call → 401); (d) deleteToken now
  production-dead (removal candidate at PR cleanup).
- Phase 6 iter2: unanimous APPROVE. Committed (412ee9a).

## 2026-08-02 — Implement Phase 7 (atomic rotation + session version + reset kill + reuse)
- jwt.ts: generateToken embeds session_version (5th param); TokenPayload adds optional field.
- users.ts: issueTokenPair(userId, sessionVersion, exec) — embeds CAPTURED version (not re-read);
  markTokenRotated/deleteUserTokens/updateUser gain exec param; bumpSessionVersion() (sql +1);
  lookupRefreshToken() classifies valid / in-grace-valid / reuse (past-grace retained) / not_found.
- middleware.ts: authenticateRequest + validateRefreshToken check (payload.session_version ?? 0)
  != user.sessionVersion -> 401 'Session no longer valid'. validateRefreshToken uses
  lookupRefreshToken -> returns {user}|{reuse}|{error}.
- refresh route: db.transaction(markTokenRotated(tx) + issueTokenPair(captured version, tx));
  reuse -> generic 401 + console.warn (no user content). Captured version from validateRefreshToken.
- reset_password: db.transaction(updateUser(tx) + bumpSessionVersion(tx) + deleteUserTokens(tx)).
- login/register: issueTokenPair(user.id, user.sessionVersion). request_reset: generateToken +version.
- DECISION (from plan): reuse = reject + log only, no session bump on reuse.
- Tests: fixed 4 suites for the signature/return changes (added db/index tx mock + sessionVersion
  to user fixtures + bumpSessionVersion mock). NEW session-version-reuse.test.ts (pglite + real
  middleware): lookupRefreshToken 5 states, bumpSessionVersion, reset-vs-refresh interleaving
  (post-reset-issued stale-version token -> 401), reuse end-to-end. middleware stale-version +
  reuse cases; issueTokenPair embeds-version case. Result: typecheck clean; **549 passed, 3
  skipped**; build green. pglite = single connection -> races tested as deterministic sequences.
- Phase 7 iter1: Gemini APPROVE, Codex+Claude REQUEST_CHANGES. Codex found a real race:
  concurrent LOGOUT deletes tokens but (Phase 6) did NOT bump session_version, so a racing
  refresh mints a valid pair surviving logout. → Fix (root cause): **logout now bumps
  session_version** in its transaction (deleteUserTokens + bumpSessionVersion) — same uniform
  mechanism as reset; racing-refresh tokens carry stale version -> rejected. Both reviewers:
  tests mocked db.transaction away, so atomicity/both-orderings unproven. → Added REAL-DB
  (pglite) tests in session-version-reuse.test.ts: executor-threading ROLLBACK (tx throws ->
  rotation+issuance undone; proves exec threading), real reset transaction (pw+version+revoke
  together), reverse ordering (refresh commits first -> reset kills), logout-vs-refresh race
  (fix verified), missing-claim=version-0 (legacy token). Updated logout-route.test.ts.
  deleteExpiredTokens retention flip correctly deferred to Phase 9 (both agree). Result:
  **554 passed, 3 skipped**; build green.
- Phase 7 iter2: Gemini+Claude APPROVE, **Codex REQUEST_CHANGES** — deeper atomicity: (1)
  refresh validation outside tx; (2) reset-token double-consumption (findToken outside tx →
  two concurrent resets could both succeed = TOCTOU on one-time token). → Fixes: (1) refresh
  now RE-CONFIRMS via lookupRefreshToken(tx) INSIDE the transaction — revoked-between-validate-
  and-mint → not_found → don't issue; in-grace still 'valid' (issue #34 preserved); issues with
  in-tx-read version. (2) reset now ATOMICALLY CONSUMES the token: deleteToken(reset_token, tx)
  first, abort(400) if false — DELETE..RETURNING gives the row to exactly one concurrent caller.
  Added exec to deleteToken. Tests: refresh concurrent-revoke (recheck not_found → 401 no issue);
  reset double-consume (deleteToken false → 400, no pw change); real-DB reset-token single-use
  (deleteToken true then false); stale pair rejects BOTH access AND refresh. Result: **558
  passed, 3 skipped**; build green.


- Phase 7 iter3: unanimous APPROVE. Committed (4f39024).

## 2026-08-02 - Implement Phase 8 (feedback IDOR + oracle uniformity)
- threads.ts: findMessageInOwnedThread(messageId, threadId, userId) - single owner-scoped
  join (messages join threads WHERE threads.user_id = userId). Returns undefined for
  nonexistent / foreign-owned / mismatched alike.
- feedback route: uses it -> uniform 404 'Message not found' for all failure modes (no oracle).
- Tests: feedback.test.ts (mock swap + owner-scoped call assertion + cross-user 404 no-create
  + oracle-uniformity: nonexistent/foreign/mismatched all identical 404 body). feedback-idor.test.ts
  (pglite, REAL join: owner resolves; other user undefined; nonexistent/wrong-thread undefined).
  Result: typecheck clean; 565 passed, 3 skipped; build green.
- Phase 8 iter1: unanimous APPROVE. Committed (2775988).

## 2026-08-02 - Implement Phase 9 (smaller hardening) - LAST impl phase
- v1/chat authorize(): timingSafeEqualStr (crypto.timingSafeEqual on equal-length buffers,
  length-check first) replaces plain !== on the leaderboard key.
- password.ts: score >= 3 (was 2); 'aaaaaaaa' now rejected. register+reset schemas: .max(128).
- register catch: generic 'Registration failed' + log detail (no raw driver text leaked).
- deleteExpiredTokens: now deletes ONLY past-natural-expires_at (retains rotated-but-unexpired
  rows for reuse detection). Removed unused isNotNull import. Rewrote token-grace sweep test.
- maybeSweepExpiredTokens(): low-prob (2%) fire-and-forget opportunistic sweep, wired into
  login/register/refresh (no cron). Added to their test mocks.
- Tests: aaaaaaaa reject (auth.test), register .max(128) 422 + generic-error 500 no-leak
  (gotcha: dangling mockReturnValueOnce from placement test -> mockReset), same-length wrong
  leaderboard key 401 (constant-time content compare), sweep retention (token-grace).
  Result: typecheck clean; 569 passed, 3 skipped; build green.
- Phase 9 iter1: Gemini+Claude APPROVE, Codex REQUEST_CHANGES - register catch logged the
  FULL DB error object, which can carry the submitted email/params/hash (violates no-user-
  content-in-logs). -> Fix: safeErrorMeta(error) logs only {name, code(SQLSTATE)}, never the
  message/query/params. Test asserts logs contain neither 'constraint' nor the email. 569 passed.
- Phase 9 iter2: unanimous APPROVE. Committed (f2a4b1b). ALL 9 IMPL PHASES DONE.

## 2026-08-02 - Review phase
- Wrote codev/reviews/4-*.md (full template: spec compliance, deviations, metrics, timelog,
  consultation summary, lessons, arch/lessons updates, tech debt, follow-ups).
- Populated the 4 governance docs (were STARTER placeholders): arch-critical.md (6 durable
  auth invariants + cold map), lessons-critical.md (2 new lessons), arch.md (Authentication &
  Authorization section), lessons-learned.md (Auth hardening spec 4 section). Hot files within cap.
- Next: open PR, run review checks (pr_exists, review_has_arch/lessons_updates, e2e_tests).
- Opened **PR #15** (base develop). Review checks all pass.
- PR-review 3-way: Gemini APPROVE; Codex+Claude REQUEST_CHANGES - both on BRANCH FRESHNESS
  (11 commits behind develop's Open-source-readiness #6: Node 22, eslint ., test:coverage, CI
  gate), not the security engineering (Claude verified the concurrency invariants + config-bypass
  closure as correct). -> Merged origin/develop (self-hosting.md auto-merged clean; develop
  removed the e2e specs); fixed tests/api.test.ts (hand-DDL sync + full config env); finalized
  spec/plan Status; fixed review flaky count; migration index-lock note. Full new gate green:
  lint 0-err, typecheck, test:coverage 583 passed/3 skipped, build. Pushed. Wrote rebuttal.
- `porch done 4` -> **GATE: pr**. Notifying architect. **STOPPED - will NOT merge/self-approve.**

## 2026-08-02 - gitleaks on PR #15
- Renamed the phase-7 dummy JWT fixture. IMPORTANT: the architect's suggested value
  'phase7-test-secret-at-least-32-chars-long-xx' ALSO trips gitleaks generic-api-key
  (the SECRET/jwtSecret identifier + a value lacking the right stopwords). Verified locally
  that 'phase7-testing-secret-for-purposes-only-32chars' passes (has 'testing'/'purposes'/'only').
  Tip is now gitleaks-clean.
- BUT gitleaks scans PR commit history: 4 findings remain in 2 HISTORIC commits:
  d124945 (chore(porch): 4 implement build-complete - old string) and 48699228 (my first
  rename - still-flagged value). Tip fix can't remove them. History rewrite needed.
- Per architect instruction + Waleed's rule: NOT rewriting history. Reported to architect, awaiting decision.
