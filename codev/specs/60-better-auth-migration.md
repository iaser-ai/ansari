# Specification: Better Auth Migration Plan

## Metadata

- **ID**: spec-2026-09-11-better-auth-migration
- **Status**: draft (revised per PR #134 review)
- **Created**: 2026-09-11
- **Source**: GitHub issue #60
- **Depends on**: #59 (Better Auth scaffold in `apps/auth` + `packages/auth`)

## Problem Statement

Ansari's production authentication is a custom JWT system in `apps/api`: HS256 access/refresh
tokens, SHA-256-hashed rows in `tokens`, bcrypt passwords on `users.password_hash`, and
`session_version` as a global session-revocation primitive. It is hardened (spec 4) and well tested,
but capabilities such as OAuth, 2FA, email verification, and passkeys would all be custom work.

Issue #59 added a **second, additive** Better Auth stack (`packages/auth`, `apps/auth`) with four
new tables (`user`/`session`/`account`/`verification`). `apps/api` still uses the legacy path
exclusively. This spec defines how to migrate to Better Auth **without locking out existing users**
(same passwords; users re-authenticate after cutover).

### Schema gap

How each legacy field is handled at migration — **value derivation**, not in-place ALTER of the legacy
`users` table:

| Area | Legacy (`users` + JWT) | Better Auth target | Migration handling |
|------|------------------------|--------------------|--------------------|
| User id | UUID | UUID (`generateId = "uuid"`) | Preserved on `INSERT … SELECT` |
| Name | `firstName` + `lastName` (nullable) | single `name` (required) | See **Name derivation** below |
| Password | `users.password_hash` | `account.password` (`providerId='credential'`) | Bcrypt hash copied; verified via dual hash hook |
| Email verification | none | `emailVerified` + `verification` | Default/false for migrated rows unless policy adds verify later |
| Custom columns | `isAdmin`, `systemKey`, `sessionVersion`, `source`, `registeredVia` | `additionalFields` where retained | **`system_key`, `source`, `registered_via` migrate**; **`is_admin` and `session_version` are dropped** (not carried forward) |
| Timestamps | `timestamptz` | `timestamp` (no tz) in scaffold | Phase 0 spike proves acceptable mapping or schema adjustment |
| Sessions | `tokens` table | `session` table | `tokens` retired at cutover |

Four tables carry UUID foreign keys to `users.id` with `onDelete: cascade`: **`threads`,
`tokens`, `preferences`, `feedback`**. At cutover, **`threads`, `preferences`, and `feedback` FKs
repoint** to Better Auth's user table (same UUID values). `tokens` is retired with JWT auth.

### Post-#59 constraints

- **`user` vs `users`**: Consolidation is decided here (#59 deferred). Better Auth supports
  `modelName` — the canonical table may still be named **`users`** to avoid quoting the SQL reserved
  word `user`. The **legacy `users` table is not adapted in place**; data moves into the Better Auth
  table and the legacy table is renamed aside (see Retention).
- **CORS**: `apps/api/next.config.ts` sets `Access-Control-Allow-Origin: *` alongside
  `Access-Control-Allow-Credentials: true`. Invalid for cookie-based auth — fix before credentialed
  Better Auth traffic hits `apps/api`.
- **`trustedOrigins` (better-auth@1.6.27)**: PR #61 probed custom schemes — e.g. `askbad://` can
  still return 200 on sign-in/sign-out. **`trustedOrigins` is not treated as a security boundary for
  custom URI schemes on this version.** Do not add a vacuous “list sync” test that passes while wrong
  origins succeed; any origin test must be proven to **fail** on a wrong origin, or document the
  limitation explicitly.

## Current State

- **Legacy auth (`apps/api`)**: Register/login/refresh/logout/reset via `v2/users/*`; middleware
  validates JWTs; `issueTokenPair` writes to `tokens`; `session_version` checked on every validation.
- **Better Auth (#59)**: `packages/auth` exports `createAuth()`; `apps/auth` mounts
  `toNodeHandler(auth)` at `/api/auth/*`. Stock schema uses text ids; shares `DATABASE_URL` with
  `apps/api` but no Drizzle code overlap yet.
- **Passwords**: bcrypt (12 rounds) in `apps/api/lib/auth/password.ts` (including `.max(128)` policy;
  bcrypt 72-byte truncation behavior is inherited by the permanent bcrypt verify path).
- **Admin**: `users.is_admin` DB flag; `scripts/grant-admin.ts` sets it out-of-band.
- **System accounts**: `users.system_key` (`ai-skill`, `leaderboard`); resolved by key, not email.
- **Clients**: e.g. `prototypes/ansari-expo` calls `/api/v2/users/*` today — cutover requires clients
  that reach the new login path (precondition for “log in again”).

## Decision: Migrate to Better Auth architecture

**Chosen:** Adopt Better Auth as the canonical auth model (`session`, `account`, `verification`,
cookie sessions, admin plugin). Preserve **UUID user identity** (same id per person) so
`threads` / `preferences` / `feedback` remain attached after FK repoint. **Single cutover** — no
production period where new users use Better Auth and existing users stay on JWT.

**Rejected:**

- Permanent dual auth (JWT + Better Auth serving traffic simultaneously).
- **In-place adaptation** of the legacy `users` row as the long-lived Better Auth user table without
  migration into the Better Auth schema and retirement of the legacy table.

**Reasoning:**

1. Better Auth is configurable ([Database docs](https://better-auth.com/docs/concepts/database)) —
   UUID ids and `additionalFields` — but sessions and accounts must be first-class, not a JWT
   wrapper.
2. UUID continuity avoids rewriting user-owned rows; FK **targets** change, not user ids.
3. Primary failure mode: **silent lockout** — addressed by bcrypt copy + permanent dual verify + Phase
   0 spike.
4. #59 additive scaffold is the starting point; this spec defines cutover and schema consolidation.

**Tradeoff accepted:** Divergence from stock docs (UUID, permanent bcrypt+scrypt verify, custom
fields, optional `users` table name via `modelName`). Document in `arch.md`.

---

## #59 scaffold disposition

Issue #59 may have applied `packages/auth/drizzle/0000_better_auth_init.sql`, creating singular
`user` (text id) plus `session` / `account` / `verification` **alongside** legacy `public.users`
(UUID). That scaffold is **not** the cutover target.

**Phase 0 (before staging backfill):**

1. Regenerate `@ansari/auth` Drizzle schema with **`advanced.database.generateId = "uuid"`** and
   **`modelName` → canonical table `users`** (or an explicitly documented staging name — see cutover
   sequence).
2. Replace the #59 migration path: new generated migration **drops** the four scaffold tables if they
   exist (`user`, `session`, `account`, `verification`), then creates the UUID **`users`**-shaped
   Better Auth tables. Environments that never applied #59 skip the drop safely via `IF EXISTS`.
3. **No production user data** lives in the #59 `user` table at cutover; any rows there are test or
   dev-only and are discarded with the drop. All real identities remain in legacy `public.users` until
   the cutover window.

---

## Data migration and schema consolidation

### Name derivation

For each legacy row, **`name`** at insert time:

1. Let `combined = trim(concat(coalesce(first_name, ''), ' ', coalesce(last_name, '')))`.
2. If `combined` is non-empty → `name = combined`.
3. Else → `name =` the substring of `lower(email)` before the first `@`; if that is empty → **`'User'`**.

This satisfies Better Auth's NOT NULL `name` without altering the legacy table.

**Migrated users:** `emailVerified = false` unless a later policy explicitly grandfathers verified
emails (default for cutover: false).

### Cutover window — ordered operations

Single maintenance window; **no dual-run serving**. When the canonical Better Auth table is named
**`users`** via `modelName`, operations run in this order (same UUID values throughout):

1. **Quiesce auth traffic** (deploy gate or brief read-only — plan defines mechanism).
2. **Rename** legacy `public.users` → **`public.users_legacy`** (existing FKs on `threads`,
   `preferences`, `feedback`, `tokens` now reference `users_legacy.id`; still valid).
3. **Create** empty Better Auth **`public.users`** (UUID PK, BA columns + `additionalFields`).
4. **`INSERT … SELECT`** from `users_legacy` into `users` (id, email, derived `name`, timestamps,
   `system_key`, `source`, `registered_via`; omit `is_admin`, `session_version`).
5. **Backfill `account`** rows (`provider_id = 'credential'`, bcrypt copy from
   `users_legacy.password_hash`) with idempotent `ON CONFLICT` on `(user_id, provider_id)`.
6. **`ALTER` FK constraints** on `threads`, `preferences`, `feedback` to reference **`users.id`**
   instead of `users_legacy.id` (UUID unchanged → row data untouched). Retire or drop `tokens` with
   JWT routes in the same window.
7. **Deploy** app code that reads/writes only the new `users` + BA session model; **no Drizzle model**
   for `users_legacy`.
8. **Invalidate** all legacy JWT/`tokens` sessions; users re-authenticate via Better Auth.

Rollback in this window = **restore DB snapshot** from before step 2, not continued dual auth.

### Legacy retention and drop trigger

After step 7, **`users_legacy` remains** as a read-only archive **only** (no app or API access).

**Drop `users_legacy`** in Phase 4 when **all** of the following are true:

1. **≥ 14 calendar days** since the cutover deploy completed successfully.
2. **Row-count parity:** `count(*)` from `users_legacy` equals `count(*)` from canonical `users`
   (by primary key set equality audit, not estimate).
3. **No open rollback** request or incident requiring restore from pre-cutover snapshot.
4. **Operator sign-off** recorded in the deploy runbook (human step).

Then: `DROP TABLE users_legacy` in a reviewed migration — single statement, no Drizzle model ever
added for the archive table.

**Migration idempotency (required):** `account` must have a **unique constraint on
`(user_id, provider_id)`** (today only a non-unique index on `user_id` in
`packages/auth/src/schema.ts`). Bulk backfill uses **`ON CONFLICT DO NOTHING`** (or equivalent) so
re-runs do not duplicate credential rows.

---

## Environment and config convergence (#59)

#59 left **`@ansari/auth` env validation separate** from `apps/api/lib/config.ts`. This spec
assigns the end-state rule:

- **Cutover target:** Product deploys that run Better Auth use **`@ansari/auth` `getEnv()`** (or a
  single shared env module introduced in the plan) for `BETTER_AUTH_*`, session secret, and DB URL
  used by the auth stack.
- **`apps/api` JWT vars** (`JWT_SECRET`, token expiries) **decommission** with the JWT path — not
  dual-maintained forever.
- **Turbo `globalEnv`:** Any new auth env vars follow the four-way derivation rule in
  `arch-critical.md`.
- **Convergence timing:** Env unification ships with **Phase 3 (legacy decommission)** at latest; plan
  may introduce a read-only shared contract earlier.

---

## Answers to the eight open questions

### 1. `session_version`

**Decision:** **Delete** `session_version` at cutover — not bridged to Better Auth. Better Auth
**session rows** are the revocation primitive after cutover.

**At cutover:** All JWT/`tokens` sessions **end**. Users sign in again via Better Auth (same password,
not a reset). No dual-run period where legacy tokens stay valid alongside Better Auth sessions.

**Guarantee replaced:** Kill all sessions = invalidate Better Auth session rows for that user (plugin,
sign-out, or admin action).

### 2. Refresh-token rotation / revoke-on-reuse (#16)

**Decision:** Legacy JWT refresh rotation (**#34**, `#16`) **retires with `tokens` at cutover**.
Better Auth owns session lifecycle after cutover. **Close #16** in implementation by documenting
Better Auth behavior and tests — do not port `tokens.rotatedAt` grace forward.

### 3. System accounts

**Decision:** `system_key` migrates as a server-owned `additionalField` (`input: false`). Lookup by
`system_key`, never email; reserved addresses still blocked at registration. System rows keep their
UUIDs through `INSERT … SELECT`.

Also migrate **`source`** and **`registered_via`** as documented additional fields where needed for
attribution; do not migrate `session_version` or `is_admin`.

### 4. Admin authorization

**Decision:** [Better Auth admin plugin](https://better-auth.com/docs/plugins/admin) is the
**post-cutover** admin mechanism. **`users.is_admin` is deleted** — no dual-check bridge.

**Cutover operations:** Admin roles are **assigned manually** through Better Auth after cutover (or
via one-time migration script that sets plugin roles — not by preserving `is_admin`). **`scripts/grant-admin.ts`
retires**; it is not updated for the new model.

**Invariant preserved:** Admin is never email-match; `ADMIN_EMAILS` remains reservation + production
boot assertion only until JWT/admin bootstrap path is removed (plan defines replacement assert).

### 5. Where does it run?

**Decision:**

| Stage | Hosting |
|-------|---------|
| Through cutover | **`apps/auth`** — Express + `toNodeHandler` (#59). |
| Optional later | Fold into **`apps/api`** via `toNextJsHandler` when CORS/cookie story is ready. |

### 6. Existing user credentials

**Decision:** No mass password reset.

1. One-time SQL backfill: bcrypt hashes into `account.password` with `provider_id='credential'`.
2. **Permanent** custom verification
   ([email-password configuration](https://better-auth.com/docs/authentication/email-password#configuration)):
   `$2a$` / `$2b$` → bcrypt; otherwise scrypt for new passwords.
3. **Standing commitment:** Both algorithms remain supported until a future spec explicitly removes
   bcrypt; the bcrypt path inherits **72-byte truncation** behavior from current
   `apps/api/lib/auth/password.ts`. A **regression test must fail** if the bcrypt branch is removed
   while migrated hashes still exist.
4. **Phase 0 spike:** One test user end-to-end before bulk backfill (see exit criteria below).

Optional opportunistic rehash to scrypt on login is allowed in the plan but **not** required for
cutover approval.

### 7. Cutover shape and rollback

**Decision:** **Single cutover**, not side-by-side dual-run.

| Aspect | Rule |
|--------|------|
| Sessions at cutover | **All** legacy sessions invalidated; users re-login with existing password |
| Traffic | **No** production window where new users use BA and existing users use JWT |
| Phasing | **Prepare → backfill → cutover → decommission** (implementation phases), not dual auth serving |
| Rollback | Revert deploy / restore DB snapshot from cutover window — not “keep legacy path enabled” as steady state |
| Clients | **Precondition:** Clients used at cutover must call the **new** auth endpoints (e.g. move off
  `prototypes/ansari-expo` `/api/v2/users/*` before or as part of the same release). “Log in again”
  is only achievable if the client reaches Better Auth (or the agreed proxy). |

**CORS:** Replace wildcard origin in `apps/api/next.config.ts` before credentialed cookie auth against
`apps/api`; allowlist aligned with `packages/auth` `trustedOrigins` for web origins (custom schemes
per trustedOrigins limitation above).

### 8. Test suite

| Category | Action |
|----------|--------|
| JWT route tests | Remove or replace at decommission |
| Admin authz | Rewrite for admin plugin + BA session |
| System / registration guards | Keep behavior; BA fixtures |
| Feedback / ownership | Keep |
| `bcrypt-compat.test.ts` | Keep |
| **New — required** | BA E2E; migrated-user bcrypt login; **bcrypt verify branch test (must fail if branch removed)**; origin test only if proven to reject wrong origins |

**Safety bar:** Spec-4 invariants except those explicitly retired (`session_version`, `is_admin` column).

---

## Phase 0 spike — exit criteria

Before bulk backfill or production cutover, Phase 0 must prove:

1. **UUID round-trip:** `advanced.database.generateId = "uuid"` — id written by Better Auth's Drizzle
   adapter persists and reads correctly in a UUID-typed column (verified against better-auth@1.6.27).
2. **One migrated user:** `INSERT … SELECT` + `account` row → sign-in via Better Auth with **unchanged
   password** (bcrypt path).
3. **Timestamps:** `timestamptz` legacy data vs Better Auth `timestamp` schema — document chosen mapping
   or schema adjustment; no silent corruption of `created_at` / `updated_at`.
4. **`account` uniqueness:** `(user_id, provider_id)` constraint in place; idempotent backfill
   verified on re-run.

---

## Desired State

After cutover:

1. All product auth through Better Auth (`apps/auth` initially).
2. Existing users authenticate with **same passwords** (bcrypt verify path).
3. New passwords use scrypt unless/until bcrypt path is retired by a future change.
4. User UUIDs unchanged; **FKs point at Better Auth user table** (`users` name via `modelName` if chosen).
5. Admin via **admin plugin**; no `is_admin` column.
6. System accounts via **`system_key`** additional field.
7. JWT, `tokens`, `session_version`, `grant-admin.ts` **removed**.
8. `users_legacy` exists only under retention rule, then dropped.
9. Env contract converged per section above.

## Phased outcomes

Phases are **sequential preparation**, not dual-run serving:

### Phase 0 — Spike and schema

UUID config; **#59 scaffold disposition** (drop text-id `user` tables, create UUID `users`); `modelName`
decision; FK migration design; Phase 0 exit criteria green.

### Phase 1 — Prepare

Dual bcrypt/scrypt verifier; admin plugin wired; CORS allowlist; client auth path updates; unique
`account` constraint; env convergence design.

### Phase 2 — Backfill

Idempotent SQL migration (ported framework): user + account rows; `additionalFields`; **no** live
cutover yet — validate in staging.

### Phase 3 — Cutover

Execute **Cutover window — ordered operations** (above) in one deploy; switch API middleware to BA
sessions; route auth to `apps/auth`; manual admin role assignment.

### Phase 4 — Decommission

Remove JWT routes, `tokens` usage, JWT env from turbo/config; **`DROP users_legacy`** when all four
**Legacy retention and drop trigger** conditions are met; update tests and `arch-critical.md`.

### Phase 5 (optional) — Hosting

Fold auth into `apps/api` (`toNextJsHandler`); retire `apps/auth` service.

## Stakeholders

- **Primary users:** Existing users — same password, one re-login at cutover.
- **Secondary users:** Admins (manual role assignment post-cutover); system endpoint operators.
- **Technical team:** Backend; DB migration at deploy.
- **Business owners:** IASER / Ansari.

## Success Criteria

- [ ] Adapt-vs-migrate decision documented.
- [ ] All eight issue questions answered.
- [ ] Single-cutover strategy explicit (no dual-run serving).
- [ ] Data migration, FK repoint, `users_legacy` retention; **drop trigger (14d + parity + sign-off) in spec**.
- [ ] Credential story: bcrypt copy + **permanent** dual verify + spike exit criteria.
- [ ] Env convergence (#59) addressed.
- [ ] `arch-critical.md` delta listed.
- [ ] Implementation out of scope for #60 — follow-up issues per phase.

## Constraints

- **Spec only for #60** — implementation in follow-up issues.
- **DB:** `drizzle-kit generate` → review SQL → human-applied at deploy. Never `db:push`.
- **Surviving invariants:** system by `system_key`; admin never email-match; reserved system emails.
- **Failure mode:** silent mass lockout.

## Assumptions

- #59 scaffold runnable; better-auth@1.6.27 behavior as probed in #61 for `trustedOrigins`.
- Ported SQL migration framework available before Phase 2 implementation.
- **Cutover release** includes client auth path updates for all supported production clients (or
  documents explicit exceptions).

## `arch-critical.md` changes

| Current | After migration |
|---------|-----------------|
| `session_version` kill-all | Better Auth session invalidation |
| JWT via `config.auth` | Better Auth env / `@ansari/auth` |
| Token rotation in `tokens` | Better Auth sessions |
| Admin = `users.is_admin` | Admin plugin |
| **Unchanged** | System by `system_key`; admin never email-match; drizzle never db:push |

## Risks

| Risk | Mitigation |
|------|------------|
| Mass lockout | Phase 0 spike; permanent dual verify; staging backfill |
| FK repoint error | Staging cutover rehearsal; row-count audits |
| Clients still on `v2/users/*` | Cutover precondition; same-release client updates |
| Duplicate `account` rows | Unique `(user_id, provider_id)` + ON CONFLICT |
| Wrong-origin auth on native | Do not rely on `trustedOrigins` for custom schemes on 1.6.27 |

## Out of Scope

- OAuth, 2FA, email verification, passkeys (later BA config).
- Rate limiting, MCP auth, spend caps.
- Implementation detail (plan: `codev/plans/60-better-auth-migration.md`).

## References

- GitHub issue #60, PR #134 review
- #59 review: `codev/reviews/59-build-better-auth-in-apps-auth.md`
- [Better Auth — Database / UUIDs](https://better-auth.com/docs/concepts/database#uuids)
- [Better Auth — Email & password](https://better-auth.com/docs/authentication/email-password#configuration)
- [Better Auth — Admin plugin](https://better-auth.com/docs/plugins/admin)
- Spec 4: `codev/specs/4-auth-hardening-admin-roles-in-.md`
