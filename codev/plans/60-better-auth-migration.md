# Plan: Better Auth Migration (Custom JWT → Better Auth)

## Metadata

- **ID**: plan-2026-09-17-better-auth-migration
- **Status**: draft
- **Specification**: [codev/specs/60-better-auth-migration.md](../specs/60-better-auth-migration.md)
- **Source**: GitHub issue #60 (spec merged via PR #134)
- **Depends on**: #59 (`apps/auth` + `packages/auth` scaffold)
- **Created**: 2026-09-17

## Executive Summary

Replace `apps/api`'s custom JWT auth (`v2/users/*`, `tokens`, `session_version`) with **Better Auth**
as the sole production auth model, using a **single cutover** (no dual-run serving). User **UUIDs are
preserved**; legacy `public.users` is renamed to `users_legacy`, data is copied into Better Auth's
`users` table, FKs on `threads` / `preferences` / `feedback` are repointed, and **`tokens` is dropped**
in the same window.

Work is split into **six implementation phases (0–4 + optional 5)**. Each phase is independently
revertible via git; **Phase 3 (cutover) is one coordinated deploy** with a DB snapshot rollback, not
steady-state dual auth. Phases 0–2 may ship in one or more PRs; **Phase 3 should be its own reviewed
release** with a written runbook.

**Three items from PR #134 approval** (Amr, 2026-09-15) are first-class plan requirements:

1. **Admin boot assertion ordering** — `assertConfiguredAdminsExist` (`apps/api/lib/auth/startup-checks.ts`)
   checks `is_admin` today; cutover deletes that column. The replacement assert and **admin role
   assignment must complete before** `apps/api` production boot in the cutover deploy.
2. **`emailVerified` policy for migrated rows** — explicit product decision (see Policy decisions).
3. **`tokens` table** — **mandatory `DROP TABLE tokens`** during cutover (not optional “retire usage”),
   so a later `DROP users_legacy` is not blocked by FK dependencies.

**Migration SQL** for bulk user/account backfill and cutover steps should follow the **ported framework**
from the legacy auth migration script (coordinate with Waleed: location, idempotency helpers, and review
gate before Phase 2).

**PR #148 review (Amr, 2026-09-18)** — folded into this revision:

- **`apps/api` auth:** Better Auth **bearer plugin** (`Authorization: Bearer` session token), not shared
  session cookies between `apps/auth` and `apps/api`.
- **`revokeSessionsOnPasswordReset: true`** in `createAuth()` (opt-in in better-auth@1.6.27).
- **Cutover step 1:** take **`apps/api` fully offline** for the DB window; `MAINTENANCE_MODE` / app-check
  alone does not stop requests.
- **Phase 0 migration:** admin plugin columns on `users` / `session` named explicitly.

## How `apps/api` authenticates after cutover

`apps/auth` and `apps/api` are separate hosts. Session cookies set by `apps/auth` are host-only (no
shared cookie domain in today's `packages/auth` config), so **`apps/api` does not receive the BA session
cookie**. Native clients are not a browser cookie jar either.

**Decision:** enable Better Auth's **bearer plugin** in `packages/auth` (alongside `expo()`). Flow:

1. Client signs in via `apps/auth` (`/api/auth/*`).
2. Sign-in response exposes the session token in **`set-auth-token`** (and CORS must expose that header).
3. Client stores the token (SecureStore on native; web: chosen storage — document in client PR).
4. Every `apps/api` request sends **`Authorization: Bearer <token>`**.
5. Bearer before-hook verifies the token and injects it as the session cookie for Better Auth internals;
   **`auth.api.getSession({ headers })`** in `apps/api` is the validation path (session row lookup, same
   cost class as today's `findToken` → `users` join).

**Env (Phase 1 convergence):** `apps/api` needs the **same `BETTER_AUTH_SECRET`** as `apps/auth` (HMAC
verify) and the shared **`DATABASE_URL`** it already uses for user-owned data.

## Success Metrics

- [ ] All specification success criteria met (single cutover, data migration, FK repoint, `users_legacy`
  retention/drop trigger, credential story, env convergence).
- [ ] Phase 0 exit criteria green (UUID round-trip, one bcrypt user login, timestamps documented,
  `(user_id, provider_id)` uniqueness + idempotent backfill).
- [ ] `revokeSessionsOnPasswordReset: true` configured; test fails if removed.
- [ ] Bearer plugin enabled; `apps/api` can resolve a session from `Authorization: Bearer` in dev/staging.
- [ ] Staging rehearsal of the full cutover window (steps 1–8 from spec) with row-count / PK-set audits.
- [ ] Production cutover: zero dual-run period; all users re-authenticate via Better Auth with existing
  passwords (no mass reset).
- [ ] Permanent dual hash verify (bcrypt + scrypt) with a **regression test that fails** if the bcrypt
  branch is removed while legacy hashes exist.
- [ ] `npm run typecheck && npm test && npm run build` green for affected workspace packages at each
  phase boundary (at minimum `apps/api`, `packages/auth`, `apps/auth`, and any updated clients).
- [ ] `arch-critical.md` updated at Phase 4 per spec delta table.
- [ ] Deploy runbook executed and signed off (operator step for `users_legacy` drop).

## Policy Decisions (resolve before Phase 2 merge)

### `emailVerified` for migrated users

The spec defaults migrated rows to `emailVerified = false`. Better Auth blocks sign-in when
`requireEmailVerification` is enabled and the flag is false.

| Option | Behavior | Tradeoff |
|--------|----------|----------|
| **A — Grandfather (recommended)** | Set `email_verified = true` on all rows inserted from `users_legacy` | Users already proved email control by using the product; avoids a future config flip locking out the whole cohort |
| **B — Stay false** | Keep `false`; document that **`requireEmailVerification` must stay off** while cutover-migrated rows exist | Stricter BA defaults; future email-verify feature must explicitly handle the cohort |

**Plan default:** Option A unless product explicitly chooses B in plan approval. Record the chosen
option in the cutover SQL and in `docs/self-hosting.md`.

## Phases (Machine Readable)

```json
{
  "phases": [
    {"id": "phase_0", "title": "Spike, UUID schema, #59 scaffold disposition"},
    {"id": "phase_1", "title": "Prepare: bearer middleware, admin tooling, CORS, clients, env convergence"},
    {"id": "phase_2", "title": "Staging backfill: idempotent SQL migration framework"},
    {"id": "phase_3", "title": "Production cutover window (single deploy)"},
    {"id": "phase_4", "title": "Decommission JWT, drop users_legacy when triggered, arch-critical"},
    {"id": "phase_5", "title": "Optional: fold apps/auth into apps/api"}
  ]
}
```

## PR and Issue Strategy

- Open **one GitHub issue per phase** (or per phase group) linked to #60; reference this plan.
- **Recommended PR split:** Phase 0 (+ optional Phase 1 prep) → Phase 1 remainder → Phase 2 (migrations
  only + staging tests) → **Phase 3 alone** → Phase 4 → Phase 5 optional.
- Phase 3 PR must include: runbook, rollback snapshot instructions, and checklist sign-off template.

---

## Phase 0: Spike, UUID schema, #59 scaffold disposition

**Dependencies:** #59 merged and runnable locally.

### Objectives

Prove Better Auth works with **UUID** ids and the **cutover-shaped** schema before any production
data movement. Remove the text-id #59 scaffold tables in favor of UUID `users` (via `modelName`).

### Deliverables

- [ ] **`packages/auth` — `createAuth()` config**
  - `advanced.database.generateId = "uuid"`.
  - `user` model → table name **`users`** via Better Auth `modelName` (avoid SQL reserved `user`).
  - `additionalFields`: `system_key`, `source`, `registered_via` (`input: false` where server-owned).
  - **`plugins`:** `expo()` and **`bearer()`** (session token via `Authorization: Bearer` for `apps/api`).
  - **`emailAndPassword`:** permanent dual verify (below) plus **`revokeSessionsOnPasswordReset: true`**
    (not default in better-auth@1.6.27 — without it, password reset leaves old sessions alive vs today).
  - **Admin plugin** enabled; schema must include plugin columns **before cutover step 8**:
    - On **`users`:** `role`, `banned`, `ban_reason`, `ban_expires` (names per generated admin schema for
      1.6.27 — verify in `drizzle-kit generate` output, do not hand-wave).
    - On **`session`:** `impersonated_by` (admin impersonation).
- [ ] **Regenerate Drizzle schema** in `packages/auth/src/schema.ts`: UUID PK/FKs on `users`,
  `session`, `account`, `verification`; **unique constraint on `account (user_id, provider_id)`**; admin
  columns above present in the Phase 0 migration SQL.
- [ ] **New migration** (human-reviewed, never `db:push`):
  - `DROP TABLE IF EXISTS` #59 tables (`user`, `session`, `account`, `verification`) with safe ordering.
  - `CREATE` UUID-shaped Better Auth tables (empty `users` alongside legacy `public.users` until cutover).
- [ ] **Permanent dual password verify** in `emailAndPassword` config: `$2a$` / `$2b$` → legacy bcrypt
  (including 72-byte truncation parity with `apps/api/lib/auth/password.ts`); otherwise scrypt for new
  passwords.
- [ ] **Phase 0 spike script or test fixture:** one legacy-format row → manual `INSERT` + `account` →
  sign-in via `apps/auth` with unchanged password.
- [ ] **Timestamp mapping doc** (in plan appendix or `packages/auth/README`): how `timestamptz` legacy
  values map to BA `timestamp` columns; adjust schema to `timestamptz` only if spike shows corruption.

### Phase 0 exit criteria (spec — must be green)

1. UUID round-trip through Drizzle adapter into UUID columns (better-auth@1.6.27).
2. One migrated test user: bcrypt login end-to-end via Better Auth.
3. Timestamps: documented mapping or schema fix; no silent corruption on `created_at` / `updated_at`.
4. `(user_id, provider_id)` unique + idempotent backfill re-run verified on throwaway DB.

### Acceptance Criteria

- [ ] Local: `apps/auth` sign-up/sign-in works against UUID schema (new user).
- [ ] Spike user (copied bcrypt hash) signs in successfully.
- [ ] `drizzle-kit generate` output reviewed; migration committed, not applied by CI.

### Test Plan

- **Integration:** extend `packages/auth/tests/auth.integration.test.ts` for UUID ids and bcrypt migrated
  login.
- **Unit:** password verify dispatches on hash prefix; bcrypt truncation edge case from spec 4 suite
  reused or mirrored.
- **Integration:** password reset with an existing session → sessions revoked when
  `revokeSessionsOnPasswordReset` is true; **test must fail** if the flag is removed.

### Rollback Strategy

Revert Phase 0 commits; re-apply #59 migration only in dev if needed. Legacy `apps/api` auth unchanged.

### Risks

| Risk | Mitigation |
|------|------------|
| BA + Drizzle UUID mismatch | Exit criterion 1; pin better-auth@1.6.27 until upgraded deliberately |
| Dropping #59 tables loses dev-only rows | Acceptable per spec; document in README |

---

## Phase 1: Prepare (verifier, admin, CORS, clients, env)

**Dependencies:** Phase 0 complete.

### Objectives

Make the codebase **ready for cutover** without switching production traffic: bearer session validation
on `apps/api`, client token flow, CORS (including exposed auth headers), env contract, and admin tooling
— still on JWT in production until Phase 3.

### Deliverables

- [ ] **`apps/api` middleware:** import `@ansari/auth`, call **`auth.api.getSession({ headers })`** on
  protected routes; require **`Authorization: Bearer`** (from bearer plugin). Feature-flag or dev-only
  path until Phase 3; remove JWT `findToken` path in the Phase 3 deploy.
- [ ] **Admin plugin** fully wired in `packages/auth`; design **`scripts/grant-admin.ts` replacement**
  (e.g. `scripts/assign-ba-admin.ts`) that sets admin plugin **`role`** by email — **does not** touch
  `is_admin`.
- [ ] **Replacement startup assert** (design + implement behind feature flag or dual-read until Phase 3):
  - New `assertConfiguredBaAdminsExist()` (or equivalent) resolves `ADMIN_EMAILS` and checks Better Auth
    admin role — **not** `users.is_admin`.
  - Keep `shouldRunAdminStartupCheck` gating (`NEXT_PHASE`, production only) from spec 4.
  - **Do not** enable the new assert in production until Phase 3 cutover ordering is satisfied.
- [ ] **CORS:** fix `apps/api/next.config.ts` wildcard origin + credentials; allowlist aligned with
  `packages/auth` `trustedOrigins` for **web** origins. Document `trustedOrigins` limitation for custom
  schemes (PR #61) — no vacuous origin tests.
- [ ] **Client inventory + updates:**
  - `prototypes/ansari-expo`: sign-in via `apps/auth`; read **`set-auth-token`**; store token; send
    **`Authorization: Bearer`** on `apps/api` calls (existing bearer wiring in `lib/api/` can be
    repointed from JWT access tokens to BA session token).
  - List any other `v2/users/*` callers (grep); same-release updates or documented exceptions.
- [ ] **Env convergence (implement, not design-only):** `apps/api` production env includes
  **`BETTER_AUTH_SECRET`** (same value as `apps/auth`) plus existing `DATABASE_URL`; document in
  `.env.example`. Timeline to remove `JWT_*` at Phase 4.
- [ ] **CORS on `apps/auth`:** expose **`set-auth-token`** to browser clients that need it
  (`Access-Control-Expose-Headers` — bearer plugin adds this for sign-in; verify for your origins).

### Acceptance Criteria

- [ ] Staging/dev: client completes login against `apps/auth`, then a bearer-authenticated `apps/api`
  call succeeds via `getSession`.
- [ ] New admin assignment script works against BA admin plugin in dev.
- [ ] CORS preflight with credentials succeeds for allowed origins only.

### Test Plan

- **Integration:** BA E2E login from client harness or documented manual checklist.
- **Regression:** reserved registration / system_key behavior preserved (port tests to BA fixtures in
  Phase 3–4).

### Rollback Strategy

Revert Phase 1; JWT remains production path.

---

## Phase 2: Staging backfill and migration framework

**Dependencies:** Phase 0 schema; Phase 1 client/admin design; **Waleed migration framework** available.

### Objectives

Port and harden **idempotent SQL** for user + account backfill; validate full cutover **rehearsal** on
staging **without** renaming production `users` yet (rehearsal uses clone DB or prefixed tables per
framework — plan documents chosen approach).

### Deliverables

- [ ] **Migration package location** (agree with Waleed): e.g. `packages/auth/drizzle/` cutover SQL or
  `scripts/migrations/better-auth-cutover/` with:
  - Name derivation SQL (spec rule: trim first+last → email local-part → `'User'`).
  - `INSERT … SELECT` column list (omit `is_admin`, `session_version`).
  - `account` backfill with `ON CONFLICT (user_id, provider_id) DO NOTHING`.
  - FK repoint statements for `threads`, `preferences`, `feedback`.
  - **`DROP TABLE tokens`** (explicit, not optional).
  - **`emailVerified` column** set per approved policy decision.
- [ ] **Staging rehearsal runbook** mirroring production steps 1–8 (spec) on a database clone.
- [ ] **Audits:** scripts or SQL for PK-set equality `users_legacy` vs `users` post-insert; row counts
  for `account` vs users with passwords.
- [ ] **Hand-written test DDL sync** if pglite suites need BA `users` shape (follow spec 4 Phase 3
  lesson: same-commit fixture updates).

### Acceptance Criteria

- [ ] Rehearsal completes on staging clone with all audits passing.
- [ ] Re-run backfill idempotency: second run produces zero duplicate `account` rows.
- [ ] No application code path reads `users_legacy` in rehearsal (simulated Phase 3 deploy).

### Test Plan

- **Integration:** migrated bcrypt users from staging snapshot log in via Better Auth.
- **Automated:** bcrypt verify branch removal test stub (must fail when branch deleted).

### Rollback Strategy

Drop clone DB; no production impact.

### Risks

| Risk | Mitigation |
|------|------------|
| FK repoint typo | Rehearsal + constraint verification queries |
| Framework drift from spec | Checklist against spec cutover sequence |

---

## Phase 3: Production cutover (single window)

**Dependencies:** Phase 2 rehearsal signed off; client releases ready; **DB snapshot** taken.

### Objectives

Execute the spec **Cutover window — ordered operations** in one maintenance window. Switch production to
Better Auth only; invalidate all JWT sessions.

### Production runbook (ordered)

**Preconditions**

- [ ] DB snapshot / PITR baseline recorded (rollback = restore snapshot, not dual auth).
- [ ] Client apps deployed or ready to ship **same release** (Better Auth login path).
- [ ] On-call and operator assigned; maintenance comms sent.

**Window steps** (align with spec; numbering matches spec where possible)

1. **Take `apps/api` fully offline** for the whole window (steps 2–9). Renaming `users` breaks every
   query against `public.users`, not only auth — e.g. `getSystemUserId()` / `system_key` on
   `/api/v1/chat/completions` and `/api/v2/mcp-complete`, admin stats in `lib/db/stats.ts`. Partial
   uptime → 500s and corrupts rollback (snapshot restore from before step 2 drops writes accepted while
   the API was still live).

   **`MAINTENANCE_MODE` is not sufficient:** `/api/v2/app-check` only **reports** maintenance to clients;
   it does not reject traffic (`apps/api/src/app/api/v2/app-check/route.ts`).

   **Runbook must name the real mechanism** (chosen and tested in rehearsal before prod). Examples only —
   pick what matches your hosting:

   - Stop or scale **`apps/api` to zero** (e.g. Railway service pause / remove from deploy).
   - Remove **`apps/api` from the load balancer** or disable public ingress until step 9 completes.
   - Any equivalent that guarantees **no HTTP handlers run** against the DB during steps 2–8.

   Record the chosen steps in `docs/better-auth-cutover.md` (or self-hosting) when ops confirms.

2. **`ALTER TABLE users RENAME TO users_legacy`** — FKs on `threads`, `preferences`, `feedback`,
   **`tokens`** now reference `users_legacy.id` (still valid).
3. **Create empty Better Auth `users`** (+ `session`, `account`, `verification` if not already present from
   Phase 0 migration in prod).
4. **`INSERT … SELECT`** from `users_legacy` → `users` (UUID, email, derived name, timestamps,
   `system_key`, `source`, `registered_via`; apply **`emailVerified` policy**).
5. **Backfill `account`** (credential provider, bcrypt copy from `users_legacy.password_hash`), idempotent
   `ON CONFLICT`.
6. **Repoint FKs** on `threads`, `preferences`, `feedback` to **`users.id`**.
7. **`DROP TABLE tokens`** — **required** (Amr PR #134 follow-up). JWT refresh/access storage must not
   remain as FK blocker for `users_legacy` drop later.
8. **Assign Better Auth admin roles** for every `ADMIN_EMAILS` entry **before** `apps/api` boots with new
   code — use Phase 1 assignment script. This satisfies admin boot assert ordering (replacement assert
   runs at step 9 deploy).
9. **Bring `apps/api` back** with application code:
   - Protected routes use **`auth.api.getSession({ headers })`** with **`Authorization: Bearer`**; JWT
     routes removed or return 410; Drizzle `users` model matches BA shape; **no Drizzle model for
     `users_legacy`**; remove `tokens` callers in `lib/db/users.ts`.
   - Sign-in / sign-up traffic to **`apps/auth`** (`/api/auth/*`); API traffic sends bearer token from
     step 2 of the client flow.
   - Enable **replacement** admin startup assert; remove `is_admin` checks from request path.
10. **Invalidate** legacy sessions (implicit once JWT validation removed and `tokens` dropped).
11. **Smoke tests:** login as migrated user, admin route, system account by `system_key`, thread ownership.

**Post-window**

- [ ] Monitor error rates on auth endpoints; rollback trigger = restore snapshot if mass login failure.
- [ ] Record cutover completion time (starts **14-day** `users_legacy` retention clock).

### Admin boot assertion (PR #134 #1 — explicit sequencing)

| Step | Action |
|------|--------|
| Wrong | Deploy `apps/api` that drops `is_admin` while `assertConfiguredAdminsExist` still checks `is_admin` |
| Wrong | Deploy new assert before BA admin roles exist |
| **Required** | Step 8 assigns BA admin roles → Step 9 deploys code with new assert + bearer `getSession` middleware |

Implement **`assertConfiguredBaAdminsExist`** (name TBD) in the same deploy that removes `is_admin`
from the schema/code path.

### Acceptance Criteria

- [ ] No production traffic served by JWT `v2/users/*` after window.
- [ ] Migrated users can sign in with existing password.
- [ ] `ADMIN_EMAILS` accounts pass startup assert.
- [ ] `users_legacy` exists, unread by application code.

### Test Plan

- Production smoke checklist (above); optional synthetic canary login every N minutes first 24h.

### Rollback Strategy

Restore DB snapshot from before step 2; redeploy previous application version. Do not run dual auth as
steady state.

---

## Phase 4: Decommission JWT and drop `users_legacy`

**Dependencies:** Phase 3 stable ≥ 14 days (see trigger below).

### Objectives

Remove dead JWT code, env vars, and tests; drop archive table when spec trigger conditions met; update
governance docs.

### Deliverables

- [ ] Remove `apps/api/src/app/api/v2/users/**` (register, login, refresh, logout, reset) and JWT
  middleware path.
- [ ] Remove `tokens` Drizzle schema and all references (table already dropped at cutover).
- [ ] Remove `session_version` usage; delete `scripts/grant-admin.ts`.
- [ ] **Turbo / config:** remove `JWT_SECRET`, access/refresh expiries from production contract; env
  convergence complete per spec.
- [ ] Rewrite admin authz tests for admin plugin + BA session.
- [ ] **`users_legacy` drop migration** when **all** true:
  1. ≥ 14 calendar days since cutover deploy success.
  2. PK-set parity audit (`users_legacy` vs `users`).
  3. No open rollback / incident requiring pre-cutover snapshot.
  4. **Operator sign-off** recorded in runbook.
- [ ] Update `codev/resources/arch-critical.md` per spec delta table.
- [ ] Close GitHub #16 with documented Better Auth session behavior.

### Acceptance Criteria

- [ ] Grep shows no production JWT verification path.
- [ ] `users_legacy` dropped in reviewed migration after trigger met.
- [ ] Full CI green.

### Test Plan

- Remove or replace JWT route tests; keep bcrypt-compat and ownership tests on BA fixtures.

---

## Phase 5 (optional): Hosting consolidation

**Dependencies:** Phase 4 complete; CORS/cookie story validated for single origin if desired.

### Objectives

Mount Better Auth on `apps/api` via `toNextJsHandler`; retire separate `apps/auth` service when ops
accept single deploy unit. **`apps/api` can still validate via bearer** even if login is colocated;
cookie-only cross-service auth is not required.

### Deliverables

- [ ] Spike: `/api/auth/*` on `apps/api` (handler mount + CORS/exposed headers for `set-auth-token`).
- [ ] Cutover doc for DNS / reverse proxy if service count changes.
- [ ] Decommission `apps/auth` deployment.

### Acceptance Criteria

- [ ] Parity with Phase 3 auth behavior in staging.
- [ ] No regression for Expo / web clients.

---

## Client compatibility checklist

| Client / surface | Legacy today | Required before Phase 3 |
|------------------|--------------|-------------------------|
| `prototypes/ansari-expo` | `/api/v2/users/*` + JWT bearer on API | Sign-in via `apps/auth`; store **`set-auth-token`**; **`Authorization: Bearer`** on `apps/api` |
| `apps/frontend` (if applicable) | verify grep | Same pattern unless a different client stack is agreed |
| Admin UI (`apps/api/src/app/admin/**`) | JWT bearer | Bearer session token after BA sign-in |

Document any **explicit exceptions** (unsupported clients deprecated at cutover).

## Test suite matrix (spec §8)

| Category | Phase | Action |
|----------|-------|--------|
| JWT route tests | 4 | Remove or replace |
| Admin authz | 3–4 | Admin plugin + BA session |
| System / registration guards | 3–4 | BA fixtures; anti-oracle preserved |
| Feedback / ownership | 3+ | Keep behavior |
| `bcrypt-compat.test.ts` | 0+ | Keep |
| BA E2E | 1+ | Add |
| Migrated-user bcrypt login | 2+ | Required on staging |
| Bcrypt branch removal test | 2+ | Must fail if branch removed |
| Origin / trustedOrigins | 1 | Only if proven to reject wrong **web** origins |

## Validation checkpoints

1. **After Phase 0:** exit criteria 1–4 green; UUID migration reviewed.
2. **After Phase 1:** primary client logs in against `apps/auth` in dev/staging.
3. **After Phase 2:** full cutover rehearsal on clone with audits.
4. **Before Phase 3:** snapshot playbook tested; admin role script dry-run; comms sent.
5. **After Phase 3:** 24h login success rate; no JWT traffic.
6. **Before `users_legacy` drop:** 14d + parity + sign-off.

## Documentation updates required

- [ ] **Cutover runbook** (this plan § Phase 3) in `docs/self-hosting.md` or dedicated
  `docs/better-auth-cutover.md`.
- [ ] **`emailVerified` policy** documented (chosen option A or B).
- [ ] **Env vars:** `.env.example` for `apps/auth`, `apps/api`, root — JWT vars marked deprecated then
  removed in Phase 4.
- [ ] **`packages/auth/README`:** UUID, dual verify, migration ownership.
- [ ] Retire spec 4 runbook lines referencing `grant-admin.ts` + `is_admin` bootstrap when Phase 4
  lands.
- [ ] Update spec/plan/review status when phases complete.

## Post-implementation tasks

- [ ] Confirm migrations committed; **human-applied** at deploy (never CI-applied to prod).
- [ ] Security spot-check: reserved emails, system_key routing, admin never email-match, cross-user
  ownership.
- [ ] Write `codev/reviews/60-better-auth-migration.md`.

## Risk register (summary)

| Risk | Phase | Mitigation |
|------|-------|------------|
| Mass lockout | 0, 2, 3 | Spike; staging rehearsal; bcrypt dual verify |
| Admin boot crash-loop | 3 | Steps 8→9 ordering; new assert |
| `emailVerified` future lockout | 2 | Policy decision A or B |
| `tokens` blocks legacy drop | 3 | Mandatory DROP in window |
| FK repoint error | 2, 3 | Rehearsal + audits |
| Clients on JWT | 1, 3 | Checklist + same release |
| Duplicate accounts | 0, 2 | Unique constraint + ON CONFLICT |
| Partial API uptime during rename | 3 | Full `apps/api` offline step 1; not MAINTENANCE_MODE alone |
| Password reset leaves sessions | 0 | `revokeSessionsOnPasswordReset: true` + test |
| Cookie assumed across hosts | 1, 3 | Bearer plugin + documented client flow |

## Approval

- [ ] Technical lead (Amr) — plan review
- [ ] Waleed — migration SQL framework alignment
- [ ] Operator — cutover window + rollback

## Change Log

| Date | Change | Reason | Author |
|------|--------|--------|--------|
| 2026-09-17 | Initial plan | Implement HOW for spec #60 / PR #134 | — |
| 2026-09-21 | PR #148 review | Bearer auth for apps/api, revokeSessionsOnPasswordReset, full API downtime, admin columns in Phase 0 | — |

## Notes

- **better-auth@1.6.27** behavior for `trustedOrigins` and custom schemes is fixed per spec; upgrade
  separately with re-probe.
- **Nologin / system accounts:** preserve lookup by `system_key` in `apps/api/lib/db/users.ts` (or
  successor module) — ensure migrated `system_key` additionalField remains server-only.
- **Reserved registration on BA sign-up:** port spec 4 anti-oracle behavior to Better Auth hooks before
  Phase 3.
- Phase commits may land in multiple PRs; **Phase 3 must not merge without rehearsal sign-off.**
