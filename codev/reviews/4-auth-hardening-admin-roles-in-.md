# Review: Auth Hardening — Durable Admin Roles, System-Account Reservation, Session-Revocation & Config-Validation Fixes

## Summary

Closed the seven authz/authn defects from the 2026-08-02 multi-model review across **9 implementation phases** (foundation-first, then issue-severity order). Admin authorization, system-account identity, session revocation, the feedback IDOR, and JWT-config validation are now grounded in durable, server-controlled state and validated config. Net: **569 tests passing (3 skipped)**, `typecheck`/`test`/`build` green; DB migration generated (not applied — human-applied at deploy).

## Spec Compliance

- [x] AC1: Admin gated on durable `users.is_admin` (not email); allowlisted-email-without-flag denied (Phase 4)
- [x] AC2: Public registration of a configured admin address rejected — identical 409, before the strength check (Phase 4)
- [x] AC3: Production startup assertion that configured admins exist; build-phase-guarded; bootstrap script (Phase 4)
- [x] AC4: System accounts resolved by `system_key`, not email; `@system.ansari.chat` reserved; conditional legitimacy-checked backfill (Phases 3, 5)
- [x] AC5: Logout is a full all-device revocation (`deleteUserTokens`) + session_version bump; refresh token rejected after logout (Phases 6, 7)
- [x] AC6: Feedback owner-scoped (`messages⋈threads WHERE user_id`); uniform 404 for nonexistent/foreign/mismatched — no oracle (Phase 8)
- [x] AC7: Atomic rotation (tx) + per-user `session_version` checked on access & refresh; reliable reset kill; rotated-token reuse detected (Phase 7)
- [x] AC8: All auth paths route the JWT secret/expiries through validated `config`; single `issueTokenPair`; `expiry > 0` bounds (Phases 1, 2)
- [x] AC9: Constant-time leaderboard-key compare; password `score >= 3` + `.max(128)`; generic registration error (detail sanitized in logs); `deleteExpiredTokens` wired opportunistically (Phase 9)
- [x] AC10: `npm run typecheck && npm test && npm run build` green; no coverage reduction; migration generated not pushed

## Deviations from Plan

- **Phase 4**: `grant-admin.ts` evolved across 3 review rounds — from create-or-flag, to always-set-password (never preserve an attacker credential), to a full transaction that also **revokes existing tokens + bumps `session_version`** (closes the pre-registrant session-survival race). Force-advanced at porch's iter-3 ceiling with all reviewer blockers already addressed.
- **Phase 6→7**: logout gained a `session_version` bump in Phase 7 (beyond Phase 6's `deleteUserTokens`) to close the logout-vs-refresh race via the same mechanism as reset.
- **Phase 7**: refresh re-confirms the token *inside* the transaction (not just mark+issue), and reset **atomically consumes** its one-time token via conditional delete — both beyond the plan's letter, in response to Codex's concurrency findings.
- **Phase 5**: `isReservedAddress` normalizes internally (Claude's Phase-4 suggestion folded in here).

## Key Metrics

- **Commits**: 17 `[Spec 4]` commits (63 total on branch incl. porch chores)
- **Tests**: 569 passing (3 skipped) — ~471 baseline + ~98 new
- **Files created**: `lib/auth/reserved.ts`, `lib/auth/startup-checks.ts`, `lib/auth/system-accounts.ts`, `scripts/grant-admin.ts`, `drizzle/0003_lying_dracula.sql`, + 14 test files (`config`, `middleware`, `issue-token-pair`, `auth-config-bypass`, `login-route`, `system-key-backfill`, `reserved`, `startup-checks`, `grant-admin`, `admin-stats-authz`, `system-user`, `logout-route`, `session-version-reuse`, `feedback-idor`)
- **Files deleted**: none (net additive)
- **Schema**: `users` +`is_admin`, +`system_key` (unique), +`session_version`
- **Net LOC impact**: roughly +2.5k source/test (backend), excluding review artifacts

## Timelog

All times local, 2026-08-01 → 2026-08-02.

| Time | Event |
|------|-------|
| 08-01 21:46 | First commit: initial specification draft |
| 08-01 21:54 | **GATE: spec-approval** requested |
| 08-01 23:22 | spec-approval approved (Waleed) |
| 08-01 23:27 | Initial implementation plan |
| 08-01 23:37 | **GATE: plan-approval** requested |
| 08-02 05:51 | plan-approval approved (Waleed) |
| 08-02 06:08 | Phase 1 (config) complete |
| 08-02 06:29 | Phase 3 (schema migration) complete |
| 08-02 07:02 | Phase 4 (admin authz) complete — force-advanced at iter-3 ceiling |
| 08-02 08:05 | Phase 7 (rotation/reset/reuse) complete after 3 iterations |
| 08-02 08:30 | Phase 9 (smaller hardening) complete — all 9 phases done |

### Autonomous Operation

| Period | Duration | Activity |
|--------|----------|----------|
| Spec + Plan | ~1h 50m | Draft + 3-way review + rebuttals (2 gates) |
| Human gate waits | ~7h 40m | Idle — spec-approval (~1.5h) + plan-approval (~6.2h) |
| Implementation → done | ~2h 40m | 9 phases, 20 consultation rounds |

**Total wall clock** (first commit to Phase 9): **~10h 44m**
**Total autonomous work time** (excluding gate waits): **~3h**
**Context window resets**: handled transparently by the harness (work continued across summaries)

## Consultation Iteration Summary

60 consultation files (20 rounds × 3 models). Approximately 40 APPROVE, 18 REQUEST_CHANGES, 1 COMMENT.

| Phase | Iters | Who Blocked | What They Caught |
|-------|-------|-------------|------------------|
| Specify | 1 | Codex, Claude | Reuse-vs-sweep contradiction; system marker needs a key; logout contract; session-version scope |
| Plan | 1 | Codex, Claude | Illusory `db.transaction` (no executor threading); Phase 3 breaks hand-DDL; bootstrap deadlock; build-phase startup guard |
| Phase 1 | 2 | Codex, Claude | Missing middleware-uses-config-secret regression test |
| Phase 2 | 2 | Codex | Missing `issueTokenPair`/config-bypass tests; no login route test |
| Phase 3 | 1 | — | Unanimous approve |
| Phase 4 | 3 | Codex | Bootstrap promotes attacker row → password reset → token revoke + version bump; email in startup log; missing route-level authz test |
| Phase 5 | 2 | Codex | Catch-all masked non-unique DB errors as "occupied email"; endpoint→identity mapping untested |
| Phase 6 | 2 | Codex (RC), Claude (COMMENT) | No DB-level proof that post-logout refresh is rejected |
| Phase 7 | 3 | Codex | logout-vs-refresh race; mocked `db.transaction` hides atomicity; reset-token double-consumption (TOCTOU) |
| Phase 8 | 1 | — | Unanimous approve |
| Phase 9 | 2 | Codex | Register catch logged the full DB error (user content in logs) |
| Review | — | — | (this document) |

**Most frequent blocker**: **Codex** — blocked in ~10 of 11 phase/artifact rounds, focused on: concurrency/atomicity, real-DB (not mocked) verification, and log/error hygiene.

### Avoidable Iterations

1. **Test the composition against a real DB, not just mocks.** Several REQUEST_CHANGES (Phases 6, 7) were "you mocked the thing you claim works." Building pglite integration tests for transactional/atomicity claims up front would have pre-empted them.
2. **Stage new test files so the reviewer's diff includes them.** Phase 1/2 iter-1 blocks were partly "tests missing" when they existed but were untracked — staging before consult would have shown them.
3. **Sanitize error logs from the start.** The Phase 9 register-log leak (and its precedent risk in other routes) was foreseeable from the "no user content" rule.
4. **Anticipate the follow-on of a security fix.** "Reset the password on promote" (Phase 4 iter1) obviously needed "…and revoke the existing sessions" (iter2) — the token still resolved to the now-admin row.

## Consultation Feedback

### Specify Phase (Round 1)
#### Gemini — No concerns raised (APPROVE)
#### Codex
- **Concern**: Reuse-detection vs concurrent-refresh indistinguishable; system marker can't disambiguate two identities; logout has no submitted refresh token; session-version must be checked on both token types.
  - **Addressed**: Defined in-grace/post-grace/forged semantics; unique `system_key`; full `deleteUserTokens` logout; version checked on access + refresh.
#### Claude
- **Concern**: reuse-vs-sweep destroy the same rows; blind backfill promotes a hijacked row; admin bootstrap deadlock; no email-change endpoint exists (factual).
  - **Addressed**: Sweep keys on natural expiry; conditional backfill; documented bootstrap; corrected wording.

### Plan Phase (Round 1)
#### Gemini — APPROVE
#### Codex & Claude
- **Concern**: `db.transaction` is a no-op without executor threading; Phase 3 "schema-only" breaks hand-DDL pglite suites; bootstrap must create a bcrypt-loginable admin; startup assertion fires during `next build`; system lazy-create conflict is on `email` not `system_key`; anti-oracle needs check *placement* before the strength check.
  - **Addressed**: Threaded an `Executor` param through all token helpers; made DDL/fixture sync a Phase 3 deliverable; concrete bootstrap; `NEXT_PHASE` build guard; explicit fail-fast; pinned placement.

### Phase 1 (Rounds 1–2)
#### Gemini — APPROVE
#### Codex & Claude (R1)
- **Concern**: The listed "middleware verifies with `config.auth.jwtSecret`" test was missing; `authenticateRequest` had no direct coverage.
  - **Addressed**: Added `middleware.test.ts` signing real tokens with the config vs a different secret. (R2: all APPROVE.)

### Phase 2 (Rounds 1–2)
#### Gemini, Claude — APPROVE
#### Codex (R1)
- **Concern**: `issueTokenPair`/config-bypass tests not in the diff (untracked); no login-route test.
  - **Addressed**: Staged the tests; added `login-route.test.ts`. (R2: all APPROVE.)

### Phase 3 (Round 1)
- No concerns raised — all consultations approved.

### Phase 4 (Rounds 1–3, force-advanced at ceiling)
#### Gemini — APPROVE
#### Codex (R1→R3)
- **Concern (R1)**: Bootstrap blindly flags an existing account, possibly promoting a pre-registered attacker; may leave an unusable `nologin` admin.
  - **Addressed**: Always set the password on create/promote.
- **Concern (R2)**: Password reset alone doesn't revoke the attacker's existing tokens; startup error logs the admin email.
  - **Addressed**: Promotion revokes all tokens; startup error reports by index, not address; DB-unreachable message.
- **Concern (R3)**: Promotion+revocation not atomic; missing route-level `/admin/stats` authz test.
  - **Addressed**: One transaction (flag + password + `session_version++` + token delete); added `admin-stats-authz.test.ts`.
#### Claude (R2) — REQUEST_CHANGES (token revocation), then APPROVE
- **Concern**: Same token-revocation gap; docs/self-hosting.md misleading.
  - **Addressed**: Revocation added; docs updated with the migration→bootstrap→deploy runbook.

### Phase 5 (Rounds 1–2)
#### Gemini, Claude — APPROVE
#### Codex (R1)
- **Concern**: `getOrCreateSystemUser` treated every insert failure as an occupied email; endpoint→key mapping untested.
  - **Addressed**: `isUniqueViolation` (walks `.cause` — drizzle wraps the driver code) gates the interpretation; rethrow non-unique; asserted `'ai-skill'`/`'leaderboard'` mapping. (R2: all APPROVE.)

### Phase 6 (Rounds 1–2)
#### Gemini — APPROVE
#### Codex (RC) / Claude (COMMENT)
- **Concern**: The logout test mocks `deleteUserTokens`; no DB-level proof a post-logout refresh token is rejected.
  - **Addressed**: pglite test in `token-grace.test.ts` (revokes access+refresh; user-scoped). (R2: all APPROVE.)

### Phase 7 (Rounds 1–3)
#### Gemini — APPROVE
#### Codex & Claude (R1)
- **Concern**: logout-vs-refresh race (logout didn't bump version); atomicity claims rest on mocked `db.transaction`; only one reset ordering tested.
  - **Addressed**: logout bumps `session_version`; real-DB rollback + both-orderings + reuse + missing-claim tests.
#### Codex (R2)
- **Concern**: Refresh validation outside the tx; reset-token double-consumption (TOCTOU).
  - **Addressed**: Refresh re-confirms inside the tx; reset consumes the token via conditional delete (one winner). (R3: all APPROVE.)

### Phase 8 (Round 1)
- No concerns raised — all consultations approved.

### Phase 9 (Rounds 1–2)
#### Gemini, Claude — APPROVE
#### Codex (R1)
- **Concern**: Register catch logged the full DB error (may embed email/params/hash).
  - **Addressed**: `safeErrorMeta` logs only `{name, code}`; test asserts no raw detail/email in logs. (R2: all APPROVE.)

## Lessons Learned

### What Went Well
- **Foundation-first phasing** paid off: consolidating config + `issueTokenPair` and threading an `Executor` param early (Phases 1–2) made the hard concurrency phase (7) tractable.
- **A single uniform mechanism** — per-user `session_version`, bumped by any revocation (reset, logout) and checked on every token — closed multiple races (reset-vs-refresh, logout-vs-refresh) without row locking.
- **pglite integration tests** caught real behavior (e.g. drizzle wraps the driver's `23505` under `.cause`) that mocks would have hidden.

### Challenges Encountered
- **Atomicity under concurrency (Phase 7, 3 iters)**: getting validate→rotate→issue and reset's one-time-token consume genuinely transaction-authoritative, while preserving issue #34's concurrent-refresh semantics. Resolved with in-transaction re-confirmation + conditional-delete consume + the version backstop.
- **Bootstrap safety (Phase 4, 3 iters)**: each fix exposed the next layer (promote → reset password → revoke tokens → do it atomically + bump version).
- **porch's 3-iteration ceiling** force-advanced Phase 4; the committed state was still fully corrected, but it meant the phase's code landed in porch chore commits rather than one clean phase commit.

### What Would Be Done Differently
- Write the **real-DB (pglite) integration test alongside the implementation** for anything transactional/atomic — don't wait for a reviewer to point out the mock.
- **Stage new files before each consultation** so the reviewer's diff is complete.
- Treat **"no user content in logs"** as a checklist item on every `catch`.

### Methodology Improvements
- SPIR/porch: surface the **iteration ceiling** proactively so a builder can prioritize the highest-value fixes before force-advance.
- Tooling: a lint rule for "auth code reading `process.env.JWT_SECRET` directly" would make the config-bypass class of bug non-recurring (this project added a grep-based guard test — `auth-config-bypass.test.ts`).

## Architecture Updates

Populated the previously-placeholder HOT governance files and expanded the COLD archive.

- Routed: **hot** — `arch-critical.md` — added durable auth invariants (admin via `users.is_admin`; system identity via `system_key`; auth secret/expiry only through `config`; `session_version` checked on every token; token rotation/reset/logout are transactional).
- Routed: **cold** — `arch.md` — added an "Authentication & Authorization" section documenting the token model, `session_version` mechanism, system-account reservation, and the deploy runbook (migration → bootstrap → deploy).

## Lessons Learned Updates

- Routed: **hot** — `lessons-critical.md` — "Test transactional/atomic behavior against a real DB (pglite), not mocks — a helper that ignores its tx executor passes every mocked test."; "Never log raw driver/DB errors — they can embed user content (email, params, hashes)."
- Routed: **cold** — `lessons-learned.md` — added an "Auth hardening (spec 4)" section: the session-version-as-uniform-revocation pattern; capture-version-at-auth-time; anti-oracle depends on *check placement*; drizzle wraps driver error codes under `.cause`.

## Technical Debt

- `deleteToken` is now production-dead (logout no longer uses it); retained as a repository primitive — removal candidate.
- The opportunistic token sweep is probabilistic (~2% on token issuance); adequate but not a guaranteed cadence. A cron could be added later (no `railway.toml` cron today).
- The same "log the full error" pattern that Phase 9 fixed in `register` exists in other routes (login/reset/refresh/feedback) as pre-existing code — see Follow-up.

## Flaky Tests

- No flaky tests were introduced. Two pre-existing `mcp-complete` success-path tests remain `it.skip` (route returns non-JSON streaming — pre-existing, unrelated to this spec); the endpoint→identity mapping is now covered by a separate non-skipped test.

## Follow-up Items

- **Sanitize error logging in the other auth routes** (login, reset_password, refresh_token, feedback) with the same `safeErrorMeta` treatment — pre-existing pattern, out of this spec's scope.
- **bcrypt 72-byte truncation**: `.max(128)` bounds work but multibyte input still truncates at 72 bytes — documented, not fixed (would need a pre-hash SHA-256 or argon2 migration).
- **Expired-access-token logout**: a client whose 2h access token lapsed gets 401 from logout, so its 90-day refresh token survives — a future `POST /logout {refresh_token}` variant would close that tail.
- **Deferred (explicitly out of scope for issue #4)**: rate limiting, spend caps, message-size caps, mcp-complete auth, `x-forwarded-for`, CORS, disconnect cancellation.
