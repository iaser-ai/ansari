# Review: Better Auth migration

## Summary

Ansari's hand-rolled HS256 JWT auth is replaced by Better Auth, running in its own service
(`apps/auth`) with its own database. `apps/api` now only verifies `apps/auth`'s EdDSA JWTs. The
released mobile app keeps working through a `/v2/users/*` compatibility layer, whose frozen contract
passes unedited. Built in 13 plan phases, plus stacked frontend PRs 10b/10c (#309, #311, #312). The
result is one cutover PR to `develop` with an 18-step runbook, a tested copy, and rollback SQL. The
staging rehearsal, the window, and the contract PR (which drops the legacy columns) come after the
merge.

## Spec Compliance

The spec's success criteria have no IDs, so they are numbered here in order within each spec
sub-heading: SD schema/data, AR app rows, CS credentials/sessions, JWT, AZ authorization, CL
compatibility layer, FD frontend/deploy, RL rate limits, CORS, OPS cutover. Test scenarios use the
spec's own numbers. Under amendments R-1 and R-2, the branch is never deployed. Rehearsal evidence
therefore arrives after the merge, in a docs-only PR, and those criteria are left unchecked here,
with the finished part named.

**Schema and data**
- [x] SD-1: Every Better Auth table (`jwks` included) is on `pgSchema('auth')` in the auth DB: `users` by modelName, UUID ids, a UUID read back unchanged (Phase 2 — `packages/auth/tests/schema/auth-schema.test.ts`)
- [x] SD-2: Additional fields, admin columns and `impersonated_by` are present; no `system_key`/`source` in the auth DB (Phase 2 — `0000_auth_schema.sql`)
- [x] SD-3: `auth.account` has a unique `(user_id, provider_id)` (Phase 2; the backfill uses ON CONFLICT, Phase 12)
- [x] SD-4: A fresh `packages/auth` 0000 journal, with its own parity test and marker (Phase 2 — `auth-journal-parity.test.ts`; `AUTH_DEPLOYED_THROUGH=null` until cutover)
- [x] SD-5: The scaffold cleanup drops the #59 tables only when empty and aborts on any row (Phase 6 — `0009`; `window-migration.test.ts`)
- [x] SD-6: timestamptz columns survive the copy exactly, and a NULL legacy timestamp blocks the copy (Phases 2, 12 — `apps/auth/tests/cutover/copy.test.ts`; 68aef71)
- [x] SD-7: The cross-DB copy runs as ordered, gated steps (normalized export, guards, insert, audits, TEMP table, no file, operator shell only) (Phase 12 — `02-import-auth.sql`, `copy.sh` image-marker guard; PG18 image e2e)
- [x] SD-8: The window migration only normalizes email (aborting on a collision) and drops NOT NULL on `password_hash`; FKs are unchanged (Phase 6 — `0011`; window-migration.test checks pg_constraint before and after)
- [x] SD-9: New code never touches the legacy columns or `tokens`; the scan is negative-tested (Phase 9 — `apps/api/tests/source-scan/`, 0 hits / 77 files)
- [ ] SD-10: The contract migration drops the legacy columns and `tokens` with its own `DEPLOYED_THROUGH` bump — deferred to the contract PR (after the 24 h rollback deadline)
- [x] SD-11: Name derivation: first+last, then the email local-part, then `User` (Phases 3, 12 — `deriveName`; copy.test scenario 7)
- [ ] SD-12: The rehearsal audit reports the guest-shape count — the preflight query and its tests exist (Phase 12); the run is at the post-merge staging rehearsal
- [ ] SD-13: Post-copy audits pass — `03-audit-*` and `05-audit-admins-auth.sql` are tested in copy.test and the PG18 image run; the real pass is at the rehearsal and the window
- [x] SD-14: Re-running the account backfill creates zero duplicates (Phase 12 — copy.test scenario 10)
- [ ] SD-15: Email is normalized and collisions are decided before the window — guards and the all-row preflight are built and tested (Phases 6, 12); the preflight against production and the collision decisions are owner-owed (R-1)
- [ ] SD-16: `DEPLOYED_THROUGH` moves once per app migration — numbering was re-checked after every develop merge; the marker is still `0008_model_provenance` and is bumped by the owner's assertion in the cutover PR
- [x] SD-17: pglite DDL naming the dropped columns is updated where new code needs it, coordinated with #292 (Phase 9)
- [x] SD-18: Two databases enforced: no cross credential, no `APP_`/`AUTH_DATABASE_URL` in runtime code, no fallback URL (Phase 9 — source scan, 0 hits / 102 files)

**App rows, deletion, system accounts**
- [x] AR-1: The app row is created at layer registration or on first use from the profile (ON CONFLICT); concurrent requests make one row (Phases 7–8 — `resolve-user.test.ts` 9c, `layer.test.ts`)
- [x] AR-2: An unknown or tombstoned `sub` gets 401 and no row (Phase 7 — resolve-user.test; in-transaction tombstone re-check, 583b045)
- [x] AR-3: An address held elsewhere, a reserved domain, or a `system_key` holder → 401, ids-only log, alert (Phase 7 — resolve-user.test 9f)
- [x] AR-4: The internal delete refuses no JWT, an invalid JWT or another `sub` (Phase 5 — `apps/auth/tests/internal.test.ts` 9g)
- [x] AR-5: Internal routes: constant-time credential, outside the Better Auth handler, rate-limited, on a private listener (Phases 4–5 — internal.test, client-ip.test)
- [x] AR-6: `DELETE me` refuses system accounts, then one transaction (row + tombstone), then the auth delete; a failure is completed later (Phase 8 — layer.test 9/9b; resolve-user.test 9a)
- [x] AR-7: System accounts are created lazily in the app DB, never in the auth DB (Phase 9; copy.test 20)
- [x] AR-8: change-email and update-user are blocked on `apps/auth`, path variants included (Phases 3–4 — `blocked-paths.test.ts`, `options.test.ts`); change-password too, amended in review (9d3e93e)

**Credentials and sessions**
- [x] CS-1: Permanent dual verify: bcrypt `$2a$`/`$2b$` with 72-byte behaviour; scrypt otherwise and for new hashes (Phase 3 — `packages/auth/tests/config/credentials.test.ts`)
- [x] CS-2: A migrated legacy user signs in unchanged, directly and via `/v2/users/login` (Phases 8, 12 — layer.test scenario 1; copy.test 13)
- [x] CS-3: `revokeSessionsOnPasswordReset` is on, and removing it fails a test (Phases 3, 5 — see "Removal demonstrations" below)
- [x] CS-4: 30 d sessions with a 1 d `updateAge`; the `/token` exchange slides the expiry (Phase 3 — `options.test.ts`, `tokens.test.ts`)
- [x] CS-5: No HS256 or legacy-column code; grant-admin lives in `apps/auth/scripts/` and sets the role; no better-auth dependency in `apps/api` (Phase 9 — source scan 3)
- [x] CS-6: No admin-plugin endpoint answers (`disabledPaths` plus a case-insensitive middleware; enumerated from the package) (Phase 4 — blocked-paths.test)

**JWT issuance and verification**
- [x] JWT-1: EdDSA, explicit `iss`/`aud`, 15 min, payload `{sub, sid}` only, exact key set pinned (Phase 3 — tokens.test)
- [x] JWT-2: The verifier pins alg/iss/aud/exp; none, other algs, wrong iss/aud, expired, bad signature, unknown key and HS256 each get 401 (Phase 7 — `apps/api/tests/auth/verify-jwt.test.ts`)
- [x] JWT-3: An unknown `kid` triggers at most one rate-limited re-fetch; rotation needs no restart (Phase 7 — verify-jwt.test 17, 24)
- [x] JWT-4: With `apps/auth` unreachable, a valid JWT verifies from cache, with the stale-key grace (Phase 7 — verify-jwt.test 18)
- [x] JWT-5: A `sub` with no row, unknown or tombstoned, gets 401, never an FK 500 (Phases 7–8)
- [x] JWT-6: The revocation window (logout, reset, ban, delete; ≤ 900 s) is pinned and recorded as an accepted cost (Phase 8 — layer.test revocation table)

**apps/api authorization**
- [x] AZ-1: Every authenticated route uses the verified JWT; ownership is unchanged; admin asks the role endpoint per request, 503 on an outage (Phase 8 — layer.test route sweep, `require-user.test.ts`)
- [x] AZ-2: Leaderboard and `mcp-complete` behave as before; no global `middleware.ts` (Phase 8)
- [ ] AZ-3: Existing admins are preserved — the inventory, `grant-admin --revoke` and the `05` audit are built (copy.test 16); the owner-approved list and the run happen at the window
- [x] AZ-4: `apps/auth`'s production boot asserts that `ADMIN_EMAILS` hold `role=admin` (Phase 5 — `startup-checks.ts`, grant-admin.test)

**Compatibility layer**
- [x] CL-1: Contract tests written first pass unedited against the layer (Phases 1, 8 — `legacy-users-contract.test.ts` 58/58; SHA-256 pin in `contract-frozen.test.ts`)
- [x] CL-2: The layer reaches Better Auth only over HTTP (Phase 8 — `lib/auth-service/legacy.ts`; source scan)
- [x] CL-3: Token mapping: access = JWT, refresh = session token; refresh returns the same session; 401 when revoked (Phase 8)
- [x] CL-4: `requireSignature` is unset and pinned (Phase 3 — tokens.test)
- [x] CL-5: Logout revokes all sessions via G-3 `revoke-sessions` (Phases 5, 8)
- [x] CL-6: `DELETE me` works with a 25 h session via the internal endpoint, in the rule-5 order (Phase 8 — layer.test 9)
- [x] CL-7: Password reset: legacy link shape, the same answer for unknown emails, per-IP and per-email caps, secret minimums, no mail for system accounts, the token checked before strength (Phases 3–5, 8 — `reset.test.ts`, `limits.test.ts`, `secrets.test.ts`)
- [x] CL-8: Reserved and `system_key` addresses get the identical 409 on the layer and in `apps/auth`'s hooks, guard order unchanged (Phases 3, 8 — `sign-up.test.ts`, layer.test 19)
- [x] CL-9: `registered_via` is recorded in both DBs; names reach the newsletter; login returns names (Phases 3, 8)
- [ ] CL-10: Clients run unmodified in staging (released mobile build, admin analytics login) — at the post-merge rehearsal (`rehearsal.md` Part C)
- [x] CL-11: Machine callers and users cannot be confused in either direction (Phase 8)

**apps/frontend and apps/auth deployment**
- [x] FD-1: `apps/frontend` signs in, signs up, resets and signs out against `apps/auth`, bearer only, no third-party cookies (Phase 10 + 10b/10c — #309, #311, #312, each approved by the app architect after a real-path iOS Simulator run; `frontend-client.test.ts`)
- [ ] FD-2: Dockerfile, Railway service with its own Postgres (PITR), `packages/**` watch paths, DB-gated health — the repo side is done (Phase 11: Dockerfile, `railway.toml` record, `/health` 503 on a dead DB); the dashboard configuration is owner-owed (C-4)
- [ ] FD-3: `apps/auth` is not public before the window, its domain is attached last, and unreachability is proven — runbook steps exist (Phase 12); the check happens in the window
- [x] FD-4: `apps/auth` CORS allows exactly the web origins and exposes `set-auth-token`/`jwt`; `trustedOrigins` matches (Phase 4 — `public-face.test.ts`)

**Rate limiting and client IP**
- [x] RL-1: Database-backed limits, sign-in 5/60 s, sign-up 3/60 s, `ipAddressHeaders: ['x-real-ip']` (Phase 3)
- [x] RL-2: 429 directly and through the layer, from one shared budget (Phase 8 — layer.test 21)
- [x] RL-3: Bucketing by `X-Real-IP`; a forged XFF cannot switch buckets (Phases 4, 13 — client-ip.test; tests derived from the edge-shape fixtures)
- [x] RL-4: Internal hop: distinct client IPs get distinct buckets; a forwarded IP without the credential is ignored (Phases 4, 8 — layer.test 22)
- [x] RL-5: `apps/api`'s `getClientIp` reads `X-Real-IP` only; the old test is inverted (Phase 7)
- [ ] RL-6: Empirical edge verification is recorded — the passive pre-merge production check is done (fd02f99, `docs/cutover/edge-check.md`); the staging probes (both paths, two networks) and the in-window production probes are deferred (R-2, G-2)
- [ ] RL-7: The fallback behind `AUTH_RATE_LIMIT_MODE` is built and pinned (Phase 4 — limits.test); "production ships in the staging-verdict mode" waits on the staging verdict

**CORS on apps/api**
- [x] CORS-1: No credentials, `Allow-Origin: *`, the required Allow-Headers (amended in phase 9) (Phase 9 — `apps/api/tests/cors/cors.test.ts`, a real Next server, 69 tests)

**Cutover and operations**
- [x] OPS-1: The cutover runbook covers downtime, deploy order, baselines, copy, audits, window migration, roles, domain, smoke tests and the 24 h rollback (Phases 12–13 — `docs/cutover/better-auth-cutover.md`, 18 steps; `rollback.md`; `cutover-docs.test.ts`)
- [ ] OPS-2: Full rehearsal, rollback included, on seeded staging users after the merge (R-1/R-2) — the seed (`rehearsal-anomalies.ts`) and the procedure (`rehearsal.md`) are built; the run and its evidence come in the docs-only evidence PR
- [ ] OPS-3: RELEASE.md and CONTRIBUTING cover the two databases (done, Phases 11–12, `release-doc.test.ts`); the applied SQL is recorded with commits at the window
- [ ] OPS-4: RELEASE.md names the contract exception, the freeze, the auth service, the smoke and admin-bootstrap steps — the cutover-PR part is done (Phase 12); the contract PR amends it
- [ ] OPS-5: After cutover, migrated users sign in, the released mobile build works, and there is no mass reset — post-window verification
- [x] OPS-6: arch-critical.md, arch.md and `packages/auth/README.md` are updated, with stale statements fixed everywhere (Phase 12)
- [ ] OPS-7: Follow-up issues (layer removal, profile sync, guest cleanup) are filed, and #16/#49 are closed — not yet filed; listed under Follow-up Items for the verify phase, and #16/#49 close after the cutover

**Test scenarios**
- [x] 1, 2, 3, 4, 5, 6: legacy login with the same id and threads; direct sign-in, then JWT use; scrypt registration on both paths; legacy mobile refresh flow; the admin matrix with demotion and outage; reset with the legacy link (Phases 1, 3, 5, 7, 8, 10)
- [x] 7, 8: derived names; a >72-byte password on a bcrypt hash (Phases 3, 12)
- [x] 9, 9a, 9b, 9c, 9e, 9f, 9g, 9h, 9i, 9l: delete with a 25 h session; pending-tombstone completion; system-account refusal; first-use rows; cross-DB scan; held-address refusal; internal delete binding; hash tamper audit; no verification email; scan plants (Phases 5, 7, 8, 9, 12)
- [ ] 9k: Rollback rehearsal — the rollback SQL is tested in pglite and the PG18 image e2e (Phases 12–13); the staging run (`rehearsal.md` Part E) is post-merge
- [x] 10–17: idempotent backfill; both journals from fresh DBs; DST/microsecond timestamps; normalization; the Bob/bob collision; scaffold-cleanup guard; admin inventory; JWKS rotation (Phases 2, 6, 7, 12)
- [x] 18–26: outage behaviour; identical 409s; system accounts; shared 429 budget; layer buckets; JWT rejection matrix; kid flood; thread ownership; machine callers (Phases 4, 5, 7, 8)
- [x] 27: removing the bcrypt branch or `revokeSessionsOnPasswordReset` fails a named test (Phase 3 — recorded below)
- [x] 28, 29, 30: CORS on both services and admin path variants; raw-session-token mint; exact JWT claims (Phases 3, 4, 9)
- [ ] 31: `apps/auth` is unreachable before its domain is attached, and works after — in-window only
- [x] 32, 33: IP fallback mode; no per-request network hop in steady state (Phases 4, 7)
- [ ] 34: Copy, audit and window-migration timings fit the window — at the staging rehearsal, scaled to the production row count (`rehearsal.md` Part B)

### Accepted residuals (security review of the cutover PR)

- **The admin startup check runs only under `NODE_ENV=production`.** `apps/auth`'s boot assertion
  that every `ADMIN_EMAILS` address holds the admin role is skipped in any other mode, so a
  Railway override of `NODE_ENV` would disable it silently. The image sets
  `NODE_ENV=production`; the dashboard must not override it.
- **The JWKS signing key has no `rotationInterval`.** `apps/auth` signs with one long-lived Ed25519
  key. Rotation is a manual operation (a new key; the old one keeps verifying through the JWKS
  cache), and it is never a revocation mechanism (arch-critical).
- **The `/token` 401 delete path is covered by unit tests only.** The F3 simulator run covered an
  expired JWT and a `/token` 5xx, but not a `/token` 401.

### Removal demonstrations (scenario 27)

Phase 3, one mutation at a time with the suites run and the file restored: 28 mutations, 28 caught.
Scenario 27's two:

- **bcrypt branch removed** from the dual verifier: 17 tests fail in
  `packages/auth/tests/config/credentials.test.ts` (`$2a$`/`$2b$`, the >72-byte case, mixed case).
- **`revokeSessionsOnPasswordReset` removed**: `credentials.test.ts` › "password reset" › "a reset
  kills every live session: the old session token can no longer mint a JWT" fails, as does the flag
  pin in `options.test.ts`.

Each later phase ran its own removal-fails pass; the thread lists them per phase.

### Accepted behaviour changes on the legacy surface (phase 8)

The `/v2/users/*` compatibility layer passes the phase 1 contract suite unedited. Its fixtures and
assertions are pinned by SHA-256 to phase 1's commit `60b1118`
(`apps/api/tests/contract/contract-frozen.test.ts`); main accepted the pin in place of a CI diff
step. On 2026-10-16 the security architect accepted five responses the legacy surface did not give
before. None is pinned by the contract; each has a test in `apps/api/tests/auth/layer.test.ts`. The
spec records them under "Departures and their costs".

1. **429 passthrough.** `login`, `register`, `request_password_reset` and `reset_password` answer
   429 `{detail: 'Too many requests. Please try again later.'}` with `Retry-After` when `apps/auth`'s
   limiter refuses, so the shared database-backed budget holds through the layer.
2. **503 on an `apps/auth` outage.** `{detail: 'Authentication service unavailable'}`, never a
   credentials error, on the layer routes, first-use app-row creation and admin role checks.
3. **8-character minimum on reset.** Better Auth's `minPasswordLength` refuses a strong 7-character
   password the legacy route accepted. The answer is the legacy weak-password detail.
4. **`register` refuses any `public.users` holder** of the address with the identical 409. (The
   plan said `system_key` rows only.) This way the app insert cannot fail after `apps/auth` has
   created the user.
5. **System-account `DELETE /v2/users/me`** answers 403 `{detail: 'System accounts cannot be
   deleted'}` before anything is touched ("Two databases" rule 5, step 1).

### Source scans and CORS (phase 9)

The scans live in `apps/api/tests/source-scan/` and read code through the TypeScript parser, so a
name in a comment never counts. Each is proven in the same suite on planted known-bad lines and on
near-misses, and each asserts a file floor so an empty walk cannot pass. Hit counts on the tree at
phase 9:

| Scan | Files scanned | Hits |
|---|---|---|
| 1. `password_hash`, `is_admin`, `session_version`, the `tokens` table, or `SELECT *` on `users`, in a string or template literal (raw SQL) in `apps/api` runtime code | 77 | 0 |
| 2. `APP_DATABASE_URL` / `AUTH_DATABASE_URL` named in code, or a literal `postgres://` URL, in `apps/api` and `apps/auth` runtime code (`packages/auth/src` included; `apps/auth/scripts/cutover/` excluded by path, and a test proves only that directory) | 102 | 0 |
| 3. A `better-auth`, `@better-auth/*` or `@ansari/auth` import in `apps/api` runtime code | 77 | 0 |
| 3. The same packages in `apps/api/package.json`'s dependency maps | 1 | 0 |

Scan 1 guards raw SQL only. The Drizzle query builder can no longer name the legacy columns or
`tokens`, because they left `db/schema`, and the typecheck enforces that. The legacy helpers that
used them were query-builder code, so scan 1 would not have flagged them before phase 9 either.

**CORS on `apps/api` (scenario 28, amended).** The security architect chose a static
`Allow-Origin: *` with `Allow-Credentials` removed over a per-environment allowlist (spec,
"Departures and their costs"). `apps/api/tests/cors/cors.test.ts` boots a real Next.js server over a
temporary copy of `apps/api` that uses the real `next.config.ts`. It sweeps all 23 route files ×
every exported method, preflight and actual request (69 tests), and judges each response by the
Fetch standard's CORS check: a bearer request from any origin passes, a credentialed one is refused,
and no response carries `Allow-Credentials`.

**Removal/plant demonstration (phase 9): 20 of 20 as expected**, one at a time, each file restored:
- CORS: credentials planted; Authorization, X-Ansari-Client and PATCH dropped; origin pinned to one
  site.
- Boot env check: instrumentation call removed; never runs; runs during `next build`; validation
  removed; production no longer requiring `AUTH_*`.
- Scan 1: a legacy column, the `tokens` table and `SELECT *` on users planted in `lib/db/users.ts`.
- Scan 2: `AUTH_DATABASE_URL` in apps/auth src; a `postgres://` literal in packages/auth src;
  `APP_DATABASE_URL` in an apps/auth script; the exclusion widened to all scripts. Control: the same
  line under `scripts/cutover/` passes.
- Scan 3: a `better-auth` re-export in apps/api lib; an `@ansari/auth` dependency.

### Phase 13 evidence (owner amendments R-1, R-2)

**Pre-merge, done in phase 13:**
- the anomaly seed `apps/auth/scripts/cutover/rehearsal-anomalies.ts` (eight rows, the non-bcrypt
  row included), with its abort/pass order tested in pglite
- the copy's refusal of non-bcrypt hashes, and the preflight's hash-format counts
- Postgres 18 everywhere, proven end to end in the rebuilt auth image against a `postgres:18`
  container (the counts are in the thread)
- the edge probe on both paths (via Cloudflare and direct, `-4`/`-6`), with the extended probe
  fields
- the provisional edge-shape fixtures, read by both services' tests, with a guard that keeps them
  from shipping as evidence
- the runbook's Staging rehearsal section, and `rehearsal.md` (the procedure)
- B-1 to B-4 in `docs/cutover/baselines.md`, before the merge (G-4), with any `limits.ts`
  amendment in the cutover PR: _pending, owner_

**Filled in by the docs-only evidence PR after the staging rehearsal.** Under R-2 the branch is
never deployed; staging runs the window from the cutover PR's `develop` merge commit. Counts,
checksums and timings only:

| Evidence | Where it is recorded | Result |
|---|---|---|
| `develop` merge commit rehearsed | `docs/cutover/rehearsal.md` Part F | _pending_ |
| Guards fire: collision abort, NULL abort, non-bcrypt abort, then the pass | `rehearsal.md` Part A | _pending_ |
| Audits, both sides (six lines) | `rehearsal.md` Part B | _pending_ |
| Step timings; the scaled copy; comms allowance (3×) | `rehearsal.md` Part B | _pending_ |
| Unmodified clients (released mobile build, admin analytics) | `rehearsal.md` Part C | _pending_ |
| Stored-guest sign-in: same id, same threads, no sign-up (G-5) | `rehearsal.md` Part D | _pending_ |
| Rollback rehearsal (scenario 9k) | `rehearsal.md` Part E | _pending_ |
| Edge check, both paths, two networks; staging verdict | `docs/cutover/edge-check.md`; `rehearsal.md` Verdicts | _pending_ |
| Measured shapes replace the provisional fixture | `docs/cutover/edge-header-shapes.json` | _pending_ |

### Owner amendment at the pr gate: the internal hop removed (spec H-1 to H-6)

The owner removed `AUTH_INTERNAL_SECRET` and the internal hop in this PR ("no tight coupling");
`apps/api` now reaches `apps/auth` like any client, at its public origin (`AUTH_URL`; the issuer
`AUTH_JWT_ISSUER` stays separate, owner). The security architect set R1 to R3 and approved the
`DELETE` order; R2 was decided with main.

- [x] **H-2: account endpoints** bound to the caller's own JWT and a live `sid`
  (`apps/auth/src/routes/account.ts`): `GET /api/account/me`, `POST /api/account/revoke-sessions`,
  `DELETE /api/account` (204 first when the user is already gone). `account.test.ts`: the forged
  token matrix on all three (foreign key, swapped payload, `alg: none`, HS256, wrong `iss`/`aud`,
  expired, no `sid`, non-UUID `sub`, session token), dead `sid` → 401 on `me` and revoke, expired
  session row, another user's live `sid`, each `DELETE` branch (security's list: dead `sid` with a
  live user → 401 and nothing changes; gone user → 204 and nothing changes; live → deleted, sessions
  gone, second call 204), planted keys (no `exp`, RS256), the per-user budgets, an auth-database
  outage → 500 on all three (found on the way: the JWKS read sat inside the token `try`, so an
  outage read as 401; fixed and pinned).
- [x] **H-3: public JWKS**, no credential (`verify-jwt.test.ts` asserts no `x-ansari-*` and no
  `authorization` header on the fetch, and that the issuer is pinned as set, not derived).
- [x] **H-4 / R1: no per-IP rule on any layer path.** `ROUTER_RULES` are all `false` (better-auth
  1.7.7 `resolveRateLimitConfig` returns before choosing a bucket on `false`, so the default is
  skipped too; read in `dist/api/rate-limiter/index.mjs`). `limits.test.ts` "the layer's view":
  101 sign-ins and 101 token exchanges from one IP across two users, no 429 and no per-IP row; from
  the same IP the per-email lock and the per-session budget still trip. **Shown to fail** with
  `/sign-in/email` removed from `ROUTER_RULES` (2 failures), and to pass restored.
  `packages/auth` `rate-limit.test.ts`: each of the six paths takes `DEFAULT_RULE.max + 1` from one
  IP with no 429; `/ok` keeps the default (429 at 101). `apps/api` limits the layer per
  `X-Real-IP` (`lib/auth-service/limits.ts`); `layer.test.ts` proves the sixth login is 429 before
  `apps/auth` is called, two IPs two buckets, the per-email lock behind it, no forwarded IP or
  credential on any layer call, and the whole legacy cycle against production-mode `apps/auth`
  behind a stand-in edge that stamps `apps/api`'s one IP (the only per-IP row it leaves is
  `…|/jwks`). Owner: TEMPORARY until the legacy system is replaced.
- [x] **`deleteAuthUser(sub, jwt)` refuses a token that is not the subject's own** before any call
  (`NotTheSubjectError`). Found while converting `resolve-user.test.ts`: with the account endpoint
  deleting the token's subject, a mismatched token in the pending-delete retry would have deleted
  the wrong account. No current caller passes one; the guard is the backstop, tested.
- [x] **H-5 / R2:** the runbook attaches `auth.askansari.ai` at step 11 (after step 10, before
  step 12), with the DNS record checked at step 1, `/health` 200 over a valid certificate, the
  JWKS, `/internal/…` 404, `/api/account/me` 401, and the auth edge probe moved there; step 15 is
  "(moved to step 11)"; rollback step 5 and the staging table updated; `cutover-docs.test.ts` pins
  the order.
- [x] **H-6 / R3:** the runbook's "Orphan app rows" section (the `email-conflict` alert, the audit,
  the one-transaction cleanup); `rehearsal.md` records it as an owner-accepted residual with a
  staging check; `resolve-user.test.ts` reproduces the refusal and runs the documented statement to
  clear it. The psql form was run through real psql 18: the orphan prints `INSERT 0 1`, a system row
  `INSERT 0 0` and is untouched.
- [x] **Source scan 4** (planted-bad and near-miss lines, a file floor): no runtime file or config
  names the removed hop. Repo-wide, the remaining hits are test files that name it on purpose
  (planted lines, absence checks), the historical thread and plan phases, and docs sentences that
  say it is gone.
- [x] **Turbo** (main): `globalEnv` drops `AUTH_INTERNAL_SECRET`, `AUTH_INTERNAL_URL`,
  `INTERNAL_PORT` and `AUTH_RATE_LIMIT_MODE` and adds `AUTH_URL` (four-way: in `apps/api`'s Zod
  schema; no static or dynamic `process.env` read, which the eslint guard forbids; documented in
  `docs/self-hosting.md` and `.env.example`). `--dry=json`: `AUTH_URL` a → b moves
  `ansari-api#test`, `ansari-api#build` and `ansari-auth#build`, and a again restores all three;
  `AUTH_INTERNAL_SECRET` x → y moves none. Dockerfile `EXPOSE 3100`; `railway.toml` one port.

### Security review batches 4 and 5, on the amendment (and the 3-way consult round 2)

- [x] **A, the `/token` spray.** The limiter counts only a bearer shaped like better-auth 1.7.7's
  session token (`generateId(32)`, 32 of `[A-Za-z0-9]`, `internal-adapter.mjs`), or its signed
  form `<token>.<HMAC-SHA256>` with the signature verified under `BETTER_AUTH_SECRET`. better-call's
  `signCookieValue` uses standard padded base64, URI-encoded; base64url is accepted too. It keys
  on the 32-character token, so both forms of one session share a bucket.
  `limits.test.ts`: 50 random or mis-signed bearers write no row, and the signed form spends the
  unsigned form's budget. **Residual, recorded:** a spray of well-formed unsigned 32-character
  values still writes one row each, because the bearer() plugin signs an unsigned value itself, so
  its shape is all there is to check before the session lookup.
- [x] **B.** `/get-session` is out of `ROUTER_RULES`, so the router's per-IP default applies (the
  layer never calls it). Tested in both packages.
- [x] **C.** The account routes' key set is cached in process: at most one read per 60 s on an
  unknown `kid`, re-read after 10 min. Tests: 20 garbage or unknown-`kid` tokens cost one read; a
  new key verifies once 60 s have passed; the max age is honoured.
- [x] **D (owner, after the baselines).** Per-IP ceilings on the layer paths, `max(600/min,
  10 × B-4)` for sign-in and `/token` and `10 × B-1` for sign-up, are proposed in `limits.ts` and
  not built.
- [x] **E.** `rehearsal.md`'s environment note, Part B and timing table follow the runbook's
  step 11. `cutover-docs.test.ts` checks that every timing-table row names its runbook heading
  (shown to fail on the old label).
- [x] **F.** Runbook step 9's check asserts `to_regclass('public.deleted_users') is not null` and
  that `password_hash` is nullable, so a skipped `0010` or `0011` cannot pass into step 12.
- [x] **G.** `apps/api` has no per-IP limit on `refresh_token`. The released client signs out on
  any non-OK refresh: `legacy/frontend-app/src/services/ApiService.ts:81-87` (`if
  (!response.ok) { removeTokens(); resetAuthCallback(); throw }`), so a per-IP 429 shared behind a
  carrier NAT would sign out everyone behind it. apps/auth's per-session cap remains.
  `layer.test.ts`: 80 refreshes from one address all return 200.
- [x] **H (security decided option 2).** `SIGN_IN_FAILED_ALERT` (30/min until B-4) counts failed
  sign-ins across every email. At the threshold it sends one Sentry event per window across
  instances, carrying counts, the per-minute rate, distinct emails and hash prefixes, ids only. It
  refuses nothing. The refusal ceiling is documented in `limits.ts` as an owner option, not built,
  with its outage trade-off. `limits.test.ts`: a spray of one failure per email fires exactly once
  and refuses nothing (a correct password still signs in), fires again in the next window, and
  correct sign-ins are never counted.
- [x] **I.** `rollback.md` states that every client that signed in during the window is signed out
  once and signs in again with the legacy password. Its step 6 and `rehearsal.md` Part E check one
  such client.
- [x] **J.** The PR body is rewritten for H-1 to H-6. The temporary per-IP choices point at **#318**
  (layer removal, filed).
- **Contract shapes on `/v2/users`.**
  - 503, in `layer.test.ts`: "apps/auth unreachable: 503, never a credentials error" and "every
    layer route answers 503 with the legacy detail when apps/auth is unreachable".
  - 429: "every 429 has the legacy shape: the detail and a Retry-After, from apps/api and from
    apps/auth alike", and "login … is 429 at apps/api, before apps/auth".
  - The harness-only token lifetime (2 h to 15 min) under the frozen assertions is the spec's
    design (I-7), not a contract change.
- **Gitleaks.** CI's secret scan had failed since fad62e8 on five dummy values. d031ee8 pins them
  by fingerprint, following `.gitleaksignore`'s convention, and was verified locally with
  gitleaks 8.24.3 through the CI script. I had not checked CI before calling the PR ready.
- **Notes (security):**
  - `apps/api`'s `getClientIp` falls back to `127.0.0.1` when `X-Real-IP` is absent, so such
    requests share one layer bucket. **Kept:** behind the edge the header is always stamped, so a
    missing one is a misconfiguration or a request that bypassed the edge. A shared bucket
    throttles exactly those together, which fails closed and shows up loudly, and local
    development keeps working. A 400 would also fail closed, but it would break local
    development and the contract harness for no production gain.
  - The per-instance store is cleared whole above 10 000 keys (`lib/rate-limit.ts`, pre-existing).
    It now carries the layer's per-IP limits, so an attacker rotating through more than 10 000 IPs
    resets every bucket on that instance. **Residual of Option A, until #318.**
  - An admin whose session was revoked gets **403** ("Admin access required"), not 401, from
    `requireAdmin`: `GET /api/account/me` answers 401, which reads as "no account", so the
    route denies. Acceptable, because access is denied either way.

### Owner amendment H-7: `ADMIN_EMAILS` removed

The owner removed `ADMIN_EMAILS` from `apps/auth`: the role in `auth.users` is the only admin
truth, and a stale list could take sign-in down at boot. The security architect set the
conditions and signed off on the contract re-pin; main's guard is that `backend` keeps its
legacy variable until the contract PR.

- [x] Gone: the env key, the configured-admin reservation (`reserved.ts` keeps the system domain
  only), `apps/auth/src/startup-checks.ts` and its boot call, the template line, and the
  `globalEnv` entry. `--dry=json`: `ADMIN_EMAILS` x → y moves neither `ansari-api#test` nor
  `ansari-auth#build`.
- [x] `grant-admin.ts`, two steps. `<email>` shows id, email, `created_at`, `email_verified` and
  role, grants nothing, and exits 2. `<email> --confirm <id>` grants exactly that account and is
  idempotent. A wrong or made-up id grants nothing (`ConfirmMismatchError`). It never creates an
  account and refuses the system domain. It warns on an account under 7 days old or with an
  unverified address (copied legacy admins are verified and old). Tests in `grant-admin.test.ts`
  cover each of these, plus the 7-day boundary.
- [x] Runbook step 10: show, then `--confirm <id>`, then `05-audit-admins-auth.sql`, which must
  print exactly the approved list. No `ADMIN_EMAILS` to set and **no `auth` redeploy**, so the
  window has one fewer. Step 6 has no "empty `ADMIN_EMAILS`" any more. The precondition that
  `backend` keeps `ADMIN_EMAILS` among its legacy variables until the contract PR stays, and
  `cutover-docs.test.ts` ("keeps the legacy variables on backend for the rollback (R3)") pins it.
  RELEASE.md's contract-PR line still lists it.
- [x] **Frozen contract, re-pinned once.** The case "refuses a configured admin address with the
  IDENTICAL 409, in any case" is deleted (11 lines, nothing else in the pinned body).
  `ASSERTIONS_AT_PHASE_1` moved to `eb100e85…` with a dated note; the preamble hash is unchanged.
  The system-domain identical 409 stays covered in the frozen file: "refuses a reserved system
  address with the IDENTICAL 409 a taken email gets", and the guard-order case "a reserved address
  with a weak password gets 409, not 400".
- [x] Source scan 4 names `ADMIN_EMAILS`, with two planted lines and two near-misses.
  `self-hosting-docs.test.ts` now pins "no boot admin check" and the two-step grant in place of
  the old crash-loop triage.

### Owner amendment H-8: the cutover runs from the owner's machine over Tailscale

The owner's review asked to keep Postgres tooling out of the service image and to run the
one-off cutover over their Tailscale connection to Railway. Security accepted, with conditions 1
to 7, and main added a to e. This supersedes the earlier "inside the auth image only" ruling.

- [x] `operator-env.sh`, sourced by `copy.sh` and `complete-tombstones.sh`, refuses before any
  database call:
  - an unset, empty or identical URL;
  - a host that is not `<name>.railway.internal`: the public proxy `*.proxy.rlwy.net` is refused,
    and so is any other host, a bare IP, or a near-miss like `….railway.internal.evil.com`;
  - a `psql` that is not major 18;
  - a missing `PROMOTED_COMMIT`, a HEAD other than it, or a dirty checkout;
  - stdout that is not a terminal.

  It warns when a URL has no `sslmode=require`. `copy.test.ts` negative-tests each refusal
  against a throwaway clean checkout with a fake `psql`, and asserts that no URL is echoed and
  `psql` is never called. A positive run under a real pseudo-terminal (`script`) gets past the
  check.
- [x] The rehearsal seed checks the same host and checkout, and needs `ANSARI_CUTOVER_ENV=staging`.
  Railway's own variables prove nothing, because a laptop shell injects them. That is tested.
- [x] The Dockerfile is back to the service image: no PGDG, no psql, no `apps/api/drizzle` copy
  or chmod, no marker, and the comment no longer calls it the operator environment. The full
  install stays because `grant-admin.ts` and `ban-user.ts` also run in it. `railway.toml` and
  RELEASE.md's watch line drop `apps/api/drizzle/**`, while `apps/auth/turbo.json` keeps it as a
  test input, because `copy.test` builds the app database from it.
- [x] Runbook:
  - the operator-environment section covers the Tailscale route, the clean checkout, `set +o
    history`, `read -rs` for both URLs, the host rule, the TLS probe (`sslmode=require` with
    `pg_stat_ssl` printing `t`, or the recorded reason), what passes through the machine, and
    `exit` at the end;
  - step 1 gains the hygiene checklist: full-disk encryption, the route up, TLS recorded, URLs
    via `read -rs` only, history off, no session recording (`script`, asciinema, iTerm2
    logging), screen sharing off, the checkout clean at `PROMOTED_COMMIT`, the session closed;
  - steps 6, 7, 9 and 10, rollback.md, rehearsal.md (the same machine path, and its timings
    recorded), the scripts README ("01-export is never run by hand") and RELEASE.md are updated.
- [x] Main's scan: `railway ssh` and `/etc/ansari-auth-image` went from 13 hits in five files to
  0 across RELEASE.md, `docs/` and `apps/auth/scripts`. `cutover-docs.test.ts` pins that, plus
  the operator environment and the checklist.
- [x] Source scan 4's private-network pattern is narrowed to the removed listener
  (`.railway.internal:3101`), because the cutover scripts now name `<name>.railway.internal`
  hosts. A near-miss line pins that.
- **Open at step 1, recorded by the owner:** whether Railway offers TLS on the private path over
  Tailscale.

## Deviations from Plan

The thread (`codev/state/spir-300_thread.md`, one section per phase) has each deviation with its
reasons and the ruling behind it.

- **Specify.** Several owner rulings reshaped the architecture before the plan:
  - Better Auth moved out of `apps/api` into its own `apps/auth` service, verified by JWKS. This
    overrode the issue's bearer-plugin item.
  - The auth database is separate from day one. The split-readiness design was dropped.
  - The three-principal DB roles and grants were dropped; each service uses Railway's default
    account.
  - C-2 settled on one cutover PR, plus a contract PR after the 24 h deadline. The legacy columns
    and `tokens` are not dropped in the window.
  - Smaller rulings:
    - Sessions stay at 30 d / 1 d.
    - The JWT lasts 15 min, with no per-request session check (I-7).
    - The domains are `auth.askansari.ai` and `auth-staging`.
    - The legacy web frontend was added as a `/v2/users` client.
- **Plan.** Codex's iteration-1 changes:
  - Phase 7 builds the verifier only; phase 8 switches every route in one commit.
  - Ban becomes a script.
  - `revoke-sessions` is specified in phase 5.
  - The newsletter moves to an `apps/auth` sign-up hook.

  Security amendments A–D: two listeners, `net.isIP` on the forwarded IP, `ON DELETE CASCADE`, and
  the plain-http JWKS residual. The app architect made four changes to phase 10, including one
  bearer transport on every platform and a stacked PR. The owner approved G-1 to G-5.
- **Phase 1.** Owner decision: the legacy web frontend is retired at go-live, not fixed. That added
  phases 10b (#304) and 10c (#306) as stacked PRs and as window preconditions. Porch cannot add
  phases mid-implement, so they ran outside porch, gated by the app architect's PR approval. Two
  refresh cases keep `detailOneOf`, because the new backend cannot distinguish their causes.
- **Phase 2.** `createAuth()` got `modelName: 'users'` and `generateId: 'uuid'` early. Turbo `test`
  inputs now include RELEASE.md and `docs/**/*.md`.
- **Phase 3.**
  - `apps/auth`'s env example and CI env file were not updated: builder permissions deny reading
    them. Security held them for the owner.
  - `deps.neverBundle: ['bcrypt']` fixes a real deploy bug.
  - Newsletter failures log only the status or error name.
  - `packages/types/src/**` joined `globalDependencies` (main's condition).
- **Phase 4.**
  - The factories take `{auth, db}`.
  - `createAuth` gained a limiter-extension hook.
  - A retention plugin was added, because Better Auth prunes `rate_limit` rows.
  - `isAuthError` is exported, because two better-auth copies break `APIError` identity.
  - The reset burst rule moved from Better Auth's router into `apps/auth` (Codex).
  - `CORS_ORIGIN` became a comma list.
- **Phase 5.**
  - `deleteUserSessions(userId)` is used, because 1.7.7's `deleteSessions` takes tokens.
  - The reset email is static HTML, not React Email.
  - The user helpers live in `packages/auth`, which avoids a lockfile hunk.
  - `grant-admin --revoke` was added.
- **Phase 6.** None material. Each guard is one `DO $$` block, because `psql -f` autocommits.
- **Phase 7.**
  - The diag route is under `v2/%5Fdiag/`, because Next treats `_folder` as private.
  - `AUTH_*` are required in production only.
  - Codex's fixes: the JWKS stale-key grace, success counted only for a valid JWKS body, and the
    first-use insert plus tombstone re-check in one transaction.
  - The last fix (583b045) had a security spot-check only (the iteration ceiling).
- **Phase 8.**
  - A SHA-256 pin replaces the plan's CI diff step.
  - New setting `AUTH_LAYER_ORIGIN`, in `trustedOrigins` only.
  - Five behaviour changes were accepted (above).
  - The legacy route suites were deleted.
  - Codex's fixes: the internal listener serves JWKS ahead of the production IP rule, and reset
    requests answer 503 on an outage.
- **Phase 9.**
  - `drizzle-kit generate` was deliberately not run (the drops belong to the contract PR).
  - `lib/boot-check.ts` keeps the production env check fail-fast.
  - bcrypt, resend and React Email stay in `apps/api` for now.
  - CORS option B (static `*`, no credentials); scenario 28 amended.
  - The turbo `globalEnv` additions landed here rather than in phase 11.
- **Phase 10.**
  - No `better-auth`/`@better-auth/expo` dependency in the frontend and no lockfile hunk. The Expo
    plugin is cookie forwarding, which bearer-only clients do not need.
  - `customFetch` forces `credentials: 'omit'`.
  - Android was not run.
  - #309's review required three fixes: single-flight guest provisioning, a refresh
    principal-change guard, and partial-session cleanup.
- **10b / 10c (outside porch).**
  - 10b: a reset does not sign the user in. The builder took this default and flagged it.
  - 10b: #311 needed five fixes; one was an iOS boot regression the app architect caught (React
    Native's `window` has no `location`).
  - 10c: #312 needed four fixes.
- **Phase 11.**
  - The env templates were still deferred to the owner (Codex flagged them).
  - No CI change: the existing job covers it.
  - The pool `'error'` listener (9d7371b).
  - `chmod -R a+rX` on the copied sources.
  - In-image scripts run through `./node_modules/.bin/tsx`.
- **Phase 12.**
  - The runbook grew from 17 to 18 steps:
    - promotion is its own step, with auto-deploy off
    - auth deploys with an empty `ADMIN_EMAILS`
    - `cutover_at` comes from the app database's clock at step 6
    - the domain is attached before the web swap
  - The auth image carries the PGDG psql client, `apps/api/drizzle` and a marker file, which the
    scripts require (main's option 1).
  - The preflight covers all rows.
  - A NULL legacy timestamp blocks the copy. The last fix (68aef71) had a security spot-check only.
  - A stale-cache hole in the turbo inputs was found and fixed.
- **Review phase (security review of the cutover PR, two batches, each fix verified by the
  security architect).** See "Security review of the cutover PR" under Consultation Feedback.
  It changed four behaviours and the contract pin:
  - The frontend delete mints a fresh JWT before the DELETE.
  - Development origins are not trusted in production.
  - `/change-password` is blocked; the spec now says a future feature needs the strength guard
    and must revoke the other sessions.
  - The copy refuses a short stream.
  - The contract freeze now pins the assertion body and the preamble separately (signed off).
- **Phase 13.** It started blocked: no staging DNS, no baselines, no soaked release.
  - **R-1:** the rehearsal uses seeded staging users, not a production restore. Mitigations: a
    production preflight (counts only), the non-bcrypt refusal, the anomaly seed, and scaled
    timings with a 3× comms allowance.
  - **R-2:** the branch is never deployed; the staging rehearsal runs from the `develop` merge
    commit, and its evidence goes in a docs-only PR.
  - Postgres 18 everywhere, superseding a 17 decision.
  - C-4 clarified as create-or-check.
  - The Cloudflare egress-IP inference was withdrawn. The probes now cover both paths.
  - Rulings:
    - Baselines come before the merge.
    - Staging web auto-deploy is off.
    - Rollback redeploys the deployment IDs recorded in step 1.
    - The production web swap is an un-rehearsed residual.
  - Smaller deviations, accepted by security:
    - Three extra probe fields.
    - The anomaly seed loads bcrypt via `createRequire`, avoiding a lockfile change.
    - Runbook step 1's PG18 and empty-auth-DB checks run at step 6 when no operator environment
      exists yet.

## Consultation Feedback

**Coverage.** Gemini's lane failed from phase 8 iteration 2 through phase 12 ("agy exited with code
3"; out of quota until about 2026-10-22). Consult recorded each failure as a COMMENT verdict with
exit 0, and porch counted the round. Those rounds are **Codex-only**, and no Gemini skip is counted
as a review anywhere in this project. Main's rule: a REQUEST_CHANGES fix counts as reviewed only
once Codex has seen it. Two fixes came after porch's 3-iteration ceiling force-advanced and had no
consult round of their own. Each got a **security spot-check** instead:
- 583b045, `apps/api/lib/auth/resolve-user.ts` (phase 7). Its code was in the tree Codex approved
  in phase 8 round 3.
- 68aef71, `apps/auth/scripts/cutover/02-import-auth.sql` (phase 12).

The integration review should take a deliberate look at both. The stacked frontend PRs (#309, #311,
#312) were each reviewed by the app architect with a real-path iOS Simulator run, and approved
before their merge commits. Phase 13 ran both lanes again. No `CONSULT_ERROR` occurred.

### Security review of the cutover PR (review phase, human)

The security architect reviewed the branch tip (0cbc492) on the core path and with four breadth
reviews, in two batches. The app architect re-reviewed the F3 frontend change and approved it on
#312. Main approved the lockfile hunk.

**Batch 1:**
- **F3**: delete-account sent the stored JWT, which may have expired. Its 401 then read as
  "already deleted", although the account still existed. → **Addressed** (b9ca7b9):
  - `refresh()` runs first, and the session is re-read after the await.
  - A `/token` 401 is the honest "session ended".
  - Any other `/token` failure sends nothing, and the page shows a plain retry.
  - The DELETE carries only the fresh JWT.
  - Seven tests. The simulator run used a 1-minute JWT and covered the expired case and a
    `/token` 5xx.
- **F2**: `exp://` and `http://localhost:8081` were trusted in production → **Addressed**
  (9bfbcb2): trusted outside production only, with production's exact list pinned.
- **F4**: the deployed-state parity exercise missed the bearer path's tables → **Addressed**
  (1b7a886): it now exercises `insertAppUserRow` and `resolveUser`. It fails at 0008, 0009 and
  0010, and passes at 0011. It stays red at 0008 until the owner's `DEPLOYED_THROUGH` bump.
- **Nits** → **Addressed** (10c59ff, f6f8246):
  - The dead mail dependencies were removed from `apps/api`; bcrypt is dev-only.
  - The contract preamble lost its dead mocks, with the frozen pin re-shaped (signed off).
  - The bench DDL, `psql -X` in CONTRIBUTING, and the `index.ts` comment were fixed. The
    comment's import-order test already existed; it was cited under the wrong file name.

**Batch 2:**
- **F5**: `/change-password` was neither blocked nor guarded → **Addressed** (9d3e93e):
  - Blocked, with variant tests on both listeners.
  - The middleware now derives its list from `BLOCKED_AUTH_PATHS`.
  - The spec and arch.md record what a future feature needs.
- **F6**: `0010_snapshot.json` still holds the legacy columns → **Addressed** (dce5bc0):
  RELEASE.md and the plan say no `apps/api` migration is generated before the contract PR, and
  that its SQL must hold only those drops.
- **S1**: a hash in neither format made sign-in answer 500 → **Addressed** (81ede8a): it
  verifies false, so sign-in answers 401.
- **S2**: the Dockerfile comment implied the operator scripts check the image marker →
  **Addressed** by correcting the comment and the runbook (b333830). `grant-admin.ts` also
  serves RELEASE.md's local smoke test, so no guard was added.
- **S3**: absolute-form request targets → **Addressed** (9d3e93e): stripped before
  canonicalizing; tested raw on both listeners.
- **S4**: a dropped pipe could import a subset → **Addressed** (e77a510): `copy.sh` passes
  `expected_rows`, and `02` refuses without it or on a mismatch. Proven in pglite and real
  psql 18.
- **Nit**: a refused locked sign-in wrote a list-walk row → **Addressed** (6b5361b).
- **Residuals**: the admin startup check and the JWKS rotation → **Accepted**; recorded under
  "Accepted residuals" above.

**Batch 3 (from security's 3-way consult on #315, plus main's rulings):**
- **@babel/traverse** (main): react-native-worklets' Babel plugin requires `@babel/traverse` and
  `@babel/generator` without declaring them, and resolved them only through hoisting.
  `pnpm-workspace.yaml` gains `packageExtensions` for both (8713c25). Proven with an incremental
  install from the pre-10c59ff `node_modules`. Main approved.
- **B3-1**: `apps/auth`'s env templates lacked the variables the schema requires, and the dev
  `CORS_ORIGIN` excluded Metro web → **Addressed**: both files carry every schema key (the
  optional URLs are commented out), and `tests/env-templates.test.ts` checks names and schema.
- **B3-2**: the PR body still described the templates as held → **Addressed**.
- **Runbook** (main): step 1 now requires #307 and #317 (the web image's build guard) to be
  merged before the window (ca1d555).

### Specify Phase (Round 1)

#### Gemini — APPROVE
- **Concern** (non-blocking): the layer's in-memory limiter multiplies across replicas → **Addressed**: DB-backed shared counters (I-2); scenario 25.
- **Concern** (non-blocking): `refresh_token` must slide the session via `updateAge` → **Addressed**: new criterion, scenario 26.
- **Concern** (non-blocking): `@ansari/auth` in `apps/api` touches the lockfile → **Addressed**: flagged for main under Reviewers.

#### Codex — REQUEST_CHANGES
- **Concern**: the layer's rate limiting must be shared and DB-backed → **Addressed**: required; scenario 25 (two instances, one budget).
- **Concern**: `is_admin` users outside `ADMIN_EMAILS` would silently lose admin → **Addressed**: inventory, owner-approved list, role script, parity audit; scenario 23.
- **Concern**: dropping the #59 scaffold tables relies on an operator precheck → **Addressed**: in-migration guard aborts on any row; scenario 22.
- **Concern**: "byte-compatible" is wrong for dynamic values → **Addressed**: "wire-contract-compatible".

### Plan Phase (Round 1)

#### Gemini — COMMENT
- **Concern**: `reserved.ts` must also reserve `ADMIN_EMAILS`, and the guard order must put the 409 before the 400 strength check → **Addressed**: a `hooks.before` on `/sign-up/email` orders validation, then 409, then 400; a test was added.
- **Concern**: reset ordering of token check vs strength → **Addressed**: the token is checked first; test added.
- **Concern**: `apps/auth` CORS `allowedHeaders` lacks `X-Ansari-Client` → **Addressed** (phase 4).
- **Concern**: the newsletter opt-in is bypassed by direct sign-up → **Addressed**: `packages/auth/src/newsletter.ts` from a `hooks.after`.
- **Concern**: copy-SQL details (`provider_id='credential'`, ids, timestamps, `ON CONFLICT`) → **Addressed** in the copy SQL.
- **Concern** (observation): guest auto-provisioning vs the 3/60 s per-IP sign-up limit → **Addressed**: raised as G-5; B-1 measures the guest rate.

#### Codex — REQUEST_CHANGES
- **Concern**: phase 7 rewires routes to EdDSA while login still issues HS256 → **Addressed**: phase 7 builds only; phase 8 switches everything in one commit.
- **Concern**: P-4 contradicts the spec's pre-merge edge verification → **Addressed**: G-2 requires an owner spec amendment.
- **Concern**: manifest/lockfile work is missing → **Addressed**: each assigned to a phase and flagged as a lockfile hunk.
- **Concern**: no ban revocation or unified revocation-window test → **Addressed**: `ban-user.ts` (phase 5); revocation table (phase 8).
- **Concern**: G-3 `revoke-sessions` unresolved → **Addressed**: specified in phase 5.

### Phase 1 (Round 1)

#### Gemini — APPROVE
- **Concern** (non-blocking): the tombstoned user's bearer should return a fixture detail → **Addressed**: exact pin (`Token not found or expired`).

#### Codex — REQUEST_CHANGES
- **Concern**: `detailOneOf` lets phase 8 return a different detail → **Addressed** in part: exact fixtures for garbage/expired bearer, deleted-account bearer and garbage refresh. **Rebutted** in part: `refresh_token.rejected` and `bearer.rejected` keep `detailOneOf`, because the new layer cannot distinguish their causes.

### Phase 1 (Round 2)

#### Gemini — APPROVE
- No concerns raised.

#### Codex — APPROVE
- No concerns raised.

### Phase 2 (Round 1)

#### Gemini — APPROVE
- No concerns raised.

#### Codex — REQUEST_CHANGES
- **Concern**: `thread-get-contract.test.ts` was changed to `it.skip` → **Addressed**: merged develop's fix (PR 301) at `abeabf2`; the file now matches develop with no skip, and passed 10/10 isolated runs.

### Phase 2 (Round 2)

#### Gemini — APPROVE
- No concerns raised.

#### Codex — APPROVE
- No concerns raised.

### Phase 3 (Round 1)

#### Gemini — APPROVE
- No concerns raised.

#### Codex — APPROVE
- No concerns raised.

### Phase 4 (Round 1)

#### Gemini — COMMENT
- Output truncated before its verdict line; porch recorded COMMENT. The text that arrived raises no issue. Not a complete review.

#### Codex — REQUEST_CHANGES
- **Concern**: reset requests refused by Better Auth's router limiter never reach the counting hook → **Addressed**: the router rule is off; `apps/auth` enforces the burst itself and counts every request.
- **Concern**: `ipBucket()` mis-buckets hex IPv4-mapped IPv6 → **Addressed**: a faithful port of `normalizeIP`, plus a router-key parity test.

### Phase 4 (Round 2)

#### Gemini — APPROVE
- No concerns raised.

#### Codex — APPROVE
- No concerns raised.

### Phase 5 (Round 1)

#### Gemini — APPROVE
- No concerns raised.

#### Codex — APPROVE
- No concerns raised.

### Phase 6 (Round 1)

#### Gemini — APPROVE
- No concerns raised.

#### Codex — APPROVE
- No concerns raised.

### Phase 7 (Round 1)

#### Gemini — APPROVE
- No concerns raised.

#### Codex — REQUEST_CHANGES
- **Concern**: once the JWKS cache expires, an `apps/auth` outage fails valid JWTs → **Addressed**: stale-key fallback bounded to the cache age plus one JWT lifetime (`9d68962`).

### Phase 7 (Round 2)

#### Gemini — APPROVE
- No concerns raised.

#### Codex — REQUEST_CHANGES
- **Concern**: any 200 counts as success before jose parses it, so a malformed 200 renews the grace → **Addressed**: success counts only for a body that passes `isJWKSLike`; regression test.

### Phase 7 (Round 3)

#### Gemini — APPROVE
- No concerns raised.

#### Codex — REQUEST_CHANGES
- **Concern**: the first-use INSERT can resurrect a concurrently deleted user under READ COMMITTED → **Addressed** (583b045; security spot-check, no further round): the insert and the tombstone re-check run in one transaction. The true two-connection race is left to real Postgres.

### Phase 8 (Round 1)

#### Gemini — APPROVE
- No concerns raised.

#### Codex — REQUEST_CHANGES
- **Concern**: production `apps/auth` requires a client IP, so the cold-cache JWKS fetch gets 400 and every switched route 401s → **Addressed**: the internal listener serves JWKS ahead of the IP rule, behind the credential; production-mode tests.

### Phase 8 (Round 2)

#### Gemini — COMMENT
- Lane failed (agy exit 3) — not counted as a review.

#### Codex — REQUEST_CHANGES
- **Concern**: `request_password_reset` swallows an outage and returns success → **Addressed**: 503; the outage test covers reset request, reset, refresh and login.

### Phase 8 (Round 3)

#### Gemini — COMMENT
- Lane failed (agy exit 3) — not counted as a review.

#### Codex — APPROVE
- No concerns raised.

### Phase 9 (Round 1)

#### Gemini — COMMENT
- Lane failed (agy exit 3) — not counted as a review.

#### Codex — COMMENT
- **Concern** (non-blocking): `apps/api/README.md` still lists the reset email, `tokens` and `emails/` → **Addressed** (`2aa5375`).
- **Concern** (non-blocking): unused React Email deps in `apps/api/package.json` → **Addressed** in the review phase (10c59ff, raised again by the security review; main approved the lockfile hunk).

### Phase 10 (Round 1)

#### Gemini — COMMENT
- Lane failed (agy exit 3) — not counted as a review.

#### Codex — REQUEST_CHANGES
- **Concern**: the app architect's real-path web/iOS acceptance is not done → **Addressed**: a human gate, not a code issue. The app architect ran it and approved #309 at `1ff6a87`, after three fixes: single-flight guests, a refresh principal guard, and partial-session cleanup.

### Phase 10 (Round 2)

#### Gemini — COMMENT
- Lane failed (agy exit 3) — not counted as a review.

#### Codex — APPROVE
- No concerns raised.

### Phase 11 (Round 1)

#### Gemini — COMMENT
- Lane failed (agy exit 3) — not counted as a review.

#### Codex — REQUEST_CHANGES
- **Concern**: `apps/auth`'s env example and CI env file omit required variables, and `CORS_ORIGIN` excludes `:8081` → **Deferred**, then **Addressed** in the review phase (B3-1): the security architect held them through phase 11; the review-phase commit fills both files from the schema, with a test.
- **Concern**: `CONTRIBUTING.md` implies `pnpm dev` starts auth → **Addressed**: it now documents `pnpm auth dev`.

### Phase 11 (Round 2)

#### Gemini — COMMENT
- Lane failed (agy exit 3) — not counted as a review.

#### Codex — APPROVE
- No concerns raised.

### Phase 12 (Round 1)

#### Gemini — COMMENT
- Lane failed (agy exit 3) — not counted as a review.

#### Codex — REQUEST_CHANGES
- **Concern**: the runbook's edge checks lack two-network distinctness and forged headers on the auth domain → **Addressed**: forged `X-Real-IP`/XFF and a second-network probe; pinned in `cutover-docs.test.ts`.
- **Concern**: step 8 is not executable (auth not deployed, no `psql`, wrong paths) → **Addressed**: the auth image carries the psql client, `apps/api/drizzle` and a marker; private early deploy; all DB steps run via the auth service's shell.
- **Concern**: `RELEASE.md` doesn't name the contract migration as the exception → **Addressed**.
- **Concern**: the preflight's guest "exact shape" checks only the email → **Addressed**: the names too, with a near-miss test.

### Phase 12 (Round 2)

#### Gemini — COMMENT
- Lane failed (agy exit 3) — not counted as a review.

#### Codex — REQUEST_CHANGES
- **Concern**: preflight audits filter to `system_key IS NULL` while `0011` checks all rows → **Addressed**: all rows audited (with `of_which_system`); a system/user collision test.

### Phase 12 (Round 3)

#### Gemini — COMMENT
- Lane failed (agy exit 3) — not counted as a review.

#### Codex — REQUEST_CHANGES
- **Concern**: `02-import-auth.sql` rewrites NULL legacy timestamps to `now()` → **Addressed** (68aef71; security spot-check, no further round): a NULL blocks the copy, the columns are copied as-is, and there are tests per column.

### Phase 13 (Round 1)

#### Gemini — APPROVE
- No concerns raised.

#### Codex — REQUEST_CHANGES
- **Concern**: B-1..B-4 in `baselines.md` are empty → **Rebutted**: owner-run production measurements; under R-2 they gate the merge word, not this phase.
- **Concern**: edge-shape tests hard-code provisional values → **Addressed**: all four suites derive their expectations from `edge-header-shapes.json` and pass with an altered fixture.

### Phase 13 (Round 2)

#### Gemini — APPROVE
- **Concern** (minor): the `rehearsal-anomalies.ts` header said "seven rows" after an eighth was added → **Addressed** in the review phase: the header now says eight.

#### Codex — REQUEST_CHANGES
- **Concern**: the anomaly seed never shows the non-bcrypt guard firing → **Addressed**: an eighth `notBcrypt` row; staging step 8 runs abort, abort, abort, pass.
- **Concern**: `edge-check.md` lacks deterministic IPv4/IPv6 commands → **Addressed**: `curl -4`/`-6` via Cloudflare, and A/AAAA `--resolve` direct.

### Phase 13 (Round 3)

#### Gemini — APPROVE
- No concerns raised.

#### Codex — APPROVE
- No concerns raised.

### Review Phase — PR #315 (Round 1)

#### Gemini — APPROVE
- No concerns raised. It spot-checked 583b045 and 68aef71 and found both sound.

#### Codex — REQUEST_CHANGES
- **Concern**: the deployed-state parity test is red at `0008` → **Rebutted**: by design (F4).
  The `DEPLOYED_THROUGH` bump is the owner's assertion commit in this PR; main and security
  confirmed this.
- **Concern**: `apps/auth`'s env example and CI env files are incomplete → **Rebutted** at the
  time (held, as in phase 11), then **Addressed** when security's batch 3 (B3-1) asked for them:
  every schema key, the Metro origin, and `tests/env-templates.test.ts`.
- **Concern**: B-1 to B-4 are empty → **Rebutted**: they gate the owner's merge word, not the
  open PR (R-2; phase 13 ruling).
- **Concern**: the review said no tests were skipped → **Addressed** (016f866): the four skips
  are named under Flaky Tests.

### Review Phase — PR #315 (Round 2)

#### Gemini — APPROVE
- No concerns raised.

#### Codex — APPROVE
- No concerns raised. It accepted the three owner-controlled items as merge gates, and confirmed
  the skipped-test correction.

## Lessons Learned

### What Went Well

- **Removal-fails runs in every phase found gaps the suites missed:**
  - phase 1: a refresh token was accepted as a bearer
  - phase 4: the forwarded-header strip
  - phase 5: the alg/claims pins
  - phase 7: one mutation would have *granted* admin
  - phase 8: the feedback route's auth, which led to the full route sweep
  - phase 12: `stepOf` returned 0 on a missing step
- **The frozen contract held.** Phase 1's 58 scenarios passed unedited against a different backend
  in phase 8, enforced by the SHA-256 pin.
- **Codex found real production bugs** that every suite passed:
  - phase 7: JWKS failing after the cache age
  - phase 7: the READ COMMITTED resurrection race
  - phase 8: JWKS refused by the production IP rule
  - phase 12: the preflight skipping system/user collisions
  - phase 12: NULL timestamps silently becoming `now()`
- **Real-environment runs caught what pglite could not.** The Docker boot test found the pool
  crash-loop (phase 11). The in-image runs on Postgres 17 and 18 proved the operator path.
- **Every turbo cache change was proven both ways** with hash moves. That is how a pre-existing
  stale-cache hole in the doc and scan inputs surfaced (phase 12).
- **Stacked frontend PRs with real-path reviews** (#309, #311, #312) caught concurrency bugs and an
  iOS boot failure before merge.

### Challenges Encountered

- **Requirements churn in specify.** About fifteen owner and architect rulings came in two days:
  the service split, a separate DB, roles added then removed, the PR count, and when the legacy
  columns drop. Resolved by recording each ruling in the spec and thread as it landed, and sending
  every conflict (C-2) back to the owner instead of picking.
- **Better Auth 1.7.7 internals had to be read from `dist`:**
  - two package copies, which break error identity
  - `rate_limit` pruning
  - the Origin requirement triggered by `Sec-Fetch-Mode`
  - plugins overwriting expose-headers
  - `deleteSessions` taking tokens
  - the Expo plugin forwarding cookies

  Each became a test.
- **Gemini out of quota for five phases.** Resolved by main's rule: Codex-only rounds, a skip never
  counted as a review, and the coverage stated in the review and the PR.
- **The iteration ceiling left two fixes without a consult round** (phases 7 and 12). Covered by
  security spot-checks, and flagged for the integration review.
- **Phase 13 started blocked** on external preconditions: no DNS, no baselines, no soaked release.
  Owner amendments R-1 and R-2 reshaped it so the pre-merge work needed no deployment.
- **The env template files were held** from phase 3 to the review phase, on the belief that the
  builder's permissions denied reading them. In the review phase a direct read of the two tracked
  templates was allowed; only shell commands naming them are refused. They were filled in then
  (B3-1). The belief had been carried forward untested since phase 3.

### What Would Be Done Differently

- Run against a production-mode `apps/auth` from the first test whenever a rule depends on
  `NODE_ENV=production` (phase 8).
- Launch the native app after any change to the app entry, even a web-only one (10b).
- Mark an infrastructure inference as provisional until it is measured (the phase 13 Cloudflare
  claim).
- Settle the operator execution environment (psql version, where the scripts run) and the
  deployment model (R-2) in the plan, not at a phase-12 consult or in phase 13.
- Resolve file-permission questions, such as the env templates, at plan time, so they are not
  carried open across nine phases.
- Ask the owner up front how the plan's production-clone rehearsal fits staging. That would have
  avoided the late R-1.

### Methodology Improvements

- **A failed consult lane should not look like a verdict.** consult records agy exit 3, and a
  report cut off before its verdict, as COMMENT with exit 0, and porch spends an iteration on it. A
  distinct non-review status would keep coverage honest without manual bookkeeping.
- **The 3-iteration ceiling force-advances with the last REQUEST_CHANGES fix unreviewed.** Better
  options: an automatic extra single-lane round, or an "unreviewed fix" flag that blocks the next
  gate until a human acknowledges it.
- **Porch cannot add phases mid-implement.** Stacked follow-on work (10b, 10c) ran outside porch
  with ad-hoc gating. Porch needs a sub-phase or follow-on mechanism.
- **Order the consult and the human gate explicitly.** Phase 10 round 1 spent an iteration on
  REQUEST_CHANGES only because a human approval was pending.
- **Exclude builder state files from the consult tree-drift check.** The "working tree changed"
  banners fired on almost every round because of the thread and state files.
- **Make the consult-output tracking policy part of the protocol.** It drifted mid-project and had
  to be re-aligned in phase 13.

## Architecture Updates

- Routed: hot — admin authorization is `auth.users.role` asked of `apps/auth` per request,
  fail-closed — replaced the `users.is_admin` fact (phase 12).
- Routed: hot — two databases with one owner each, and `apps/api` reaches auth only over the
  internal listener — new fact.
- Routed: hot — `apps/api` accepts only the EdDSA JWT; revocation is bounded by the JWT lifetime;
  key rotation is not revocation — new fact.
- Routed: hot — the client IP is the single `X-Real-IP`; the `AUTH_RATE_LIMIT_MODE=email` switch;
  the peer-inventory rule for the JWKS fetch — new fact.
- Routed: hot — the migration-apply flags `psql -v ON_ERROR_STOP=1 --single-transaction`, naming
  the database, and the new `grant-admin.ts` path — folded into the existing schema-change fact.
- Demoted to cold: four spec-4 facts (`config`-only JWT secret reads, `session_version`
  revocation, the token-rotation transactions, and the `exec` parameter) made room under the cap.
  The first three no longer hold after this migration; the `exec`-parameter rule lives on in
  arch.md's "Transactions" paragraph.
- Routed: cold — arch.md "Authentication & Authorization" is rewritten for Better Auth: two
  databases, two listeners, tokens, revocation, identity on `apps/api`, admin and system identity,
  the legacy surface, rate limits and client IP, private-network peers, transactions, and the
  deploy order. The stale spec-59 "second auth stack" paragraph was removed.
- The hot map entry for Authentication & Authorization was updated to the new triggers. The hot
  file stays at 10 facts and 4 map topics.

These were written in phase 12 with the `update-arch-docs` discipline. The review phase found
nothing further to route.

## Lessons Learned Updates

- Routed: hot — testing — "A rule or failure that exists only in production needs a
  production-shaped test" (production mode from a cold cache; stop the database under the running
  process; `'error'` listeners on long-lived clients). It displaced the `vi.mock` factory lesson,
  which is demoted to its existing cold entry under "Tool-call persistence (spec 73)".
- Routed: hot — map — a new topic, "Better Auth migration (spec 300)", added to
  lessons-critical.md's map. That makes 10 map lines, under the cap of 12. The file is 34 lines,
  under 35.
- Routed: cold — new section "Better Auth migration (spec 300)" in lessons-learned.md:
  - production-only rules need production-mode tests
  - `'error'` listeners and stop-the-dependency boot tests
  - `psql -f` autocommit, `\copy` and `--single-transaction` traps
  - `NOT EXISTS` is not a race guard under READ COMMITTED
  - the jose `createRemoteJWKSet` cooldown
  - better-auth 1.7.7 surprises
  - bundlers inlining native modules
  - Docker `COPY` file modes and `pnpm exec` as `node`
  - default-returning lookups passing ordering checks
  - inference vs measurement, and fixture-derived tests
  - Expo / React Native traps
  - Next's private `_folder`

## Flaky Tests

These were found during phase 9's full `npm test` runs. Before the fixes, 2 of 4 runs were red
with the new CORS suite, and 1 of 3 with it excluded (the same hook timeouts), so they predate it.
After the fixes, 3 of 3 runs were green.

- `packages/auth/tests/migration/auth-journal-parity.test.ts` and
  `packages/auth/tests/schema/auth-schema.test.ts`: their hooks carried a hard-coded 20 s timeout
  that overrode the package's 30 s (#292 rationale) and timed out under the full turbo run. The
  overrides were removed.
- `apps/api/tests/auth/resolve-user.test.ts` (one `ECONNRESET` in six runs): fetch reused a pooled
  keep-alive socket just as the in-process `apps/auth` test server closed it at Node's 5 s default.
  The test service (`apps/auth/tests/helpers/service.ts`) now keeps idle sockets for 30 s.

This project skipped no test as flaky. (Phase 2 briefly skipped `thread-get-contract.test.ts`; the
skip was withdrawn once develop's fix was merged.) The suite's four skips predate it or are
conditional by design:
- `apps/api/tests/mcp-complete.test.ts`, three `it.skip` marked FLAKY since 2026-08-20 (issue #29
  era: the route returns non-JSON in the test harness). These are pre-existing and untouched here.
- `packages/auth/tests/migration/auth-journal-parity.test.ts`, the deployed-state case is
  `it.skipIf(deployed === null)`. It runs once `AUTH_DEPLOYED_THROUGH` is set at the window; until
  then there is no deployed auth journal to check.

## Follow-up Items

**Owner, before the merge word:**
- Remove `AUTH_INTERNAL_SECRET`, `AUTH_INTERNAL_URL`, `INTERNAL_PORT` and `AUTH_RATE_LIMIT_MODE`
  from the staging `auth` and `backend` services, and set `backend`'s `AUTH_URL` (spec H-1).
- The `auth-staging` and `auth` DNS records exist, unattached, before each window (spec H-5).
- B-1 to B-4 in `docs/cutover/baselines.md`, plus any `limits.ts` amendment, in this PR (G-4).
- Staging auto-deploy off for backend, auth and web; staging auth deploys from `develop`.
- Staging DNS for `auth-staging`; orange-cloud the staging hostnames for the probe.
- A soaked pre-300 `develop` release.
- ~~The `DEPLOYED_THROUGH` assertion bump~~: done in e37fa0c on the owner's word (applied on
  staging, then production, before each apps/api deploy).

**Integration review:** a deliberate look at `apps/api/lib/auth/resolve-user.ts` (583b045) and
`apps/auth/scripts/cutover/02-import-auth.sql` (68aef71).

**After the merge:**
- The staging rehearsal: the owner operates; the builder runs the client checks (edge probes on
  both paths and two networks; the released mobile build against staging; admin analytics; a
  stored-guest sign-in).
- The docs-only evidence PR: `rehearsal.md` Parts A–F, the edge verdict, and the measured shapes
  replacing the provisional fixture.
- The production window, with the `AUTH_DEPLOYED_THROUGH` bump and the `auth-journal-applied`
  line.

**Contract PR (after the 24 h deadline):**
- Drop `password_hash`, `is_admin`, `session_version` and `tokens`, with their own
  `DEPLOYED_THROUGH`.
- Clean up the pglite DDL.
- Remove both diag routes.
- Drop bcrypt from `apps/api`'s devDependencies once no test reads a legacy hash (resend and
  React Email were removed in the review phase, 10c59ff).
- Remove the legacy JWT env vars and `ADMIN_EMAILS` from the backend env.
- Possibly make `AUTH_*` unconditionally required.

**Issues to file (spec OPS-7) and other open items:**
- Layer removal, gated on the I-3 metric: filed as **#318**, with the temporary per-IP choices.
- File: profile sync.
- File: guest cleanup (feedback retention, shared links, session accumulation).
- Close #16 and #49 after the cutover.
- `apps/api`'s pg pool lacks the `'error'` listener; this is in production today and is with main.
- An Android pass before the I-6 build.
- The #305 production build guard must cover `EXPO_PUBLIC_AUTH_URL`.
- #265: duplicate better-auth snapshots.
- #176: nothing checks the target DB for applied migrations.

- `apps/api`'s per-IP store for the layer is in memory, per instance (H-4): with N instances a
  client gets N times each budget. Temporary with the layer; a shared store if it outlives that.

**Observed, not changed:**
- A tokenless `GET /threads` fires after sign-out (pre-existing).
- Better Auth leaves earlier reset tokens valid; the 3/h cap bounds this.
- The reset link appears in access logs; this is with the owner.
- The production web swap is un-rehearsed.
- A true two-connection race test needs real Postgres.
