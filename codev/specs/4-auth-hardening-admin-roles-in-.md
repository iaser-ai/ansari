# Specification: Auth Hardening — Durable Admin Roles, System-Account Reservation, Session-Revocation & Config-Validation Fixes

<!--
SPEC vs PLAN BOUNDARY:
This spec defines WHAT and WHY. The plan defines HOW and WHEN.
Implementation phases, file paths, code, and sequencing live in codev/plans/4-*.md.
-->

## Metadata
- **ID**: spec-2026-08-01-auth-hardening
- **Status**: draft
- **Created**: 2026-08-01
- **Source**: GitHub issue #4 (2026-08-02 multi-model security review)

## Clarifying Questions Asked

No clarifying questions were asked of a human: **a fully-specified issue (#4) already existed** when this phase began, enumerating seven ordered defects each with a concrete "Fix" directive, an explicit out-of-scope list, and hard constraints. Per SPIR, an existing spec/issue *is* the answer — the builder's job is to review, ground against the codebase, and improve, not to re-elicit. The questions the issue implicitly answers:

- **Q: Is this authz/authn only, or does it include rate-limiting / cost-abuse?** → Authz/authn correctness only. Rate limiting, spend caps, message-size caps, `mcp-complete` auth, `x-forwarded-for`, CORS, and disconnect cancellation are **explicitly deferred** and MUST NOT be implemented here.
- **Q: Are DB schema changes permitted?** → Yes, expected (role/verified flag, system marker, session version). Follow the project migration rule: `drizzle-kit generate`, review SQL, **never `db:push`**; a human applies the migration to prod at deploy.
- **Q: How is admin status to be made durable?** → A DB-backed flag set out-of-band, not the raw email match.
- **Q: Any wire-format constraints?** → No streaming wire-format or prompt changes.

## Problem Statement

The Ansari backend's authentication and authorization boundaries rest on **mutable, self-registerable, and unvalidated inputs**, so several trust decisions can be subverted by an ordinary registered user. A 2026-08-02 multi-model review (codex + gemini) independently flagged these; codex rated the admin-authorization defect *Critical*. Concretely:

1. **Admin access is derived from an email string, not identity.** `isAdmin(email)` grants admin whenever the authenticated account's `email` column is a member of the `ADMIN_EMAILS` env allowlist. Registration accepts any email with no ownership verification, and `email` is a user-mutable column. If an allowlisted address is not yet registered (or is deleted), anyone can register it — or change their own email to it — and read `/api/v2/admin/stats`, which exposes **all users' message previews**.

2. **System accounts are hijackable by pre-registration.** The unauthenticated `v2/mcp-complete` and `v1/chat/completions` endpoints resolve their system identities (`ai-skill@system.ansari.chat`, `leaderboard@system.ansari.chat`) by *lazy email lookup* (`findUserByEmail(...) || createUser(...)`). Public registration has no reserved-address check, so an attacker can register those emails first; every thread/message those public endpoints log then lands under the attacker's account and is readable via `GET /api/v2/threads`.

3. **Logout does not revoke the refresh token.** Logout deletes only the presented access token; the 90-day refresh token survives, so a "logged out" — stolen or shared — device can mint fresh access tokens for months.

4. **The feedback endpoint has an IDOR.** It verifies only that `message_id` belongs to `thread_id`, never that the thread belongs to the caller. Any authenticated user with another user's `(thread_id, message_id)` UUID pair can attach feedback (including `report` class and free-text) to someone else's message, and the endpoint doubles as a thread/message existence oracle.

5. **Refresh-rotation and password-reset are non-atomic and racy.** Rotation (validate → mark-rotated → insert-two) and reset (…​→ delete-all-tokens) are separate non-transactional statements. A refresh that validates just before a concurrent password reset can insert a fresh token pair *after* the reset's revocation, so **password reset is not a reliable session kill**. The 60-second rotation grace also allows a spent refresh token to be replayed with no reuse detection.

6. **Config validation is bypassed on the JWT secret.** Six auth code paths read `process.env.JWT_SECRET!` / `parseInt(process.env.ACCESS_TOKEN_EXPIRY_HOURS || '2')` directly, bypassing the `min(32)` Zod validation in `lib/config.ts`. A 4-character secret would deploy fine and sign every token. `lib/db/index.ts` similarly bypasses `config.database.url`.

7. **Smaller hardening gaps.** Non-constant-time comparison of the leaderboard API key; a weak password policy (`score >= 2` accepts `aaaaaaaa`, no maximum length → unbounded bcrypt input); registration leaking raw driver/DB error text to clients; and `deleteExpiredTokens` existing but never invoked (the `tokens` table grows unbounded).

## Current State

Verified directly against the codebase at branch base:

- **Admin (`lib/auth/admin.ts`)** — `isAdmin(email)` = `config.admin.emails.includes(email.toLowerCase())`. No DB flag; `requireAdmin` gates `/api/v2/admin/stats` (all-users message previews) purely on the email match. The `users.email` column is `unique` but user-mutable via `updateUser`.
- **Users schema (`db/schema/users.ts`)** — columns: `id, email (unique), passwordHash, firstName, lastName, source (default 'web'), registeredVia, createdAt, updatedAt`. **No `is_admin`/role, no verified flag, no session/credential version, no non-email system marker.**
- **Registration (`v2/users/register`)** — validates `email` + `password (min 8)`; no reserved-address / reserved-domain blocklist; catch block returns `Registration failed: ${error.message}` (raw driver text) with 500.
- **System accounts** — `v2/mcp-complete` (`ai-skill@system.ansari.chat`) and `v1/chat/completions` (`leaderboard@system.ansari.chat`) each `findUserByEmail(...) || createUser({ passwordHash: 'nologin', source: '…' })`, caching the id in a module variable. The `email` unique constraint is what collides the public-registration row and the system row onto one account.
- **Logout (`v2/users/logout`)** — `deleteToken(accessToken)` only; the refresh-token row is untouched. Refresh tokens live `REFRESH_TOKEN_EXPIRY_HOURS` (default 2160h = 90 days).
- **Refresh rotation (`v2/users/refresh_token`, `lib/db/users.ts`)** — `REFRESH_TOKEN_GRACE_MS = 60_000`; `findToken` treats a rotated token as valid while `rotatedAt > now - grace`. `markTokenRotated` is a soft mark guarded by `isNull(rotatedAt)`. Rotation is intentionally non-blocking (concurrent refreshes both succeed, per issue #34) but wholly non-transactional and has no rotated-token reuse detection.
- **Password reset (`request_password_reset`, `reset_password`)** — reset deletes all user tokens (good) but as a sequence of non-transactional statements after `updateUser`; the reset request path is enumeration-safe (always returns success).
- **Feedback (`v2/feedback`, `lib/db/threads.ts`, `lib/db/feedback.ts`)** — `findMessageById(message_id, thread_id)` scopes message-within-thread but **not thread-within-user**. `findThreadById` *does* accept an optional `userId` filter but the feedback route does not use it. `createFeedback` is a blind insert stamping the caller's `user.id`.
- **Config bypass** — `lib/config.ts` validates `JWT_SECRET` (`min(32)`) and `DATABASE_URL` (`min(1)`) lazily via `getEnv()`, exposed through `config.auth`/`config.database`. But `register`, `login`, `refresh_token`, `request_password_reset`, `reset_password`, and `lib/auth/middleware.ts` read `process.env.JWT_SECRET!` directly and re-`parseInt` the expiry inline; `lib/db/index.ts` reads `process.env.DATABASE_URL` directly. The generate-and-store token-pair block is duplicated ~4 ways across these routes.
- **Smaller items** — leaderboard key compared with plain `!==` (no `crypto.timingSafeEqual` anywhere in the codebase); `checkPasswordStrength` is a hand-rolled scorer with `valid: score >= 2` and no max length (`aaaaaaaa` → score 2 → valid; bcrypt silently truncates at 72 bytes); `deleteExpiredTokens` referenced only by a test.
- **Migrations** — `drizzle/` holds `0000_baseline`, `0001_add_tokens_rotated_at`, `0002_keen_inhumans`; convention `NNNN_<slug>.sql` with `meta/` snapshots and `_journal.json`. The next migration is `0003_*`.
- **Existing tests** — `auth.test.ts`, `admin-auth.test.ts` (mocked emails only), `password-reset.test.ts`, `refresh-token-route.test.ts`, `token-grace.test.ts` (pglite), `api/feedback.test.ts` (enum-normalization only, no ownership test).

## Desired State

The backend's trust decisions rest on **durable, server-controlled identity attributes**, and every credential/secret flows through validated configuration. After this work:

1. **Admin is a DB fact.** Admin authorization consults a durable, out-of-band-set flag on the user row, never the raw email match. Public registration of a configured admin address is refused. Startup asserts every configured admin account already exists (fail-fast), so a stale/deleted admin allowlist cannot silently open a self-registration window.
2. **System identities are unregisterable and looked up by marker.** Registration refuses reserved system addresses (and the `@system.ansari.chat` domain / any configured system address). System users are resolved by a non-registerable marker (e.g. a `source = 'system'` column / dedicated flag), not by email, so a pre-registered look-alike can never receive system-attributed data.
3. **Logout ends the session.** Logout resolves the user from the access token and revokes the submitted refresh token at minimum (full `deleteUserTokens(user.id)` is acceptable); a logged-out refresh token is rejected.
4. **Feedback is owner-scoped.** Feedback is accepted only when the target thread belongs to the authenticated user, enforced by a single scoped query (`messages → threads` with `threads.user_id = authUserId`), closing both the write-IDOR and the existence oracle.
5. **Reset is a reliable session kill; rotation is atomic and reuse-aware.** Rotation happens inside a DB transaction; a per-user credential/session version is bumped by password reset and checked on token issue/validate, so a token minted from a pre-reset refresh cannot outlive the reset. Rotated-token reuse is detected.
6. **One validated config path, one token-issue helper.** All auth paths obtain the JWT secret and expiries from `config.auth` (and the DB URL from `config.database`), so the `min(32)` / positive-bounds validation always runs. A single `issueTokenPair(userId)` helper replaces the duplicated generate-and-store block.
7. **Smaller gaps closed** (low-cost, no over-engineering): constant-time leaderboard-key comparison; password policy raised to `score >= 3` with a `.max(128)` cap; registration returns a generic error while logging the detail; `deleteExpiredTokens` is wired to run (cron or opportunistic sweep).

Every change ships with tests, and `npm run typecheck && npm test && npm run build` is green from `backend/`.

## Stakeholders
- **Primary Users**: End users of Ansari whose private threads, message previews, and sessions are protected by these boundaries.
- **Secondary Users**: Administrators relying on `/api/v2/admin/stats`; operators of the unauthenticated `mcp-complete` / leaderboard endpoints whose system-attributed data must stay isolated.
- **Technical Team**: Ansari backend maintainers (auth, db, API surface) who implement and maintain this and apply the migration at deploy.
- **Business Owners**: iaser / Ansari project owners accountable for user-data confidentiality and the security posture surfaced by the review.

## Success Criteria
- [ ] **Admin durability**: An unverified/self-registered account whose `email` equals an allowlisted string is **denied** admin (integration test proves it); admin is granted only via the durable DB flag.
- [ ] **Admin registration guard**: Public registration of a configured admin address is rejected.
- [ ] **Admin startup assertion**: The app asserts at startup that every configured admin account exists, failing fast otherwise.
- [ ] **System reservation**: Registration of a `@system.ansari.chat` (or configured system) address is refused; system-user lookup still resolves correctly by marker (tests for both).
- [ ] **Logout revocation**: After logout, the submitted refresh token is rejected (test).
- [ ] **Feedback ownership**: A cross-user `(thread_id, message_id)` pair is rejected; the owner's own pair succeeds (cross-user negative test + positive test).
- [ ] **Reset/rotation atomicity**: Rotation is transactional; a session/credential version bumped by reset invalidates pre-reset-issued tokens; rotated-token reuse is detected. Reset-vs-refresh interleavings are tested.
- [ ] **Config routing**: No auth path reads `process.env.JWT_SECRET` / `ACCESS_TOKEN_EXPIRY_HOURS` / `DATABASE_URL` directly; all route through `config`. Schema enforces `expiry > 0`. A single `issueTokenPair` helper is the only generate-and-store site.
- [ ] **Smaller items**: leaderboard compare is constant-time on equal-length buffers; password policy is `score >= 3` + `.max(128)`; registration returns a generic message (detail logged); `deleteExpiredTokens` is invoked by a scheduled/opportunistic mechanism.
- [ ] `npm run typecheck && npm test && npm run build` all green from `backend/`; no reduction in existing coverage.
- [ ] A reviewable migration is generated (not pushed) for all schema changes.

## Constraints

<!-- Architect-pinned decisions from issue #4. Treat each as fixed; do not relitigate in the plan/implementation. Raise concerns to the architect via `afx send` rather than overriding. -->

### Technical Constraints (pinned by the issue)
- **No streaming wire-format or prompt changes.**
- **DB schema changes via `drizzle-kit generate` → review SQL → do NOT `db:push`.** A human applies the migration to prod at deploy. Never run `npm run db:push` / `drizzle-kit push`.
- **Admin** gated on a durable DB flag set out-of-band (e.g. `users.is_admin` or a roles column), not the email match; reserved admin addresses rejected at registration; startup assertion that configured admin accounts exist.
- **System users** looked up by a non-registerable marker (e.g. `source = 'system'` column / dedicated flag), not email; registration rejects reserved system addresses / domain.
- **Logout** deletes at minimum the submitted refresh token (or `deleteUserTokens(user.id)`).
- **Feedback** scoped through `messages → threads` with `threads.user_id = authUserId` in one query (prefer a single scoped repository function; `findThreadById(thread_id, user.id)` is acceptable).
- **Rotation** made atomic in a DB transaction; add a per-user credential/session version bumped by reset and checked on issue/validate; detect rotated-token reuse.
- **Config**: route all six paths through `config.auth` / `config.database`; extract a single `issueTokenPair(userId)` helper; add positive bounds to the schema (`expiry > 0`).
- **Smaller items** are "do if low-cost; don't over-engineer": `crypto.timingSafeEqual` on equal-length buffers; password `score >= 3` + `.max(128)`; generic registration error + logged detail; wire `deleteExpiredTokens` (Railway cron or opportunistic sweep).
- **All changes need tests.** `npm run typecheck && npm test && npm run build` green from `backend/`; suite must stay green with only the dummy `.env.ci`.
- Stage files explicitly in commits (no `git add -A`).

### Explicitly OUT of scope (deferred separately — do NOT implement here)
Rate limiting; per-user/global spend caps; message-size caps; `mcp-complete` authentication; `x-forwarded-for` handling; CORS; disconnect cancellation. Keep this PR to authz/authn correctness.

### Business Constraints
- No fixed calendar timeline (SPIR: measured by completed phases, not time).
- Compliance: protect user-data confidentiality; the migration is human-applied at deploy.

## Assumptions
- The existing token model (SHA-256-hashed tokens, `access`/`refresh`/`reset` types, rotation-with-grace) stays; this work hardens it, not redesigns it.
- Existing intentional behaviors are preserved: concurrent refreshes both succeeding (issue #34), enumeration-safe password-reset responses.
- Admin and system accounts are provisioned/flagged out-of-band by an operator with DB access (the DB flag is not set through any public API).
- Test infrastructure (Vitest + pglite for DB-backed tests) is sufficient for the new integration/race tests without new external services.
- A scheduling mechanism (Railway cron) or an acceptable opportunistic-sweep hook is available for `deleteExpiredTokens`.
- Setting a new `source`/marker value for system accounts is compatible with existing `source` usage (default `'web'`), and existing rows can be migrated/backfilled where needed.

## Solution Approaches

### Approach 1 (RECOMMENDED): Durable identity attributes + single validated config/token path
**Description**: Add server-controlled columns to `users` — an admin flag, a system marker, and a per-user session/credential version — and make every trust decision consult them. Reserve admin/system addresses at registration and assert admin existence at startup. Route all secret/expiry access through `config`, collapse token issuance into one `issueTokenPair` helper, and make rotation transactional with version-checked issue/validate and reuse detection. Close the feedback IDOR with one owner-scoped query. Address the smaller items in-place.

**Pros**:
- Directly matches every pinned directive in issue #4.
- Trust decisions become durable DB facts, immune to email mutation / pre-registration.
- Consolidating config + token issuance removes the drift and duplication that caused the bypass.
- Session/credential version gives a reliable, race-free "kill all sessions" primitive reusable beyond reset.

**Cons**:
- Requires a DB migration (schema + backfill) and a version check on the token hot path.
- Transactional rotation touches concurrency-sensitive code (must preserve issue #34 behavior).

**Estimated Complexity**: Medium–High **Risk Level**: Medium

### Approach 2: Minimal per-defect patches, no new columns
**Description**: Fix each defect with the narrowest change avoiding schema work — e.g. keep email-based admin but harden registration; revoke refresh on logout; add the feedback ownership check; wrap rotation in a transaction without a version column.

**Pros**: Smaller diff; no migration.
**Cons**: Fails the issue's core directive (admin/system must be *durable DB facts*); without a session version, reset-vs-refresh remains fundamentally racy; leaves the email-mutation attack open. **Rejected** — does not satisfy Success Criteria.

**Estimated Complexity**: Low **Risk Level**: High (leaves Critical finding partially open)

### Approach 3: Full RBAC roles table
**Description**: Introduce a normalized `roles` / `user_roles` schema instead of a boolean flag.
**Pros**: Extensible to future role types.
**Cons**: Over-engineered for a two-state (admin / not) need; larger surface, more migration risk; the issue explicitly says "don't over-engineer." A single `is_admin` (or minimal roles column) is sufficient now. **Deferred** unless the plan surfaces a concrete near-term need.

**Estimated Complexity**: High **Risk Level**: Medium

## Open Questions

### Critical (Blocks Progress)
- [ ] None. The issue's pinned directives resolve the blocking decisions.

### Important (Affects Design)
- [ ] **`deleteExpiredTokens` trigger**: Railway cron vs. opportunistic sweep (e.g. probabilistic sweep on token operations). Which does the operator prefer? (Default assumption: opportunistic sweep if no cron is readily wired, since it needs no infra; confirm in plan/consultation.)
- [ ] **System marker shape**: reuse the existing `source` column with a reserved `'system'` value vs. a dedicated boolean/enum column. (Default: dedicated marker to avoid overloading `source`, which is also used for attribution like `'web'`/`'ai-skill'`/`'leaderboard'`; confirm.)
- [ ] **Session-version scope on validate**: check the version on every `authenticateRequest` (access-token validation) or only on refresh/rotation? (Affects hot-path cost; default: check on refresh/issue at minimum, evaluate access-path check for full guarantee.)
- [ ] **Startup admin-existence assertion severity**: hard fail (throw at boot) vs. loud log + degrade. (Issue says "assert"; default hard-fail, but confirm interaction with dev/test envs where admin accounts may not exist.)

### Nice-to-Know (Optimization)
- [ ] Should rotated-token-reuse detection actively revoke the whole session (bump version) or only reject + log? (Default: reject + log; revoke-on-reuse is a stronger option to weigh.)
- [ ] Backfill: mark existing `ai-skill@`/`leaderboard@` system rows with the new marker as part of the migration.

## Performance Requirements
- **Response Time**: No material regression on the auth hot path (login/refresh/authenticated requests). A session-version check adds at most one indexed column read already co-located with the user/token lookup.
- **Throughput**: Unchanged; transactional rotation must not serialize unrelated requests (row-scoped locking only).
- **Resource Usage**: `deleteExpiredTokens` bounds unbounded `tokens`-table growth (a positive resource change).
- **Availability**: No new external dependency on the request path; startup assertion is the only new fail-fast (by design).

## Security Considerations
- **Authentication**: Logout must revoke refresh tokens; token issuance/validation must honor the session/credential version so reset reliably kills sessions.
- **Authorization**: Admin and system-account trust must derive from server-controlled DB state, never client-influenced fields (email, registration input).
- **Data privacy**: The admin-stats endpoint exposes all users' message previews; the system endpoints log threads/messages — both must be unreachable by identity spoofing. Feedback must not become a cross-user existence oracle.
- **Secret handling**: The JWT secret must always pass `min(32)` validation; no code path may sign tokens with an unvalidated secret. Constant-time comparison for the leaderboard bearer key.
- **Input hardening**: Bounded password length (prevent unbounded bcrypt input / truncation surprises); no raw DB/driver error text returned to clients.
- **Audit**: Rotated-token reuse should be logged (no user content in logs, per project rule).

## Test Scenarios

### Functional Tests
1. **Admin denial (happy-path of the fix)**: account with an allowlisted *email string* but no DB admin flag → `/api/v2/admin/stats` returns 403.
2. **Admin grant**: account with the DB admin flag set → 200.
3. **Admin registration guard**: `POST register` with a configured admin address → rejected.
4. **Startup assertion**: configured admin address with no matching account → app fails fast at boot (test the assertion function).
5. **System reservation**: `POST register` with `ai-skill@system.ansari.chat` / `leaderboard@system.ansari.chat` / arbitrary `@system.ansari.chat` → rejected; system-user lookup by marker still resolves to the correct row.
6. **Logout**: log in → logout → the refresh token is rejected on `refresh_token`.
7. **Feedback IDOR (negative)**: user A submits feedback for user B's `(thread_id, message_id)` → rejected. **Positive**: user A on their own thread/message → accepted.
8. **Config routing**: with a `< 32`-char `JWT_SECRET`, the affected paths fail via config validation (no signing with a short secret); `expiry <= 0` rejected by schema.

### Non-Functional Tests
1. **Reset-vs-refresh race**: interleave a password reset with a concurrent refresh; assert no post-reset-valid token pair survives (session-version enforced). Include the reverse ordering.
2. **Rotated-token reuse**: replay a rotated refresh token → detected/rejected (and logged).
3. **Password policy**: `aaaaaaaa` rejected (`score >= 3`); a 129-char password rejected (`.max(128)`); a strong password accepted.
4. **Constant-time compare**: leaderboard-key check uses `crypto.timingSafeEqual` on equal-length buffers (unit test for correctness on match/mismatch/length-mismatch).

## Dependencies
- **External Services**: PostgreSQL (schema migration + transactional rotation). Optional Railway cron for the expired-token sweep.
- **Internal Systems**: `lib/config.ts` (config surface), `lib/auth/*` (jwt, middleware, admin, password), `lib/db/users.ts` + `lib/db/threads.ts` + `lib/db/feedback.ts`, the affected `v1`/`v2` route handlers.
- **Libraries/Frameworks**: Existing only — `drizzle-orm`, `zod`, `jsonwebtoken`, `bcrypt`, Node `crypto` (`timingSafeEqual`), Vitest (+ pglite for DB-backed tests). No new dependencies anticipated.

## References
- GitHub issue #4 — "Auth hardening: admin roles in DB, system-account reservation, logout/rotation fixes, feedback IDOR, config-validation bypass" (2026-08-02 multi-model review).
- `backend/CLAUDE.md` — backend conventions (config/env rules, migration rule, no user content in logs, explicit staging).
- Related prior work referenced in code: issue #34 (concurrent-refresh behavior), spec 56 (`registered_via`).
- Current-state file/line map: captured in `codev/state/spir-4_thread.md`.

## Risks and Mitigation
| Risk | Probability | Impact | Mitigation Strategy |
|------|------------|--------|---------------------|
| Transactional rotation breaks intended concurrent-refresh (issue #34) behavior | Medium | High | Preserve the two-both-succeed semantic explicitly; keep locks row-scoped; regression-test concurrent refresh alongside the new race tests. |
| Session-version check regresses auth hot-path latency | Low | Medium | Read version from the already-fetched user row / co-located column; benchmark; scope the check per Open Question. |
| Startup admin-existence assertion breaks dev/test/CI (no admin rows) | Medium | Medium | Gate/parameterize the assertion so dev/test with empty allowlists don't hard-fail; test both envs. |
| Migration/backfill mishandles existing system rows | Low | High | Backfill the marker for existing `ai-skill@`/`leaderboard@` rows in the same migration; review generated SQL; human-applied at deploy. |
| Reserved-address list drifts from actual system/admin addresses | Low | Medium | Derive reserved addresses/domain from the same config the endpoints use; single source of truth. |
| Scope creep into deferred items (rate limiting, spend caps) | Medium | Medium | Enforce the explicit out-of-scope list in review; reject any such change in this PR. |

## Expert Consultation
**Date**: (pending)
**Models Consulted**: GPT-5 Codex and Gemini Pro (via porch 3-way verify)
**Sections Updated**: To be filled after the consultation checkpoint. All feedback will be incorporated directly into the sections above.

## Approval
- [ ] Technical Lead Review
- [ ] Product Owner Review
- [ ] Stakeholder Sign-off
- [ ] Expert AI Consultation Complete

## Notes
- The issue is treated as architect-pinned: its per-item "Fix" directives and Constraints are copied into **Constraints** and treated as fixed. Prescriptive *implementation* choices (helper names, column names) are recorded as intent; exact mechanics belong in the plan.
- The seven items are severity-ordered in the issue; the plan should preserve that ordering when phasing (admin authz first, config/token consolidation as a foundation others build on).
