# Specification: Better Auth Migration

<!--
SPEC vs PLAN BOUNDARY:
This spec defines WHAT and WHY. The plan defines HOW and WHEN.
-->

> **Owner decisions, 2026-10-15** (at the spec-approval gate). Better Auth runs as its **own
> service, `apps/auth`**, and **never inside `apps/api`**. `apps/api` verifies **JWTs against
> `apps/auth`'s JWKS**, statelessly. The `/v2/users/*` compatibility layer stays on `apps/api` and
> **calls `apps/auth` over HTTP**. `apps/frontend` signs in **directly against `apps/auth`** from the
> cutover. The first decision follows reference spec Q5. The second overrides the issue's decided
> item "apps/api authenticates with the bearer plugin", and its revocation cost is stated in Desired
> State item 11.
>
> **Owner decisions, 2026-10-16.** Better Auth has **its own database from the start**. Only
> `apps/auth` can reach it. `apps/api` keeps the existing database, where `public.users` stays for
> referential integrity with its auth-only columns removed. See "Two databases from the start".
> Also: **one PR for the cutover**, merged at the window, plus **a contract PR** in the first
> release after the 24-hour rollback deadline (C-2); **no database logins are provisioned**: each service
> uses its own database's Railway default account; the JWT lifetime is **Better Auth's default, 15
> minutes**; `apps/api` uses **plain JWKS validation with no per-request session check** (I-7).
>
> **Owner amendments, 2026-10-16, at the plan-approval gate** (plan G-1 to G-5).
>
> - **G-2.** This amends "Client IP for rate limiting". The **production-domain** edge probe runs
>   **in the window**, using the diagnostic routes. Before the merge, the staging domains are
>   probed, and each production domain gets a **passive DNS and proxy-chain check** (`dig` CNAME
>   chain and plain `curl -sI` headers, with no code deployed). Production ships in the
>   **staging-verdict mode**, and the in-window probe can only move it to the fallback.
> - **G-1.** The IP fallback is built now, behind `AUTH_RATE_LIMIT_MODE` (default `email`).
> - **G-3.** A fourth internal endpoint, `revoke-sessions`, bound to the subject's JWT, carries
>   legacy logout.
> - **G-4.** The plan's limit numbers are approved, pending production baselines B-1 to B-4
>   before the merge.
> - **G-5.** Sign-up stays at 3/60s, with the guest fall-through in `apps/frontend` narrowed.
>
> **Owner amendment, 2026-10-17, during phase 13** (accepted by the security architect).
>
> - **R-1.** This amends C-3 and the rehearsal assumption. The rehearsal runs on the users already
>   in the staging app database, with **no production restore**. In its place:
>   - The owner runs the read-only preflight against production. It includes a hash-format
>     distribution, and the copy refuses any non-bcrypt hash.
>   - Staging is seeded with one row per anomaly class, so every copy guard is shown to fire in
>     the real environment.
>   - Only the copy and audits are timed by scaling to production's row count; the window's comms
>     allowance is three times the scaled total.
>   - `docs/cutover/rehearsal.md` records counts and checksums only.
>
> **Owner amendment, 2026-10-17, phase 13 reshaped** (owner rule with the main architect; the
> security architect concurs).
>
> - **R-2.** This amends every "before the PR merges" verification below, and the Phasing table.
>   **The branch is never deployed to staging.** Staging deploys only from `develop`, and
>   production from `main`. **The staging rehearsal is the window, run on staging after the
>   merge:**
>   1. Before the merge, the owner turns auto-deploy **off** on staging `backend` and the staging
>      web service, and sets the staging `auth` service to deploy from `develop` with auto-deploy
>      off. The new frontend is deployed by hand at the staging step 12, so the web change at
>      step 16 is rehearsed in order.
>   2. The cutover PR merges to `develop` on the owner's word, after the security architect's
>      review. `develop` is **frozen** from that merge until the production window.
>   3. The window runbook runs on staging from step 1, with `develop`'s merge commit standing in
>      for `main`, and every deploy done by hand. The roles:
>      - the owner operates the Railway side
>      - the main architect prepares the filled-in staging command sheet and checks the outputs
>      - the builder runs the client-side checks: the edge probes on both paths, the released
>        mobile build against staging, the admin analytics login, the stored-guest sign-in
>   4. The rollback is rehearsed on staging.
>   5. The evidence (the staging edge verdict, the measured edge shapes, the scaled timings) lands
>      as a small docs-only PR to `develop`. The **baselines are not in it**: B-1 to B-4 are
>      recorded **before the merge** (G-4), because the preflight is read-only and runs on
>      production at any time. So any `limits.ts` amendment lands in the cutover PR, and the
>      evidence PR stays docs-only under the freeze.
>   6. The production window then promotes `develop` to `main`.
>
>   **Until the staging check passes, `develop` is not promoted.**
> - **C-4 (clarified, owner, 2026-10-17).** In **staging**, the auth service and its Postgres 18
>   already exist, and the auth database is empty. In **production** they are created afterwards
>   (or found) with the settings the main architect confirms. Either way, window step 1 checks
>   mechanically that the auth server reports major 18 and that the database has no tables.
>
> **Owner amendment, 2026-10-17, at the pr gate: no shared secret, no internal hop** (owner
> decision; the security architect's requirements R1 to R3 folded in; R2 decided with main).
>
> - **H-1.** `AUTH_INTERNAL_SECRET`, the internal listener (`INTERNAL_PORT`, 3101), the
>   private-network hop and the forwarded-IP header are **removed**. `apps/api` reaches `apps/auth`
>   like any other client, at its **public origin** (`AUTH_URL`), with no shared credential. The
>   issuer it pins (`AUTH_JWT_ISSUER`) stays a separate setting, never derived from the URL.
> - **H-2.** The four internal endpoints become **account endpoints** on the public listener, bound
>   to the caller's OWN JWT (EdDSA, `iss`, `aud`, `exp`, `sub`, `sid`; no id in any path) and to a
>   **live session** (the token's `sid` still exists): `GET /api/account/me` (`{id, email,
>   first_name, last_name, registered_via, role, banned}`, serving rules 2 and 6), `POST
>   /api/account/revoke-sessions` (G-3) and `DELETE /api/account` (rule 5). `DELETE` answers 204 when
>   the token's subject is already gone, before the session check, so a retry after a lost 204 stays
>   idempotent; otherwise it requires the live session. Each endpoint has a per-user budget.
> - **H-3.** The JWKS `apps/api` verifies against is the **public** `/api/auth/jwks`, fetched like any
>   client fetches it, under the router's per-IP default (at most one fetch per 30 s cooldown).
> - **H-4.** The `/v2/users/*` layer is an **anonymous pass-through** to `apps/auth`'s public
>   endpoints. Rate limits, Option A, **TEMPORARY until the legacy system is replaced** (owner):
>   `apps/auth` sees `apps/api`'s egress IP on every legacy call, so **no path the layer calls has a
>   per-IP router rule**, the global default included (R1): sign-in and sign-up per email (plus the
>   global sign-up ceiling), reset request per email plus a global ceiling, reset consume globally,
>   `/token` and `/get-session` per session token, the account endpoints per user. `apps/api` limits
>   the layer's routes per client `X-Real-IP` itself, at the per-IP numbers `apps/auth` used.
>   `AUTH_RATE_LIMIT_MODE` is removed: per-email is the only mode.
> - **H-5 (R2).** The window attaches `auth.askansari.ai` **after the copy and the admin roles
>   (step 10) and before `apps/api` deploys**, never before the copy, and `apps/api`'s `AUTH_URL` is
>   that domain from its first deploy. The few minutes of public sign-in exposure before `apps/api`
>   deploys are the same exposure as after the old step 15, only earlier.
> - **H-6 (R3), accepted residual.** A user who calls `DELETE /api/account` directly, bypassing
>   `apps/api`, deletes their auth account and leaves their app row with no tombstone. A later
>   sign-up with the same email gets a new id that first use refuses as an email conflict, naming
>   the orphan holder in the Sentry alert. The operator response (an audit for app ids with no auth
>   user and a one-transaction cleanup) is in the runbook. A stolen JWT can delete at `apps/auth`
>   directly, the same power it has through `apps/api`.
> - **H-7 (owner, 2026-10-17, security conditions folded in).** `ADMIN_EMAILS` is **removed**
>   from `apps/auth`: no configured-admin reservation at sign-up and no boot assertion. The role in
>   `auth.users` is the only admin truth; a stale list can no longer stop sign-in. The reservation's
>   one protection (no email verification, so an admin address could be squatted before promotion)
>   moves into `grant-admin.ts`: `grant-admin.ts <email>` shows id, email, `created_at`,
>   `email_verified` and role, grants nothing and exits non-zero; only `--confirm <that id>` grants;
>   it never creates an account, refuses the system domain, and warns on a recent or unverified
>   account. The window verifies admins with `05-audit-admins-auth.sql` after step 10, and step 10
>   no longer redeploys `apps/auth`. The frozen contract case "refuses a configured admin address
>   with the IDENTICAL 409" is deleted under the pin, with the security architect's sign-off.
>   `apps/api`'s **legacy** `ADMIN_EMAILS` stays set on the `backend` service until the contract
>   PR (the rollback's previous `apps/api` needs it).
> - **H-8 (owner, 2026-10-17, security and main conditions folded in).** The cutover's database
>   steps run on **the owner's machine**, over the owner's **Tailscale route to Railway's private
>   network**, from a clean checkout of the promoted commit, no longer inside the auth image.
>   `apps/auth`'s image is the service only again: no Postgres client, no PGDG repository, no
>   migration SQL, no marker. This **supersedes the earlier ruling** that the copy runs only
>   inside the auth image, so that the hashes never transit an operator machine. The owner's
>   reason: no Postgres tooling in a service image for a one-time process. Security's framing:
>   the owner's Railway access already reveals both database URLs, so the marginal exposure is
>   the copy stream (emails and bcrypt hashes) passing through that machine's memory over
>   WireGuard, with no file ever written. The marker becomes an operator-environment check
>   (`apps/auth/scripts/cutover/operator-env.sh`): both URLs set and different, hosts
>   `<name>.railway.internal` only (Railway's public proxy `*.proxy.rlwy.net` and anything else
>   refused), `psql` major 18, a clean checkout at `PROMOTED_COMMIT`, stdout a terminal. The
>   rehearsal seed also needs `ANSARI_CUTOVER_ENV=staging`. TLS on the private path is probed and
>   recorded at step 1. The staging rehearsal runs the same machine path, so it proves the
>   environment. **Residuals, owner-accepted:** the operator machine is in scope for the window
>   (full-disk encryption, no session recording, history off, screen sharing off: runbook step
>   1); the URLs live in that session for the window; and the staging guard for the seed is a
>   typed word, because an internal host name is the same in staging and production.
>
> This amendment supersedes every passage below about the internal credential, the internal
> listener, the private network, the forwarded IP and `AUTH_RATE_LIMIT_MODE`; those passages are
> amended in place where they are normative.
>
> **Lineage.** This spec is written for issue #300. Its evidence base is the issue #60 reference
> spec and plan (`codev/specs/60-better-auth-migration-reference.md`,
> `codev/plans/60-better-auth-migration-reference.md`), updated in #299 against better-auth 1.7.7.
> Those documents are not edited here. This spec carries their decisions forward, except where a
> **Departure** note says otherwise and why. Where the two disagree, this spec wins.

## Problem Statement

Production authentication in Ansari is a custom JWT system inside `apps/api`. It is hardened
(spec 4) and well tested. Every capability beyond email and password, though, would be custom
security code: OAuth, 2FA, email verification, passkeys. Each would need its own review, and
token rotation would need the same again (#16, #34). Issue #59 added a Better Auth stack
(`packages/auth`, `apps/auth`) alongside it, but nothing in production uses that stack.

The goal is to make Better Auth the **only** auth model without locking anyone out:

- Existing users keep their passwords and their UUIDs. Their threads, preferences and feedback
  stay attached.
- Everyone signs in once more after the cutover. Nobody needs a password reset.
- The **released mobile build**, which cannot be changed without a store release, keeps working.
  It has `/v2/users/login` and `/v2/users/refresh_token` compiled in, and logs the user out
  whenever `refresh_token` returns non-OK. The **legacy web frontend** (`legacy/frontend-web`) is
  retired at go-live: the `apps/frontend` web build replaces it in the same window (owner,
  2026-10-16; see Current State).

The primary failure mode is **silent mass lockout**. Every irreversible step in this spec is
weighed against it. Secondary failure modes are a weakened security posture (rate limiting
collapsing into one global bucket, system accounts becoming loginable, revocation weakening) and
production releases frozen behind half-shipped cutover code.

**Affected:** every Ansari user (web, released iOS/Android build, new `apps/frontend`), admins, the
operator who runs the window, and every other developer whose releases share `develop`.

## Current State

Verified on this branch, `develop` at `2eb3fdc` plus the porch init commit.

**Legacy auth (`apps/api`), which serves production:**

- `lib/auth/jwt.ts`: HS256 access, refresh and reset tokens that embed `session_version`.
  `lib/auth/middleware.ts` `authenticateRequest` verifies the token, looks it up in `tokens`
  through `findToken`, and compares `session_version` against the user row.
- `lib/db/users.ts`:
  - `issueTokenPair`, `storeToken`, and `lookupRefreshToken` with reuse detection
  - `markTokenRotated`, with a 60-second grace window
  - `bumpSessionVersion`, which kills every session for a user
- `public.users` columns:
  - `id` (uuid), `email` (unique), `password_hash` (bcrypt, 12 rounds, `NOT NULL` even for
    system accounts), `first_name`, `last_name`
  - `source` (default `'web'`), `registered_via`, `is_admin`, `system_key` (unique), `session_version`
  - `created_at` and `updated_at`, both `timestamptz`
- Four tables reference `users.id` with `ON DELETE CASCADE`: `tokens`, `threads`, `preferences`
  and `feedback`. `shares`, `messages` and `tool_call_orphans` reach users only through `threads`.
- Twelve route files call `authenticateRequest` or `requireAdmin`, all under `src/app/api/v2/`:
  - `admin/stats`, `feedback`, `preferences`
  - `share/[id]`, `threads`, `threads/[id]`
  - `threads/[id]/chat`, `threads/[id]/documents`, `threads/[id]/name`, `threads/[id]/share`
  - `users/logout`, `users/me`

  The plan re-runs the grep before the switch.
- Legacy routes and their response shapes today, which the clients' wire schemas pin:
  - `POST /v2/users/register` → `{status, access_token, refresh_token, token_type}`
  - `POST /v2/users/login` → `{status, access_token, refresh_token, token_type, first_name, last_name}`
  - `POST /v2/users/refresh_token` → `{access_token, refresh_token, token_type?}` (no `status`)
  - `POST /v2/users/logout` → `{message}`. It bumps `session_version` and deletes **all** of the
    user's tokens, which logs the user out everywhere.
  - `GET /v2/users/me` → `{id, email, first_name, last_name, source, created_at, updated_at}`
  - `DELETE /v2/users/me` deletes the account.
  - `POST /v2/request_password_reset` sends a 1-hour reset JWT stored in `tokens`, and answers
    identically for unknown emails. `POST /v2/reset_password` consumes the token and kills every
    session.
  - Reset links use the shape `${FRONTEND_URL}/reset-password?token=…` (`lib/email.ts:21`).
- Admin is the `is_admin` flag, set out-of-band by `apps/api/scripts/grant-admin.ts`.
  `lib/auth/startup-checks.ts` asserts at production boot that every `ADMIN_EMAILS` entry is an admin.
- System accounts (`ai-skill`, `leaderboard`) are found by `system_key` and provisioned lazily.
  The `@system.ansari.chat` addresses are reserved at registration.
- `lib/rate-limit.ts` `getClientIp` takes the **first** `X-Forwarded-For` entry, then `X-Real-IP`.
  Its only caller is `/v2/mcp-complete`. Login and register have **no** rate limit.
- `next.config.ts` sends `Access-Control-Allow-Origin: *` together with
  `Access-Control-Allow-Credentials: true` for `/api/*`. Browsers reject that combination.

**Better Auth scaffold (#59), not used in production:**

- `packages/auth/src/schema.ts` has singular, text-id tables (`user`, `session`, `account`,
  `verification`) in `public`, with timestamps that have no time zone.
  - `account` has no unique `(user_id, provider_id)`.
  - There are no additional fields.
- `createAuth()` contains only `emailAndPassword: { enabled: true }`, `trustedOrigins` and the
  `expo()` plugin. It has:
  - no `bearer()`, `admin()` or `generateId`
  - no rate-limit config
  - no custom password verify
  - no `revokeSessionsOnPasswordReset`
- `packages/auth/drizzle/0000_better_auth_init.sql` has **no production apply step** in `RELEASE.md`.
- `apps/auth` (Express + `toNodeHandler`) has a CI job but **no Dockerfile and no Railway
  service**. Production deploys only `backend` (`apps/api`) and the web frontend.

**Clients:**

- **Released mobile build** (`legacy/frontend-app`): uses `/v2/users/*` with a JWT bearer, and logs
  out on any non-OK refresh.
- **`apps/frontend`**: also uses `/v2/users/*` (`lib/auth/api.ts`). Its refresh on 401 is
  single-flight, and it stores tokens in SecureStore on native and `localStorage` on web. It
  contains **no** Better Auth client.
- **Legacy web frontend** (`legacy/frontend-web`): also a `/v2/users/*` client with JWT bearer and
  refresh (`src/services/ApiService.ts`, `src/store/slices/authSlice.ts`). **It is in production**
  (owner, 2026-10-16) until the window, where it is **retired**: the `apps/frontend` web build
  replaces it in the same window, and the rollback restores the previous legacy web deployment
  (owner decision, 2026-10-16). It is therefore not a frozen-contract client and not part of the
  unmodified-client staging run.
  - Finding (plan phase 1, 2026-10-16): its `refreshAccessToken` throws unless the refresh
    response carries `status === 'success'` (`src/services/ApiService.ts:110-112`), while
    `apps/api`'s `refresh_token` returns no `status`. So every refresh succeeds on the server
    (rotating the refresh token), the client discards the new pair and dispatches `resetAuth`,
    and the user is logged out at each access-token expiry (2 hours by default). With a
    15-minute JWT that would be every 15 minutes.
  - Decision (owner, 2026-10-16): option (a). The refresh shape stays frozen with no `status`,
    and legacy web is retired at go-live rather than accommodated.
  - Consequence (owner, 2026-10-16, path A): `apps/frontend` must serve the pages live links
    point at before the window, as plan phases 10b and 10c and window preconditions: #304
    (forgot-password, and `/reset-password?token=` in the exact legacy shape) and #306
    (`/delete-account`). The `/v2/users/*` layer and the two reset routes on `apps/api` remain
    after cutover for the released mobile app.
- **No outside service calls Ansari with a user's token** (owner, 2026-10-16). Outside callers use
  the machine paths below, so nothing outside the listed clients needs to sign in again.
- **Admin analytics page** (`apps/api/src/app/admin/analytics/page.tsx`): posts to
  `/v2/users/login` and reads `access_token`.
- **Machine callers, not users:**
  - `/api/v1/chat/completions` (the leaderboard): `Authorization: Bearer <LEADERBOARD_API_KEY>`,
    checked in the route with a constant-time compare (`route.ts:91-131`), acting as the
    `leaderboard` system account.
  - `/api/v2/mcp-complete` (the AI skill): no credential, IP rate-limited, acting as the `ai-skill`
    system account.
  - `X-Ansari-Client` is attribution only (`lib/attribution.ts`), never authentication.
- `prototypes/ansari-expo`, which the reference documents name as a client, **does not exist** on
  this branch.

**Release mechanics:**

- `main` deploys automatically and is promoted **only by fast-forwarding** to a `develop` tip
  (`RELEASE.md`).
- Migrations are reviewed SQL, applied with `psql` before the deploy. They must be
  backward-compatible with the code still serving traffic, and are never rolled back.
- `apps/api/tests/migration/migration-schema-parity.test.ts` builds the database from the
  `apps/api` journal only (`DEPLOYED_THROUGH = '0008_model_provenance'`). It never reads
  `packages/auth/drizzle`.

**Migration framework:** the reference plan defers the SQL to a "ported migration framework"
(attributed to Waleed). It **does not exist anywhere in the repo**, and the owner confirmed none is
needed: Waleed is not involved in auth, and the cutover is a plain `INSERT … SELECT` from the old
tables to the new ones while the system is in maintenance mode.

## Desired State

After the cutover:

1. **One auth model, one auth service.** Better Auth, running as the **`apps/auth` service**, is the
   only place that signs users in, signs them up, resets passwords or manages sessions. Better Auth
   sessions are the only session primitive. The legacy HS256 JWT code no longer exists, and
   `tokens`, `session_version`, `is_admin` and `password_hash` are unused from the window and
   dropped by the contract migration after the rollback deadline. `apps/api` contains **no sign-in, sign-up or session logic**, and
   does not import `better-auth`.
2. **Same users, same passwords, same ids.** Every legacy user exists in the auth database's
   `auth.users` under the same UUID and signs in with the existing password, through a permanent
   bcrypt + scrypt dual verify. `public.users` stays in the app database under the same ids, so
   threads, preferences and feedback and their foreign keys are untouched.
   **Guest accounts are migrated as-is (owner decision, 2026-10-15).** Guests are ordinary user
   rows with no flag: `guest_` followed by 10 alphanumeric characters, at `askansari.ai` (legacy
   app) or `ansari.chat` (`apps/frontend`), named "Welcome Guest". They are deliberately **not
   filtered**, so their threads, feedback and preferences stay attached.
   Cleaning them up is a follow-up.
3. **Two databases.** All Better Auth tables live in the `auth` schema of a **separate auth
   database** that only `apps/auth` can reach: `auth.users`, `auth.session`, `auth.account`,
   `auth.verification`, `auth.rate_limit` and `auth.jwks`. The app database keeps `public.users`,
   without `password_hash`, `is_admin` or `session_version` once the contract migration has run, and
   `apps/api` reaches only the app database.
4. **`apps/api` authenticates by verifying a JWT.**
   - Each request carries `Authorization: Bearer <JWT>`, issued by `apps/auth` through Better
     Auth's JWT plugin.
   - `apps/api` verifies it **statelessly** against the public keys `apps/auth` publishes at its JWKS
     endpoint: signature, `alg`, `iss`, `aud` and `exp`. There is no shared secret and no per-request
     session lookup. Keys are cached, and an unknown `kid` causes a re-fetch.
   - The user's identity is the `sub` claim, which is the user's UUID.
   - `/api/v1/chat/completions` keeps its `LEADERBOARD_API_KEY` check, and `/api/v2/mcp-complete`
     stays public. There is no global `middleware.ts`.
5. **Two token kinds.** The JWT is a short-lived **access token**. The Better Auth **session token**
   is the long-lived credential: it can be exchanged at `apps/auth`'s `GET /api/auth/token` for a
   fresh JWT, and it is what logout and reset revoke. This maps directly onto the legacy pair.
6. **The `/v2/users/*` compatibility layer** and the two password-reset routes stay **on `apps/api`**
   at their current URLs.
   - Each route **calls `apps/auth` over HTTP** and translates the result into the legacy JSON.
     `login` and `register` return `access_token` = JWT and `refresh_token` = session token.
     `refresh_token` exchanges the session token for a new JWT.
   - Responses are **wire-contract-compatible** with today's: same status codes, field names, field
     presence and types. Dynamic values such as tokens and timestamps naturally differ.
   - The released mobile build and the admin analytics page keep working, and their users sign in
     once more.
7. **`apps/frontend` signs in directly against `apps/auth`** with a Better Auth client from the
   cutover, and sends the JWT to `apps/api`. This change is agreed with the app architect first.
8. **Admins are identified by the admin plugin's `role`** in the auth database, assigned by
   `grant-admin.ts`, which moves to `apps/auth/scripts/` (same name, one script) and runs against
   the auth database. Admin is never an email match. `ADMIN_EMAILS` is removed from `apps/auth`
   (H-7): no reservation, no boot assertion; `grant-admin.ts` promotes by id with a confirmation. **Admin routes
   on `apps/api` ask `apps/auth` for the role on each request** rather than trusting a claim, so a
   demotion takes effect immediately, and they fail closed when `apps/auth` is unreachable.
9. **System accounts are identified by `system_key`** on `public.users`, and exist **only in the app
   database**. They have no auth-database row and no credential, so they cannot sign in or reset a
   password. `getOrCreateSystemUser` (`apps/api/lib/db/users.ts:54`) keeps provisioning them lazily,
   as today, because `apps/api` writes its own database.
10. **Rate limits are configured as decided:** sign-in 5/60s, sign-up 3/60s, database storage,
    `enabled: true`.
    - **Password-reset requests have their own limit** (security review of c19f247), because
      `apps/auth` now sends the emails and an unlimited path would be a mail-bombing and cost
      channel against any known address. The request path is limited **per client IP**
      (`X-Real-IP`, as for sign-in) **and per normalized email**, with the numbers set in the plan.
      **Every request counts**, not only failures. An unknown email gets the identical response and
      consumes the same budget, so the limit reveals nothing about which addresses exist.
    - They are enforced by `apps/auth`'s Better Auth router, and are keyed by the **real client
      IP**, which comes from `X-Real-IP` (see Client IP below).
    - Calls from the compatibility layer reach that same router anonymously, with `apps/api`'s IP,
      so none of their paths is keyed by IP there; `apps/api` limits the layer per client IP (H-4).
11. **Revocation is bounded by the JWT lifetime. This is the accepted cost of the owner's JWT
    decision.**
    - Today, a revoked session is rejected on its very next request, because every request checks
      `session_version`.
    - After cutover, password reset (`revokeSessionsOnPasswordReset: true`), logout (all of the
      user's sessions, as today), a ban, and account deletion each kill the **session token** at
      once, so no new JWT can be minted from it.
    - A JWT already issued stays valid at `apps/api` **until it expires**. The access-token lifetime
      therefore *is* the revocation window: Better Auth's default of **15 minutes** (owner,
      2026-10-16; `sign.mjs:81`). There is **no per-request session check** (owner, on the security
      architect's recommendation), because with two databases it would be an HTTP call on every
      request and a hard dependency of all of `apps/api` on `apps/auth`.
    - Two kinds of request close that window: admin authorization, which asks `apps/auth` (item 8),
      and any request whose `sub` has no `public.users` row or is tombstoned (deletion).
12. **Sessions** last 30 days and are refreshed daily (`expiresIn` 30d, `updateAge` 1d), as the
    issue decided and the owner confirmed on 2026-10-16. Better Auth 1.7.7's own defaults are 7 days (`internal-adapter.mjs:23`) and 1 day
    (`create-context.mjs:147`). The session is what keeps a user signed in: the client exchanges it
    for a fresh JWT whenever the JWT expires, and each exchange after `updateAge` slides the
    session's expiry forward. A user is asked to sign in again only after 30 days without using the
    app, or after a logout, password reset, ban or deletion.
13. **Production releases are never blocked.** Nothing from this project merges before the window
    (the cutover PR merges at the window), so every other change keeps promoting normally. `apps/auth` is **not deployed to
    production before the window**.

### Client IP for rate limiting (resolves an issue "must be resolved" item)

**Decision: read the client IP from `X-Real-IP` alone.** Better Auth gets
`advanced.ipAddress.ipAddressHeaders: ['x-real-ip']` with `trustedProxies` unset. The
apps/api's `lib/rate-limit.ts` `getClientIp` resolves the IP the same way, from `X-Real-IP` only
and never from `X-Forwarded-For`, and uses it for the layer's per-IP limits (H-4). Nothing
forwards it to `apps/auth`: the layer's calls are anonymous.

Evidence:

- **Railway's documentation** (Public Networking → Specs & Limits) names `X-Real-IP` as the header
  that identifies the client's remote IP. It does not mention `X-Forwarded-For`, publishes no proxy
  IP ranges, and says the specs may change.
- **Railway staff** said on Central Station in September and October 2026 that the edge overwrites
  `X-Real-IP` and `X-Forwarded-For` and does not append to a caller's values. They also said that a
  caller cannot forge `X-Real-IP` through the public edge, and that proxy CIDRs are not published
  and not stable. Community reports about whether `X-Forwarded-For` is overwritten or appended
  contradict each other, and one user saw extra hops.
- **better-auth 1.7.7** (`@better-auth/core` `dist/utils/ip.mjs`):
  - Without `trustedProxies`, any header holding more than one address resolves to **no IP**
    (`:190-193`).
  - Every request with no IP shares a single bucket per path, `no-trusted-ip|<path>`
    (`better-auth` `dist/api/rate-limiter/index.mjs:236-248`). At 5 sign-ins a minute, that bucket
    becomes a global login cap.
  - A single-valued `X-Real-IP` uses the one-value branch. IPv6 addresses are grouped to /64 by
    default.
- **Rejected:** `X-Forwarded-For` + `trustedProxies`. It needs proxy ranges that Railway says it
  will neither publish nor keep stable. **Also rejected:** plain `X-Forwarded-For`. It collapses
  into the shared bucket the moment Railway adds a hop. It is also what today's `getClientIp`
  trusts first, which lets a client pick its own bucket if the edge ever appends.

The documentation establishes only that the header exists. The overwrite guarantee is a staff
statement, staff answers on the forum conflict, and Help Station threads report `X-Real-IP`
sometimes carrying **Railway infrastructure IPs** instead of the client's. So the header **must be
verified empirically on a deployed service before production depends on it** (owner amendment
R-2: staging, deployed from `develop` after the merge, on both the Cloudflare and the direct
path). **Owner amendment G-2 (2026-10-16):** the production domains are probed in the window
through diagnostic routes, because they cannot be probed before the merge without deploying project
code to production. Before the merge they get a passive DNS and proxy-chain check, and production
ships in the mode the staging verdict chose. The check passes only if it proves both properties:

1. **Overwrite.** Forged `X-Real-IP` and `X-Forwarded-For` values sent through each public domain
   (both production domains and the `*.up.railway.app` domain), over IPv4 and over IPv6 where
   reachable, never come back as the observed `X-Real-IP`.
2. **Distinctness.** Two clients on different networks (for example a home connection and a mobile
   hotspot, or two cloud hosts in different regions) observe two different `X-Real-IP` values, each
   equal to that client's own public address, across repeated requests. A value that is the same
   for both clients, or that falls in a non-public range, fails the check.

The method, raw observations and verdict are recorded in `docs/cutover/edge-check.md` and the
review. **Until the staging check passes, `develop` is not promoted** (owner amendment R-2).

**Fallback if the check fails** (either property). Per-IP limiting is then not trustworthy: it is
either spoofable or collapses into a shared bucket. The fallback changes how the layer keys and
counts its sign-in limit.

- **Sign-in is keyed by the normalized target email, and only failed attempts count.**
  - Five failed sign-ins for one email within 60 seconds lock that email for the rest of the
    window. While the lock lasts, every sign-in for it is rejected with 429, including one with the
    correct password.
  - A successful sign-in never consumes budget, so legitimate users do not burn their own allowance.
  - A sign-in that fails while locked does not extend the lock.
- **Sign-up** keeps a per-email limit (3/60s) plus a **global ceiling** sized from current
  production sign-up volume. A misattributed IP can therefore never become a global cap.
- **Per-IP limiting** remains only as an *additional* key where the IP is trustworthy, and never as
  the only key.
- **Alert on list-walking.** When per-email limit hits span many distinct emails in a short period
  (the threshold is set in the plan from production baselines), an alert fires through the existing
  Sentry path. It logs counts and hashed or truncated identifiers only, never raw emails. This is
  the signature of an attacker walking an email list, which nothing else caps once per-IP is
  untrusted.
- **Accepted residual risk, stated explicitly:** anyone who knows a user's email can lock that user
  out of sign-in.
  - Bound: one 60-second window per burst of five failures. A sustained lockout needs a sustained
    five failures per minute against that email, and the list-walk alert surfaces it.
  - Existing sessions are unaffected. Password reset stays available, under its own limit
    (Desired State item 10).
- The fallback is implemented in `apps/auth`. Every sign-in, direct or through the layer, passes
  through it. The IP finding is written into `arch.md`.
- The security architect is told before the PR proceeds, and the fallback is the configuration the
  PR ships with.
- **Owner amendment G-1 (2026-10-16):** the fallback is built in every case, selected by
  `AUTH_RATE_LIMIT_MODE` (`ip` | `email`, default `email`). A failed check, including the in-window
  production probe, switches the mode without a code change. **Superseded by H-4 (2026-10-17):**
  the switch is removed and per-email is the only mode, because the layer's anonymous calls reach
  `apps/auth` with `apps/api`'s IP.

**The layer's calls to `apps/auth` are anonymous, so no limit on their paths is keyed by IP (H-4).**
When a `/v2/users/*` route calls `apps/auth`, the TCP peer is `apps/api`, not the user, and the
edge stamps `apps/api`'s egress IP as `X-Real-IP`. A per-IP rule on any path the layer calls
would put every legacy client in one bucket, which is exactly the global login cap this section
exists to prevent. Requirements (R1):

- every path the layer calls (`/sign-in/email`, `/sign-up/email`, `/request-password-reset`,
  `/reset-password`, `/token`, `/get-session`) has its router rule set to `false`, which also
  keeps the router's per-IP default off them; the account endpoints sit outside the router
- `apps/auth` limits them per email, per session token, per user or globally instead
- `apps/api` limits the layer's routes per client `X-Real-IP` itself, before calling `apps/auth`
- a test fires more than the router's default maximum from one IP across two users and gets no
  429 from `apps/auth`, while the per-email and per-session rules still trip

**Owner: TEMPORARY, until the legacy system is replaced.** The cost, accepted: a client that calls
`apps/auth` directly gets no per-IP limit on reset or the session exchange, only per-email,
per-session and global ones, and `apps/api`'s per-IP store is per instance.

### Hosting and token model (owner decisions, 2026-10-15)

**Hosting: `apps/auth` is its own production service.** This follows reference spec Q5. It also
fixes the gap this spec found: `apps/auth` has no Dockerfile and no Railway service today. So this
project adds:

- A Dockerfile and a Railway service for `apps/auth`. Both are main-architect hunks.
- **Its own public domain** (owner, I-5): **`auth.askansari.ai`** in production and
  **`auth-staging.askansari.ai`** in staging. Each environment's JWT `iss` is that origin, and the
  edge check covers both domains.
- Production config through `@ansari/auth` `getEnv()`, with any new variables added to `turbo.json`
  `globalEnv` by the four-way rule.

**Not in production before the window.** `apps/auth`'s code, Dockerfile and service reach
production only when the cutover PR merges, at the window. Its auth database is created empty ahead
of time, and nothing reads it. In the window, `apps/auth` is deployed after the copy and its
audits, and its **public domain is attached after the copy and the admin roles, before `apps/api`
deploys** (H-5), because `apps/api` reaches it there from its first deploy. A reachable `apps/auth`
before the copy would accept sign-ups into `auth.users`, which the copy's emptiness guard would then
refuse. The edge check and the rehearsal use staging deployments from
`develop` after the merge (owner amendment R-2); the branch is never deployed.

**Token model: JWT via JWKS** (Better Auth's `jwt` plugin on `apps/auth`), alongside `bearer()` so
native and web clients can carry the session token without third-party cookies. Verified on the
installed 1.7.7:

- `GET /api/auth/token` exchanges a live session for a JWT (`dist/plugins/jwt/index.mjs:141`).
  Calling `get-session` also returns one, in the `set-auth-jwt` header (`:194-207`).
- The JWKS is served at `/api/auth/jwks` (`:26,45`). Keys live in the `jwks` table, in the auth
  database's baseline migration. Private keys are encrypted at rest with the secret.
- Defaults are EdDSA (Ed25519, `sign.mjs:32`) and a lifetime of `15m` (`sign.mjs:81`). `iss` and
  `aud` default to the base URL origin (`:86-88`), and this project sets both explicitly.
- **By default the payload is the whole user object** (`sign.mjs:119`), which would put email,
  names and `system_key` into every token. `definePayload` restricts it to what `apps/api` needs:
  `sub`, plus the session id. `role` is asked of `apps/auth` on admin requests (Desired State
  item 8).

`apps/api` verifies tokens with a standard JOSE library against the cached JWKS. It pins `alg` to
the configured algorithm, rejects `none` and every other algorithm, and requires `iss`, `aud` and
`exp`. When `apps/auth` is down, tokens already issued still verify from the cache, so existing
users keep working until their JWT expires. Sign-in and refresh do need `apps/auth`.

**The whole admin HTTP surface on `apps/auth` is disabled** (security review, 2026-10-15).

- **Why.** With `apps/auth` public, the admin plugin would expose impersonation and 13 more
  endpoints behind a single admin session:
  - set-user-password, set-role, create-user, remove-user, update-user
  - ban-user, unban-user
  - list-users, get-user, list-user-sessions
  - revoke-user-session(s), has-permission

  A stolen admin token, or XSS on the frontend, would then mean takeover of any account. Nothing
  needs these endpoints, because roles come from the role script. `change-email` and `update-user`
  are blocked the same way, so the profile copy in the app database cannot drift.
- **The plugin stays.** It is kept only for its `role` column (and the related columns).
- **`disabledPaths` alone is not enough.** It matches only the exact normalized path
  (`dist/api/index.mjs:166-168`). So `apps/auth` also blocks the admin prefix case-insensitively in
  an Express middleware placed **before** `toNodeHandler`, and it covers trailing-slash and
  percent-encoded variants.
- **Re-enabling.** The owner can re-enable specific endpoints later, by explicit decision.

**`trustedOrigins` matters again.** `apps/frontend` on the web now talks to `apps/auth` directly.
Its web origin is allowlisted, `trustedOrigins` is still not treated as a boundary for custom
schemes (re-verified on 1.7.7), and #266's vacuous origin test is fixed so that it fails on a
wrong origin.

**Departures and their costs, recorded:**

| Decision | Departs from | Cost accepted by the owner |
|---|---|---|
| JWT via JWKS in `apps/api` | Issue decided item "apps/api authenticates with the bearer plugin"; reference plan "How apps/api authenticates" | Revocation lags by up to the JWT lifetime (Desired State item 11). Key management (`auth.jwks`, rotation). An extra token exchange on every refresh |
| Layer calls `apps/auth` over HTTP | Reference plan's in-process `auth.api.*` calls | An anonymous pass-through to the public endpoints (H-4), with per-IP limits moved into `apps/api`. A network dependency on `apps/auth` for every legacy sign-in |
| `apps/frontend` on `apps/auth` at cutover | (none; matches the reference) | An app-architect-agreed client change ships inside the window (I-6) |
| `apps/api` CORS is a static wildcard with no credentials (security architect, 2026-10-16, phase 9) | Plan phase 9 "`Allow-Origin` is the allowlist"; scenario 28's "no allow response" for `apps/api` | Any origin may read an `apps/api` response to a request it can already make with a token it holds. No credentialed CORS: `Allow-Credentials` is never sent, so a browser refuses every credentialed cross-origin request. The allowlist was dropped because `next.config.ts` headers are compiled at build (the image builds with the dummy `.env.ci`) and a runtime list would need the global middleware the spec forbids plus a variable whose misconfiguration takes the web app down in the window. `apps/auth` keeps its exact allowlist |
| Separate auth database from the start (2026-10-16) | Issue decided item "FKs on `threads`, `preferences`, `feedback` repointed to `auth.users.id`"; the reference's single database | A second Railway Postgres with its own backups; a cross-database copy that is ordered and gated, not atomic; app rows created on first use; deletion through a tombstone; admin role over HTTP |


**Legacy-surface behaviour changes, accepted by the security architect (2026-10-16, phase 8).**
None of these is pinned by the phase 1 contract fixtures, which pass unedited. Each is a response
the legacy `/v2/users/*` surface did not give before the cutover.

| Change | Before | After | Why |
|---|---|---|---|
| 429 passthrough | No limit on the legacy routes | `login`, `register`, `request_password_reset` and `reset_password` answer 429 `{detail: 'Too many requests. Please try again later.'}` with `Retry-After` when `apps/auth`'s limiter refuses | The shared database-backed budget (rate limits) must hold through the layer too |
| 503 on an `apps/auth` outage | (no such dependency) | 503 `{detail: 'Authentication service unavailable'}`, never a credentials error, on the layer routes and on first-use app-row creation and admin role checks | A dead `apps/auth` must never read as "wrong password" or log a client out |
| 8-character minimum on reset | A strong 7-character password was accepted by `reset_password` | Refused with the legacy weak-password `detail` (`Password is too weak. Use at least 8 characters`) | Better Auth's `minPasswordLength` (8), the same bound `register` already had |
| `register` refuses any `public.users` holder | Refused taken and reserved addresses | Also refuses an address any app row holds (a system account's row, an uncopied leftover), with the identical 409 | The app insert would otherwise fail after `apps/auth` had already created the user |
| System-account `DELETE /v2/users/me` | (system accounts could not sign in, so never reached it) | 403 `{detail: 'System accounts cannot be deleted'}` before anything is touched | "Two databases" rule 5, step 1 |

`apps/auth` is now the extraction that #49 describes, so #49 can be closed by this project once the
cutover lands.

### Two databases from the start (owner decision, 2026-10-16)

**Decision.** Better Auth gets **its own Postgres database** (the **auth database**), a new Railway
Postgres service. **Only `apps/auth` holds its credential.** `apps/api` keeps the **existing
database** (the **app database**) and has **no access to the auth database**. This supersedes the
earlier "one database now, split later" design (388371b to 70ddc4e): there is no later split.

**What stays in the app database.** `public.users` stays, under the same UUIDs, so `threads`,
`preferences` and `feedback` keep their foreign keys and `ON DELETE CASCADE` **unchanged**. Only
the auth-specific parts go: the columns `password_hash`, `is_admin` and `session_version`, and the
`tokens` table. They go in **two steps** (main architect, 2026-10-16), so that the 24-hour rollback
is a **redeploy, never a database restore**:

- **In the window, nothing legacy auth reads is dropped.** `password_hash` loses `NOT NULL`
  (`apps/api/drizzle/0000_baseline.sql:4`), so new users get a NULL hash. The new code neither
  reads nor writes any of the four legacy objects.
- **During the rollback window, no code reads the hashes.** The new Drizzle schema has no
  `password_hash`, `apps/api` has no raw `SELECT *` on `users` (grep, 2026-10-16), and a source scan
  pins both. The database account itself could still read them until the contract migration
  (owner decision: no separate logins; see Database accounts).
- **After the deadline, a contract migration drops them**, in the first release after the
  24-hour deadline passes (see Phasing).

What then remains is `id`, `email`, `first_name`, `last_name`, `source`, `registered_via`,
`system_key`, `created_at` and `updated_at`.

**What lives in the auth database.** All Better Auth tables, in an `auth` schema (this keeps the
issue's dedicated-schema decision): `auth.users`, `auth.session`, `auth.account`,
`auth.verification`, `auth.rate_limit` and `auth.jwks`. `auth.users` carries `first_name`,
`last_name` and `registered_via` as additional fields, plus the admin plugin's columns. It carries
**no `system_key` and no `source`**, because system accounts are app-only identities (rule 7).

**How the two databases stay linked.**

1. **One id.** A user's id is the same UUID in both databases. `apps/auth` generates it
   (`generateId: "uuid"`), and the JWT's `sub` carries it.
2. **Creating the app row.**
   - **Through the layer** (`/v2/users/register`): after `apps/auth` creates the user, the layer
     inserts the `public.users` row with the same id, email, names and `registered_via`.
   - **Directly at `apps/auth`** (`apps/frontend`): on the first `apps/api` request whose verified
     `sub` has no `public.users` row, `apps/api` fetches the user's profile from `apps/auth`'s
     `GET /api/account/me` **with that user's own JWT** (H-2) and inserts the row with
     `ON CONFLICT (id) DO NOTHING`. If `apps/auth` answers that the user does not exist, or that the
     token's session has ended, the request gets 401.
   - The same path repairs a layer registration whose insert failed.
   - **An email held under another id.** `ON CONFLICT (id)` does not cover `users_email_unique`
     (`apps/api/drizzle/0000_baseline.sql:10`). If another `public.users` row already holds the
     email (an uncopied legacy row, a system row, a leftover from a resolved collision), the
     request gets **401**, no row is written, and there is **no 500**. The pair of ids is logged,
     by id only, and an alert fires through the existing Sentry path.
   - **Defence in depth behind `apps/auth`'s sign-up hook:** this path also refuses any email on a
     reserved domain (`@system.ansari.chat`) and any email held by a `system_key` row, with the
     same 401, log and alert.
3. **Existence on each request.** `apps/api` reads `public.users` by `sub` in its own database, as
   it reads the user row today. A missing row that `apps/auth` does not know, or a tombstoned id
   (rule 5), gets 401.
4. **The profile copy cannot drift.** Email and names are copied once, when the app row is created.
   Better Auth's `change-email` and `update-user` endpoints are **blocked** on `apps/auth`, in the
   same way as the admin surface. Nothing uses them today, and the legacy API has no such route.
   Enabling them later needs a sync design, which is a follow-up.
   Better Auth's `change-password` is **blocked** the same way (amended 2026-10-17, security review
   of the cutover PR). No client changes a password while signed in, and the route enforces only
   the 8-character length and keeps the other sessions alive by default (`revokeOtherSessions:
   false`). A future change-password feature must add the strength guard that sign-up and reset
   run, and must revoke the user's other sessions.
5. **Deletion** (`DELETE /v2/users/me`) runs in this order:
   1. `apps/api` verifies the JWT, and refuses a **system account** before touching anything.
   2. In one app-database transaction, it deletes the `public.users` row (cascading threads,
      preferences and feedback) and writes a **tombstone** (`public.deleted_users`: `id`,
      `deleted_at`, `auth_deleted_at` null). The tombstone holds the id only, no personal data.
   3. It calls `apps/auth`'s `DELETE /api/account` with the user's own JWT (H-2), which removes the
      sessions and the auth user. "Already gone" is a 204, so the call is idempotent. Then it sets
      `auth_deleted_at`.

   **The delete endpoint is bound to the subject.** It deletes only the user the JWT names, verified
   against `apps/auth`'s own JWKS, and needs that token's session to be live unless the user is
   already gone. `apps/api` refuses before any call to pass a token whose `sub` is not the user
   being deleted. A direct call that bypasses `apps/api` is the H-6 residual.

   The profile path in rule 2 **never re-creates a tombstoned id**. If step 3 fails, any later
   request carrying that `sub` (and so that user's JWT), or the user's retry of `DELETE me`,
   retries step 3 before answering 401. The operator's completion script lists pending tombstones
   and deletes those auth users **directly in the auth database**; it never uses the
   endpoint. A failure therefore leaves an account that `apps/api` refuses, and never app data
   without a user.
6. **Admin role.** `role` lives only in the auth database. On **each admin request**, `apps/api`
   asks `apps/auth`'s `GET /api/account/me` for the user's role **with the admin's own JWT** (H-2),
   so a demotion, a ban or a revoked session still takes effect immediately. If `apps/auth` is unreachable, the admin route **fails closed** (503) and never
   grants access. The only admin route is `admin/stats`, so the traffic is small.
   - `ADMIN_EMAILS` does not move to `apps/auth`: it is removed (H-7). `apps/api`'s legacy one
     stays on the `backend` service until the contract PR, for the rollback only.
   - `grant-admin.ts` moves to `apps/auth/scripts/`, keeps its name, sets `auth.users.role`, and
     runs against the auth database.
7. **System accounts stay app-only.** `ai-skill` and `leaderboard` are `public.users` rows with
   `system_key`. They have no auth-database row and no credential, so they cannot sign in or reset
   a password. `getOrCreateSystemUser` keeps working as today, including its guard against a
   non-system row holding the address, because `apps/api` writes its own database.
   `@system.ansari.chat` stays reserved in `apps/auth`'s sign-up hooks and on the layer.
8. **No query crosses databases.** `apps/api` holds no auth-database credential, and `apps/auth`
   holds no app-database credential, and there is **no shared credential between them** (H-1).
   Every cross-service fact goes through `apps/auth`'s three account endpoints (H-2: `me` for the
   profile and the role, `revoke-sessions` for legacy logout, G-3, and `DELETE`), each asked with
   the user's own JWT at `apps/auth`'s public origin (`AUTH_URL`). A source scan pins that neither
   service's runtime code names the other database's connection, and another that no runtime code
   or config names the removed internal hop.

   **The account endpoints answer only for the token's subject.** No id appears in any path, so a
   caller learns nothing about anyone else. Requirements:
   - the token is verified with the algorithm, issuer, audience and expiry pinned, `sub` and `sid`
     required, and the session must still be live (`DELETE`: unless the user is already gone)
   - they are mounted **outside** Better Auth's handler path, so no per-IP rule applies
   - each has a per-user budget
   - an auth-database outage answers 500, never 401, so `apps/api` fails closed (503)
9. **No per-request session check** (owner, I-7). `apps/api` validates the JWT against the JWKS
   only. A check would be an HTTP call to `apps/auth` on every request and a hard dependency of all
   of `apps/api` on `apps/auth`.

**Database accounts (owner decision, 2026-10-16): Railway's default account for each database.**
No database logins, roles or grants are provisioned. Isolation comes from the **two databases**:
`apps/api`'s `DATABASE_URL` points only at the app database and `apps/auth`'s only at the auth
database, each with that database's Railway default account. The operator uses the same default
URLs for applies, audits and the copy.

This supersedes the earlier three-principal design (migrator and runtime role per database,
provisioning SQL, the `apps/api` re-point and password rotation, the runtime-role boot check, and
column-level grants), together with the provisioning PR the main architect required for it.

**Owner-accepted costs:**

- Each service can run DDL on its own database, so a compromised service could alter or drop its
  own tables. It still cannot reach the other database.
- `apps/api`'s account can read the legacy `password_hash` column until the contract migration
  drops it. Mitigations: no code reads it (the Drizzle schema has no such column, plus a source
  scan), and the contract migration is dated to the first release after the rollback deadline.
- The account used for migrations is the one in the service's environment, as it is today.

**What stays:**

- **No runtime code path names the other database's URL**, and there is no default or fallback
  connection string in code. A source scan pins both.
- The admin startup check stays, gated as today.

### Migration SQL location (resolves an issue "must be resolved" item)

**Decision: two journals, one per database.** No foreign key crosses databases, so the two journals
need no ordering between them. The main architect's seven conditions (issue #300, 2026-10-14 03:40Z)
were written for a single journal and **need re-review** (C-1). Conditions 1 to 4 and 7 carry over
to the app journal with the new content below. Condition 5 (`apps/api`'s config sees the `auth`
schema) is dropped. Condition 6 (retire the `packages/auth` journal) is reversed.

**Auth database journal: `packages/auth/drizzle/`.** It is kept, not retired. Its
`drizzle.config.ts` is already scoped to Better Auth's schema and cannot emit DDL against
`apps/api`'s tables.

- Its baseline is regenerated **as a fresh `0000`**, not an `0001` on top, for the new shape: the
  `auth` schema, UUID ids, `jwks`, `rate_limit`, the additional fields and the admin columns. This
  is safe **only because no deployed database has applied `0000_better_auth_init` through drizzle**
  (main architect). Local developers who ran `db:migrate` in `packages/auth` drop and recreate
  their local auth database; `CONTRIBUTING.md` and the PR description say so.
- **A drift guard covers it.** An auth-journal parity test, like
  `migration-schema-parity.test.ts`, with its own deployed-through marker, so the auth journal is
  never outside every check (the #165 outage class). The main architect owns the marker, with the
  same rule as the first: a bump is a human assertion, made in the PR that needs it.
- It is applied in the window, first, to the empty auth database, from `develop` at a recorded
  commit.

**App database journal: `apps/api/drizzle/`.**

- **Scaffold cleanup.** If the #59 scaffold tables (`public.user`, `session`, `account`,
  `verification`) were ever applied to the app database (a `psql \dt` question for the owner), a
  migration drops them with `IF EXISTS`, behind an **in-migration guard that aborts if any of them
  holds a row**.
- **Tombstones (additive).** `public.deleted_users`.
- **Window migration (cutover PR, applied in the offline window).** In one transaction, with
  guards, and **nothing else**:
  - normalize `email` to `lower(trim(email))`, aborting on any collision (the same guard as the
    copy below)
  - `ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL`

  Both are backward-compatible with the legacy code. **The owner** bumps `DEPLOYED_THROUGH`. A
  **schema freeze** runs from the cutover PR's merge to the end of the window.
- **Contract migration (contract PR, the first release after the 24-hour deadline passes).** It
  drops `password_hash`, `is_admin` and `session_version`, and drops `tokens`. It is **not**
  backward-compatible, so it is the **one named exception** to `RELEASE.md`'s rule, and it gets its
  own `DEPLOYED_THROUGH` bump. It has a date, not just "after the deadline": it merges in the first
  release after the deadline passes.
- **Numbering rule** (main architect's option (a)), unchanged: merge `develop`, run `drizzle-kit
  generate`, rename the `.sql` file and its journal tag by hand to the next real number, leave the
  snapshot named by index, and re-check after every `develop` merge. The dry run of 2026-10-14
  showed generate emitting `0008_*`, which collides with `0008_model_provenance.sql`.
- **pglite DDL.** More than twenty test files hand-write `users` or `tokens` DDL. The cutover PR
  updates the ones that the new code no longer needs, and the contract PR the rest, coordinated
  with #292.

**The cutover data copy** (owner: "a plain SQL query selecting from the old database into the new
one, while the system is in maintenance mode"). The operator runs it **from a Railway shell inside
the project, never from a laptop**, so the hashes never transit an operator machine. The two
databases' default URLs (as `APP_DATABASE_URL` and `AUTH_DATABASE_URL`) are entered for that session
only and stored nowhere: not in either database, not in a file, not in shell history.

1. **Export from the app database into the auth database.** `\copy (SELECT id, lower(trim(email)),
   first_name, last_name, password_hash, registered_via, created_at, updated_at FROM public.users
   WHERE system_key IS NULL) TO STDOUT`, piped into a `\copy … FROM STDIN` on an import table in the
   auth database. The **pipe never touches a file**. The import table is a temporary table created
   **in the same auth-database session** as step 2, so it is dropped on every failure path and a
   failed step 2 never leaves bcrypt hashes in a stray table.
2. **One auth-database transaction**, with guards that abort unless `auth.users` and `auth.account`
   are empty, the import is non-empty, and no two rows collide on the normalized email. Then:
   - `INSERT … SELECT` into `auth.users`: same `id`, derived `name`, `email_verified = true`. This
     is a **deliberate grant**: the legacy system never verified emails, and the issue decided to
     treat migrated users as verified. **No copied user is sent a verification email**, at the copy
     or later.
   - one `credential` account per row, with the bcrypt hash
   - drop the import table
3. **Cross-database audits** before step 4. The operator's script computes, on each side, over
   non-system users, and the two sides must match:
   - the row count
   - an ordered id checksum
   - a **hash checksum**: `md5(string_agg(password_hash, '' ORDER BY id))` on `public.users`,
     against the same over the `credential` rows' password column in `auth.account`, ordered by
     `user_id`. A corrupted or truncated copy is caught before the app migration.
4. **Apply the app-database window migration.**

The copy is **not atomic across the two databases**, so ordering and gates replace atomicity. A
failure in step 2 changes nothing. A failure in step 4 rolls back its own transaction and is
retried, with `apps/auth` not yet deployed.

**Rollback within the 24-hour deadline is a redeploy, never a restore.** Nothing legacy auth reads
has been dropped, so the runbook:

1. removes the users registered after the cutover, by `created_at` (their threads, preferences and
   feedback go with them through the cascade), because they have a NULL legacy hash and no usable
   legacy credential
2. redeploys the previous `apps/api` and `apps/frontend` deployments, and detaches `apps/auth`'s
   public domain

**Owner-accepted costs of rollback:** a password changed at `apps/auth` after the cutover reverts
to the legacy one (the user resets again), and users who registered after the cutover lose their
accounts. A snapshot or PITR mark of the app database is still taken immediately before the
window. The auth database is left as it is, with its domain detached, and a second attempt starts
by emptying it, because the copy's guard requires empty targets.

**Rejected:** `dblink` or `postgres_fdw`. Both store a cross-database credential inside a database,
and both need an extension.

**Every "idempotency helper"** the reference plan expected is replaced by these properties: each
step runs in one transaction, the guards refuse a non-empty target, and a re-run of the `account`
backfill inserts nothing, because of the unique `(user_id, provider_id)`.

**Environment per service** (names approved by the main architect on #300; the auth database is new):

| Service | Database credential | Other variables |
|---|---|---|
| `apps/auth` | `DATABASE_URL` = **auth database**, Railway default account | `AUTH_JWT_ISSUER`, `AUTH_JWT_AUDIENCE`, `RESEND_API_KEY` and `FRONTEND_URL` (reset emails are now sent by `apps/auth`, with the same sender and legacy link shape as `apps/api/lib/email.ts`), plus the existing `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `CORS_ORIGIN` |
| `apps/api` | `DATABASE_URL` = **app database**, Railway default account (unchanged) | `AUTH_URL` (`apps/auth`'s public origin, H-1), `AUTH_JWT_ISSUER` (set separately), `AUTH_JWT_AUDIENCE`, `AUTH_LAYER_ORIGIN`. No shared secret. The cutover PR removes `JWT_SECRET`, `ACCESS_TOKEN_EXPIRY_HOURS`, `REFRESH_TOKEN_EXPIRY_HOURS` and `ADMIN_EMAILS` |

For the copy, the operator's Railway shell holds both databases' URLs as `APP_DATABASE_URL` and
`AUTH_DATABASE_URL`, for that session only: never set on a Railway service, **never added to
`turbo.json` `globalEnv`** (they are operator-shell variables, not task inputs), never written to a
file. `RELEASE.md`'s `psql` steps name them. The source scan fails on either
name in runtime code.

`DATABASE_URL` keeps one name, with a different database per Railway service, so `turbo.json`
gains no database variable. The four `AUTH_*` names go into `globalEnv`, and the three `JWT_*`
names leave it in the cutover PR. `BETTER_AUTH_SECRET` and `RESEND_API_KEY` are secrets: each has
a Zod minimum length, is never logged, and uses the placeholder-not-a-real-* convention in
`.env.ci`. Local development uses two
databases on one local Postgres, both with owner URLs.

**Reviewers.** The main architect reviews both journals, their numbering and markers, the new
Railway Postgres service, the lockfile, `turbo.json` and CI. The
security architect reviews everything. The migration and copy SQL are High tier.

### Phasing (resolves an issue "must be resolved" item)

**Owner decision, 2026-10-16: one PR for the cutover.** The owner also decided that no database
logins are provisioned, so the provisioning PR the main architect required is gone. The main
architect's re-review (2026-10-16) still adds a **contract PR after the rollback deadline**,
because the destructive drops must wait for it; **the owner accepted it on 2026-10-16 (C-2).**
No unmerged SQL touches a deployed database: every SQL applied to one is applied from `develop` at
a commit recorded in the release notes.

| PR / stage | Reference phases | What happens |
|---|---|---|
| **1. Cutover PR, built on the branch** | 0 to 2 (code) | The `apps/auth` config (UUIDs, `auth` schema, dual verify, `bearer()`, `jwt()`, `admin()` kept for its columns with its whole HTTP surface blocked, `change-email` and `update-user` blocked, rate limiting and client IP, the account endpoints), its Dockerfile and service; the fresh `packages/auth` `0000`; the app migrations (scaffold cleanup, `public.deleted_users`, the window migration); the rollback SQL; the copy script and audits; the `apps/api` JWKS verification, app-row creation, tombstoned deletion, role calls and compatibility layer; the CORS fix; contract tests written first against today's implementation; removal of the legacy JWT code and the `JWT_*` config (and their `globalEnv` names), with `grant-admin.ts` moving to `apps/auth` (and `ADMIN_EMAILS` removed, H-7); the `apps/frontend` switch to `apps/auth` (agreed with the app architect); `RELEASE.md` and `CONTRIBUTING.md` |
| **Before the window** | 2 | **Owner amendment R-2.** Staging auto-deploy off; the cutover PR merges to `develop`, which is frozen until the production window. The window runbook runs on **staging** from `develop`'s merge commit: the empirical edge check (both paths), the **rehearsal** (including a rollback rehearsal) on the staging users seeded with every anomaly class (R-1) plus the empty staging auth database, and the unmodified clients. The evidence lands as a docs-only PR to `develop`. The empty production auth database is created on Railway (or found), with backups or PITR on before the first real row (C-4). Before the merge, the branch is kept current with `develop`, and the numbering is re-checked after every merge |
| **The window** | 3 | Merge and promote the cutover PR with `apps/api` offline: the app database's snapshot or PITR mark, the auth database's baseline, the copy and its audits, the window migration, admin roles, deploy `apps/auth`, `apps/api` and `apps/frontend`, smoke tests, then `apps/auth`'s public domain |
| **2. Contract PR** (the first release after the 24-hour deadline passes; owner, C-2) | 4 | The contract migration: drop `password_hash`, `is_admin`, `session_version` and `tokens`, with its own `DEPLOYED_THROUGH` bump; the remaining pglite DDL; `RELEASE.md` names it as the one exception |
| Out of this project (follow-up issues) | 4 triggers, 5 | Remove the layer (its trigger). A profile sync design before `change-email` or `update-user` is enabled |

**Why the code switch cannot hide behind a feature flag.** The Drizzle schema in `apps/api` either
has the legacy auth columns or does not, and the new code must not read `password_hash`. So the
code switch lands with the window. Rollback is the redeploy
described under the cutover data copy, never a code toggle.

**Costs, accepted by the owner.**

- A long-lived cutover branch must be kept current with `develop`. The numbering rule's re-check
  after every merge applies. After the merge, `develop` is frozen until the production window
  (R-2), so the staging rehearsal runs on exactly what production receives.
- The issue's "migrated before the window" for the `auth` tables no longer holds. The auth database
  is created empty beforehand, and its tables are created in the window's first step, which is
  quick on an empty database.
- `develop` must be releasable at the window, because promotion fast-forwards `main` to a `develop`
  tip that includes everything merged before the cutover PR.

The **verify** phase of this project is the cutover itself: smoke tests, the 24-hour watch, the
rollback deadline passing, and the contract PR's release.

## Success Criteria

**Schema and data**

- [ ] All Better Auth tables, `auth.jwks` included, are on `pgSchema('auth')` **in the auth
  database**. `user` maps to `auth.users` through `modelName`. Ids are UUIDs (`generateId: "uuid"`),
  and a UUID written by the Drizzle adapter reads back unchanged in a UUID column, proven by a test
  against a real database (pglite or Postgres).
- [ ] `auth.users` carries the additional fields `first_name`, `last_name` and `registered_via`
  (`registered_via` is `input: false`), plus the admin plugin columns (`role`, `banned`,
  `ban_reason`, `ban_expires`). `auth.session` carries `impersonated_by`. There is no `system_key`
  or `source` in the auth database. Column names are confirmed from the reviewed `drizzle-kit
  generate` output.
- [ ] `auth.account` has a unique `(user_id, provider_id)`.
- [ ] The `packages/auth` journal is the auth database's only journal, regenerated as a fresh `0000`,
  and an auth-journal parity test with its own deployed-through marker covers it.
- [ ] In the app database, the scaffold cleanup drops the #59 tables only when they are empty. Its
  guard aborts if any of them holds a row, and a test proves the abort.
- [ ] Auth timestamps are `timestamptz`, or the mapping is documented with a test showing that
  `created_at` and `updated_at` survive the copy exactly. The legacy values are `timestamptz`.
- [ ] **The cross-database copy** (Two databases section) runs as ordered, gated steps:
  - the export selects only non-system users, with **`email = lower(trim(email))`**
  - one auth-database transaction aborts unless the targets are empty and the import is non-empty,
    and **aborts if any two rows collide on the normalized email**
  - it inserts `auth.users` (same `id`, derived `name`, `email_verified = true`) and one
    `credential` account per user with the bcrypt hash
  - the cross-database audits pass before the app window migration runs
  - no cross-database credential is stored in either database, the pipe writes no file, the
    import table is a temporary table in the step-2 session, and the copy runs from a Railway shell
    inside the project, never an operator machine
- [ ] The window migration, in one transaction with guards, normalizes `public.users.email`
  (aborting on a collision) and drops `NOT NULL` from `password_hash`, and **does nothing else**.
  The foreign keys from `threads`, `preferences` and `feedback` to `public.users` are unchanged.
- [ ] The new code neither reads nor writes `password_hash`, `is_admin`, `session_version` or
  `tokens`. The Drizzle schema has none of them, and a source scan, negative-tested against a
  planted line, finds no raw SQL that names them or selects `*` from `users`.
- [ ] **Hashes are gone from the app database:** the contract migration drops `password_hash`,
  `is_admin`, `session_version` and `tokens`, with its own `DEPLOYED_THROUGH` bump, in the first
  release after the 24-hour deadline passes.
- [ ] Name derivation follows the reference rule:
  - `trim(first || ' ' || last)` when it is non-empty
  - otherwise the email local-part
  - otherwise `'User'`

  `name` is never split back into parts.
- [ ] A rehearsal audit reports the number of guest accounts matching the exact guest shape
  (`^guest_[A-Za-z0-9]{10}@(askansari\.ai|ansari\.chat)$`, name "Welcome Guest"). It is
  informational only and never blocks the cutover.
- [ ] Audits run after the copy and pass:
  - the row count and ordered id checksum of non-system `public.users` equal those of `auth.users`
  - the ordered password-hash checksum of non-system `public.users` equals that of the `credential`
    rows in `auth.account`
  - the number of `credential` rows equals the number of non-system users
  - **no system account exists in the auth database**
  - the set of `role = 'admin'` users equals the owner-approved inventory
- [ ] Re-running the `account` backfill on its own creates zero duplicate rows.
- [ ] **Email case is normalized, and collisions are decided before the window.**
  - Why: better-auth 1.7.7 lowercases the email on every lookup (`dist/db/internal-adapter.mjs:572`,
    `dist/api/routes/sign-in.mjs:318`, `dist/api/routes/sign-up.mjs:158`), while
    `auth.users.email` is unique case-sensitively. Legacy code lowercases on write
    (`lib/db/users.ts:106`), but that only covers rows written since the monorepo move. Older rows
    are unverified. A mixed-case row copied as-is could never be found, which is a silent lockout.
    The user would then re-register as a second user with a new UUID, detached from their threads.
  - A **read-only pre-window audit** counts rows where `email <> lower(trim(email))`, and lists every
    case-insensitive duplicate group. It runs in the rehearsal and again by the operator before the
    window.
  - The **owner decides every collision before the window**. The guards then find none.
- [ ] `DEPLOYED_THROUGH` moves once per app migration: the window migration's bump by the owner in
  the cutover PR, and the contract migration's own bump in the contract PR. Every
  app migration follows the numbering rule (merge `develop`, run generate, rename the `.sql` file
  and its journal tag by hand, keep the snapshot's index name, re-check after every `develop` merge).
- [ ] The pglite DDL in `apps/api` tests that names the dropped columns or `tokens` is updated,
  coordinated with #292.
- [ ] **Two databases, enforced.** `apps/api` has no auth-database credential, and `apps/auth` has
  no app-database credential. A source scan pins it, and also fails on `APP_DATABASE_URL` or
  `AUTH_DATABASE_URL` in runtime code and on any fallback connection string, negative-tested
  against a planted line.

**App rows, deletion and system accounts (`apps/api`)**

- [ ] A user created through the layer gets a `public.users` row with the same id at registration.
  A user created directly at `apps/auth` gets it on the first `apps/api` request, from
  `GET /api/account/me` asked with that user's JWT, with `ON CONFLICT (id) DO NOTHING`. Concurrent first requests create
  one row.
- [ ] A `sub` unknown to `apps/auth`, or tombstoned, gets 401 and never gets a row.
- [ ] A profile whose email is held under another id, is on a reserved domain, or is held by a
  `system_key` row gets 401, no row and no 500. The pair of ids is logged by id only, and an alert
  fires.
- [ ] The account endpoints refuse a missing, forged, foreign-key, wrong-algorithm, wrong-issuer,
  wrong-audience, expired or `sid`-less token, and a token whose session has ended (`DELETE`:
  unless the user is already gone, then 204 with no change). The operator completion script deletes
  as the auth database directly and never calls them.
- [ ] The account endpoints have no id in any path, are mounted outside the Better Auth handler
  path, have a per-user budget, and answer an auth-database outage with 500, never 401.
- [ ] `DELETE me` refuses a system account before deleting anything. Otherwise it deletes the app
  row (cascading) and writes the tombstone in one transaction, then deletes the auth user through
  `DELETE /api/account` with the user's JWT and marks the tombstone done. A failure after the first transaction is
  completed by the next request carrying that `sub`, by a retry, or by the operator script.
- [ ] System accounts are created lazily in the app database as today, and never appear in the
  auth database.
- [ ] `change-email`, `update-user` and `change-password` are blocked on `apps/auth`, with the same
  variant tests as the admin surface (`change-password` amended 2026-10-17).

**Credentials and sessions (`apps/auth`)**

- [ ] **Permanent dual verify:**
  - `$2a$` and `$2b$` hashes verify with bcrypt, keeping the 72-byte truncation of
    `lib/auth/password.ts`
  - anything else verifies with scrypt
  - new passwords hash with scrypt
  - a test **fails if the bcrypt branch is removed**
- [ ] A user migrated from a legacy-format row signs in with an unchanged password, both directly at
  `apps/auth` and through the layer's `/v2/users/login`, end to end against a real database.
- [ ] `revokeSessionsOnPasswordReset: true`. A test proves that a reset kills a live session (no new
  JWT can be minted from it) and **fails if the flag is removed**.
- [ ] Session lifetime is 30 days and is refreshed after 1 day, pinned by a test. Exchanging a
  session for a JWT slides its expiry once `updateAge` has passed, so a client that refreshes
  regularly is never logged out at the 30-day mark.
- [ ] After cutover no legacy HS256 JWT code exists, and no code reads or writes `tokens`,
  `session_version`, `is_admin` or `password_hash`, which the contract migration then drops from
  the schema, and `grant-admin.ts` lives in `apps/auth/scripts/`
  and sets `role`. `apps/api` has no `better-auth` dependency.
- [ ] **No admin plugin endpoint answers on `apps/auth`.** Every admin path, impersonation
  included, is listed in `disabledPaths` **and** blocked by an Express middleware placed before
  `toNodeHandler`, which matches the admin prefix case-insensitively. Tests cover:
  - exact paths, case variants, trailing slashes and percent-encoded variants
  - a **regression test that enumerates the admin plugin's endpoints from the installed package
    and fails if any of them answers** with anything other than the block response, even with a
    valid admin session

  The plugin stays configured for its `role` column. Re-enabling an endpoint requires an explicit
  owner decision.

**JWT issuance and verification**

- [ ] `apps/auth` issues EdDSA JWTs with:
  - an explicit `iss` (the `apps/auth` origin: `https://auth.askansari.ai`, or
    `https://auth-staging.askansari.ai` in staging) and an explicit `aud` (the `apps/api` audience)
  - a lifetime of **15 minutes**, Better Auth's default (owner), pinned by a test
  - a payload restricted by `definePayload` to `sub` (user UUID) and the session id

  No email, names, `system_key` or role go in the payload, and a test pins its exact key set.
- [ ] `apps/api` verifies every token against the cached JWKS. It pins the algorithm and requires
  `iss`, `aud` and `exp`, and each of the following is rejected with 401, by a test:
  - `alg: none` and any other `alg`
  - a wrong `iss` or a wrong `aud`
  - an expired token
  - a bad signature
  - a token signed by an unknown key
  - a legacy HS256 token
- [ ] An unknown `kid` triggers at most one JWKS re-fetch, rate-limited so that tokens carrying
  random `kid`s cannot turn `apps/api` into a request amplifier against `apps/auth`. A key rotation
  on `apps/auth` is picked up without restarting `apps/api`.
- [ ] With `apps/auth` unreachable, a valid unexpired JWT still verifies from the cache.
- [ ] A JWT whose `sub` has no `public.users` row and is unknown to `apps/auth`, or is tombstoned,
  gets 401 on any route that touches the user's data, never a 500 caused by a foreign-key error.
- [ ] **The revocation window is pinned.** After logout, reset, ban or deletion, a test shows:
  - the session token can no longer mint a JWT
  - an already-issued JWT is rejected once it expires
  - that window is at most the configured lifetime

  The review records the window as an accepted cost.

**`apps/api` authorization**

- [ ] Every route that used `authenticateRequest` or `requireAdmin` resolves its user from a
  verified JWT. The route set comes from a grep before merge, not from this list.
  - **Ownership checks are unchanged:** a user cannot read another user's thread.
  - Admin routes ask `apps/auth`'s `GET /api/account/me`, with the admin's JWT, **on each request**, and return the same
    401 and 403 codes as today. When `apps/auth` is unreachable they return 503 and never grant.
- [ ] `/api/v1/chat/completions` (`LEADERBOARD_API_KEY`) and `/api/v2/mcp-complete` behave as today.
  There is no global `middleware.ts`.
- [ ] **Existing admins are preserved deliberately.**
  - Before the window, the operator produces an inventory of every `is_admin = true` user.
  - The owner approves the post-cutover admin list.
  - The role script assigns `role = 'admin'` to exactly that list.
  - An audit checks that the set of `role = 'admin'` users equals the list.
- [ ] No boot assertion on admins (H-7). `grant-admin.ts` shows the account and grants only with
  `--confirm <its id>`; it refuses the system domain and warns on a recent or unverified account.

**Compatibility layer on `apps/api`: frozen contract**

- [ ] **Contract tests land first, written against today's implementation**, and pass **unchanged**
  against the new one. They pin, for `register`, `login`, `refresh_token`, `logout`, `me` (GET and
  DELETE), `request_password_reset` and `reset_password`:
  - status codes
  - field names and field presence (for example, `refresh_token` has no `status`)
  - error `detail`
  - the 401, 409 and 422 semantics
- [ ] Every layer route reaches Better Auth **only by calling `apps/auth` over HTTP**. It has no
  access to the auth database.
- [ ] Token mapping:
  - `login` and `register` return `access_token` = JWT, `refresh_token` = session token, and
    `token_type: 'bearer'`.
  - `refresh_token` exchanges the session token at `apps/auth` for a new JWT, and returns the same
    session token as `refresh_token`. It returns 401 once the session is revoked or expired.
- [ ] `apps/auth`'s bearer plugin keeps `requireSignature` **unset**, because the layer holds the
  raw session token and better-auth 1.7.7 accepts an unsigned bearer only in that case
  (`dist/plugins/bearer/index.mjs:34-37`). A test pins it: a raw session token from `login` mints a
  JWT, a tampered signed token is rejected, and the test fails if `requireSignature` is turned on.
- [ ] `logout` revokes **all** of the user's sessions, as today. The remaining JWT lifetime is the
  accepted window.
- [ ] `DELETE me` succeeds with a session created more than 24 hours earlier. It goes through an
  `apps/auth` account endpoint (`DELETE /api/account`) bound to the user's own JWT, which deletes the
  user through Better Auth's internal adapter. `auth.api.deleteUser` is not used, because it 404s unless
  enabled and enforces `freshAge`. The order is the one in "Two databases" rule 5: app row and
  tombstone first, then the auth user. Afterwards the session is dead and the user's threads,
  preferences and feedback are gone.
- [ ] Password reset:
  - The emailed link has the legacy shape `${FRONTEND_URL}/reset-password?token=<token>`.
  - Unknown emails get the identical response.
  - Reset requests are limited per client IP and per normalized email, counting every request;
    an unknown email consumes the same budget. A test shows that the per-email cap holds across two
    client IPs, and that the IP cap holds across many emails.
  - `RESEND_API_KEY` and `BETTER_AUTH_SECRET` have Zod minimum lengths, and a test shows neither
    appears in logs or error output, nor a user's JWT or session token in logs.
  - A system account receives no email and cannot gain a credential.
  - `checkPasswordStrength` runs before reset and before register.
- [ ] Reserved addresses (`@system.ansari.chat`) and the `system_key` guards return the same 409 as
  a taken email, on the layer **and** in `apps/auth`'s own sign-up hooks. The guard order in
  `register` is unchanged: validation → reserved/taken → strength → create.
- [ ] `register` still records `registered_via` from `X-Ansari-Client` (in both databases), and still
  passes `first_name` and `last_name` to the newsletter opt-in. `login` returns `first_name` and
  `last_name` from `public.users`.
- [ ] Clients run unmodified against the new layer in staging:
  - the released mobile flow: login, then a bearer call, then a 401 when the JWT expires, then
    refresh, then a retry
  - the admin analytics login
  (`legacy/frontend-web` is retired at go-live and is not in this run; see Current State.)
- [ ] **Machine callers are unchanged and cannot be confused with users.** The leaderboard key and
  a user JWT share the `Authorization: Bearer` header, so tests pin both directions: on
  `/api/v1/chat/completions`, a valid user JWT gets 401 and the key is never parsed as a JWT; on
  every JWT-verified route, the leaderboard key gets 401. No global middleware applies JWT
  verification to `/api/v1/*` or `/api/v2/mcp-complete`.

**`apps/frontend` and `apps/auth` deployment**

- [ ] `apps/frontend` signs in, signs up, resets passwords and signs out through `apps/auth`. It
  sends the JWT to `apps/api`, and refreshes it from the session. On the web it does not depend on
  third-party cookies. The change is agreed with the app architect before it is built.
- [ ] `apps/auth` has a Dockerfile and a Railway service, with its own Railway Postgres (snapshot or
  PITR enabled). Its watch paths include `packages/**`, and its healthcheck answers only when the
  auth database answers.
- [ ] `apps/auth` is not deployed to production before the window. In the window its public domain
  is attached only after the copy, the audits and the smoke tests. Before that, a check proves it
  is unreachable from the public internet.
- [ ] `apps/auth` CORS allowlists exactly the `apps/frontend` web origins, and exposes
  `set-auth-token` and `set-auth-jwt` to them. `trustedOrigins` matches. #266's origin test is made
  to fail on a wrong origin.

**Rate limiting and client IP**

- [ ] `apps/auth`'s `createAuth()` sets:
  - `rateLimit`: `enabled: true`, `storage: 'database'`, sign-in 5/60s, sign-up 3/60s
  - `advanced.ipAddress.ipAddressHeaders: ['x-real-ip']`
- [ ] Sign-in over the limit returns 429 directly at `apps/auth` **and** through `/v2/users/login`.
  Both paths draw from the same database-backed budget, shared across instances. The same holds for
  sign-up and register.
- [ ] A request carrying a two-entry `X-Forwarded-For` and a distinct `X-Real-IP` is limited under
  its `X-Real-IP`, not in a shared bucket. Forging `X-Forwarded-For` does not let a client switch
  buckets.
- [ ] **The layer (H-4, R1).** Two legacy clients with different IPs, calling through the layer,
  land in different buckets of `apps/api`'s per-IP limit. At `apps/auth`, more than the router's
  default maximum from `apps/api`'s one IP, across two users, draws no 429, while the per-email and
  per-session rules still trip. The layer forwards no client IP and no credential.
- [ ] `apps/api`'s `getClientIp` (used by `mcp-complete`, and by the layer to forward) reads
  `X-Real-IP` only. `tests/rate-limit.test.ts`, which asserts the opposite preference today, is
  updated.
- [ ] **Empirical edge verification is recorded** (method, raw observations, verdict). It is done on
  the staging domains (via Cloudflare and direct) and the `*.up.railway.app` domains, from
  `develop` after the merge and **before `develop` is promoted** (owner amendment R-2), plus a
  passive DNS and proxy-chain check of each production domain before the merge. It is done **in the window** on
  each production domain and on `apps/auth`'s domain once attached (owner amendment G-2). It proves
  both properties from the Client IP section:
  - forged `X-Real-IP` and `X-Forwarded-For` values never appear as the observed `X-Real-IP`
  - two clients on different networks see distinct `X-Real-IP` values equal to their own public
    addresses, never a Railway or private-range address
- [ ] The per-email limiter is the only sign-in and sign-up mode (G-1, superseded by H-4).
  Production ships in the staging-verdict mode, and tests pin each part of the fallback:
  - sign-in is keyed by email and counts failures only
  - a correct password is rejected while the email is locked
  - a successful sign-in consumes no budget
  - sign-up has a per-email limit plus a global ceiling
  - per-IP is used only as an additional key
  - the list-walk alert fires and logs no raw email

**CORS on `apps/api`**

- [ ] `apps/api/next.config.ts` no longer sends `Allow-Origin: *` together with
  `Allow-Credentials: true`. Authentication is a bearer JWT, so credentials are not needed for
  `/api/*`: `Allow-Credentials` is never sent, `Allow-Origin` stays `*`, and `Allow-Headers` lists
  `Authorization`, `Content-Type` and `X-Ansari-Client` (amended 2026-10-16, phase 9, by the security
  architect; see "Departures and their costs").

**Cutover and operations**

- [ ] A cutover runbook exists. It covers:
  - the downtime mechanism (remove both public domains from `backend`, or pause it, chosen in the
    rehearsal)
  - deploying `apps/auth` only after the copy and audits, and attaching its domain last
  - alert silencing and the snapshot or PITR baseline **of both databases**
  - the cross-database copy, its audits, the app window migration, admin roles, and attaching
    `apps/auth`'s domain
  - deploying `apps/api` and `apps/frontend`, then the smoke tests
  - the **24-hour rollback deadline**: remove the users registered after the cutover by
    `created_at`, redeploy the
    previous `apps/api` and `apps/frontend` deployments, and detach `apps/auth`'s public domain.
    It is a redeploy, never a database restore. After the deadline, fix forward.
- [ ] The rehearsal of the full runbook, **including the rollback** (removal of post-cutover users, redeploy of the previous image, which then serves legacy logins), runs on
  staging, from `develop` after the merge and before its promotion (R-2), on the staging users
  seeded with every anomaly class (R-1) and the empty staging auth database, never a database
  production uses. It passes all audits, then boots the cutover PR's
  `apps/api` and `apps/auth` against the rehearsed databases and passes the smoke tests.
- [ ] The cutover PR amends `RELEASE.md` with the auth database and its window steps (baseline,
  copy, audits, app window migration), each `psql` step naming `APP_DATABASE_URL` or
  `AUTH_DATABASE_URL` from the Railway shell. `CONTRIBUTING.md` states that dev and CI use two local
  databases with owner URLs. Every applied SQL is recorded with its `develop` commit in the release
  notes.
- [ ] The cutover and contract PRs also amend `RELEASE.md`:
  - it names the **contract** migration as the one exception to the backward-compatible rule
  - it records the schema freeze
  - it adds the `apps/auth` service
  - its smoke test and admin-bootstrap step are rewritten for Better Auth, which closes #33
- [ ] After cutover:
  - migrated users sign in with existing passwords through `apps/auth` and through the layer
  - the released mobile build works without a store release
  - no mass password reset happens
- [ ] `codev/resources/arch-critical.md`, `arch.md` and `packages/auth/README` are updated to match
  (see the Constraints delta), and every stale statement is fixed everywhere it appears.
- [ ] Follow-up issues are filed for:
  - the layer's removal
  - a profile sync design, before `change-email` or `update-user` is enabled
  - **guest cleanup after cutover**. Deleting a guest cascades its threads, so that issue must
    decide whether feedback is retained and what happens to shared links that point at guest
    threads.

  Separately, #16 and #49 are closed with the documented post-cutover behaviour.

## Constraints

### Decisions already taken (from issue #300, carried forward)

The issue has no section titled "Baked Decisions". Its "Decisions already taken (carry forward
unless the spec argues otherwise)" section is treated with the same weight. It is copied here
verbatim:

> - Single cutover with `apps/api` fully offline; no dual-run serving; 24h snapshot rollback.
> - All Better Auth tables in a dedicated `auth` Postgres schema, migrated before the window.
> - UUIDs preserved via `INSERT … SELECT`; FKs on `threads`, `preferences`, `feedback` repointed to `auth.users.id`; `tokens` dropped.
> - `apps/api` authenticates with the bearer plugin; `/v2/users/*` and the two password-reset routes stay as a compatibility layer over Better Auth with frozen response shapes.
> - Permanent bcrypt + scrypt dual verify; migrated users get `emailVerified = true`; system accounts get no credential row.
> - Admin via the admin plugin; `is_admin` and `session_version` dropped.
> - `revokeSessionsOnPasswordReset: true`; sessions 30 days, refreshed daily.
> - Rate limits: sign-in 5/60s, sign-up 3/60s, database storage, `enabled: true`.

**Owner override, 2026-10-15.** The first half of the fourth item, "`apps/api` authenticates with
the bearer plugin", is replaced by the owner's decision: **`apps/api` verifies JWTs issued by
`apps/auth` against its JWKS.** The second half stands, with the layer calling `apps/auth` over
HTTP. **Owner override, 2026-10-16.** In the third item, "FKs on `threads`, `preferences`, `feedback`
repointed to `auth.users.id`" is replaced: the auth tables live in **their own database**, and the
foreign keys stay on `public.users`, which keeps the same UUIDs. "A dedicated `auth` Postgres schema,
migrated before the window" stands, inside the auth database. "`is_admin` and `session_version`
dropped" stands, together with `password_hash`. Under the owner's one-PR decision, "migrated
before the window" no longer holds for the auth tables: they are created in the window's first
step, in the empty auth database.

Every other item is carried forward unchanged. Under the owner's hosting decision, the
decided rate limits apply to every production sign-in, because all of them pass through `apps/auth`.

### Ownership and review boundaries (from the issue)

- The security architect reviews; every PR is in the high-risk review tier.
- Hunks touching `turbo.json`, the lockfile, `.github/`, Dockerfiles, Railway config, or either
  journal's numbering and markers (`apps/api/drizzle/`, `packages/auth/drizzle/`) need the main
  architect's review. This now includes `apps/auth`'s new Dockerfile, service and database.
- The `apps/frontend` auth client change is agreed with the app architect first (I-6).
- Schema changes: `drizzle-kit generate`, review the SQL, apply by hand at deploy. Never `db:push`.

### Invariants that survive

- System accounts are resolved by `system_key`, never by email, and `@system.ansari.chat` stays
  reserved.
- Admin is never an email match.
- Never log a raw driver or database error; log only `{name, code}`. Never log a token.
- Auth config is read through validated config (`@ansari/auth` `getEnv()` in `apps/auth`;
  `apps/api`'s `config` for the JWKS URL, issuer and audience), never through raw `process.env`.
- New env vars follow the four-way `turbo.json` `globalEnv` derivation.
- Atomic auth operations are tested against a real database, not mocks.
- The mobile contract is frozen.

### Release mechanics

- `main` is promoted only by fast-forward from `develop`.
- Normal migrations must be backward-compatible with the code serving traffic. The cutover
  migration is not needed for the window: the window migration is backward-compatible. The
  **contract** migration, after the 24-hour deadline, is the one documented exception.
- No unmerged SQL touches a deployed database. Every applied SQL is recorded with its `develop`
  commit.

### Pinned dependency

- better-auth and `@better-auth/expo` stay pinned at **1.7.7**. Every behavioural claim here is
  cited against 1.7.7, and any upgrade re-verifies those claims first.

### `arch-critical.md` delta (applied in the cutover PR)

| Current | After |
|---|---|
| Admin = `users.is_admin` | Admin = admin-plugin `role` on `auth.users` in the auth database, asked of `apps/auth` on each admin request (fail closed), never from a token claim. No `ADMIN_EMAILS` in `apps/auth` (H-7); grants by id with confirmation |
| `session_version` = the "kill all sessions" primitive | Deleting a user's Better Auth session rows is the primitive. Already-issued JWTs live until `exp` (15 minutes, Better Auth's default), which is the documented revocation window. No per-request session check |
| JWT config through `config` | `apps/auth` is the only issuer (EdDSA, `auth.jwks`). `apps/api` only verifies, against the JWKS, with `alg`, `iss`, `aud` and `exp` pinned. `apps/api` never imports `better-auth` |
| Token rotation in `db.transaction` with `exec` | Retired with `tokens` (dropped by the contract migration after the rollback deadline). Each cutover step is one transaction |
| Users in `public.users` | Two databases: the auth database (only `apps/auth`) holds every Better Auth table; the app database keeps `public.users` (same UUIDs, no auth columns) for referential integrity. No service holds the other's credential |
| System accounts by `system_key` | Unchanged, and app-only: never in the auth database |
| (new) | Client IP comes from `X-Real-IP` only. The layer's calls to `apps/auth` are anonymous and forward no IP; no path they reach is keyed by IP (H-4) |
| (new) | Sign-in, sign-up, reset and session logic live only in `apps/auth`. The `/v2/users/*` layer is an HTTP client of it |
| (new) | The admin plugin's HTTP endpoints are blocked on `apps/auth` (the plugin is used for `role` only). Roles change only through the role script |

## Assumptions

- The production database has **no real identities** in the #59 scaffold tables in `public`, and
  may not have them at all. Whether they exist on staging or production is a `psql \dt` question for
  the owner (main's condition 6). Either way, the scaffold cleanup's guard refuses to drop a
  non-empty table.
- **Owner amendment R-1 (2026-10-17):** the rehearsal runs on the **existing staging users** in the staging app database,
  not a clone of production data (R-1 above). Staging and production are isolated environments,
  and staging has its own database (owner, 2026-10-16; C-3 resolved). The rehearsal must never run against a database that production also uses. It needs an `apps/auth`
  instance and its own auth database too.
- The operator can take a snapshot or PITR mark of **both** databases. The app database's
  pre-window mark is a last resort only; the planned rollback is a redeploy. In staging the
  second Postgres for `apps/auth` already exists and is empty; in production the owner creates
  it, or confirms it exists and is empty (C-4, clarified 2026-10-17).
- Railway's `X-Real-IP` behaviour as stated by staff holds on our domains. It is verified on
  staging before `develop` is promoted (R-2), not assumed, and the spec carries a fallback if it does not hold.
- `apps/api` can reach `apps/auth` reliably over its public domain (H-1). No credential is shared.
- Released mobile builds send `Authorization: Bearer` on every authenticated call, treat
  `access_token` and `refresh_token` as opaque strings, and refresh and retry on a 401. So a
  15-minute access token only adds periodic refreshes, and nothing in the legacy client decodes the
  token. The plan verifies this by reading the legacy client source (`ApiService.ts`
  `fetchWithAuthRetry`), including how concurrent 401s behave with no single-flight guard.

## Solution Approaches

The owner settled hosting and the token model at the spec-approval gate on 2026-10-15. The
approaches below record what was considered and why. The PR shape is the cutover PR plus a contract PR after the rollback deadline (owner, C-2).

### Approach 1: Separate `apps/auth` service, JWT/JWKS verification in `apps/api`, layer as an HTTP client (chosen by the owner)

As described in Desired State, with the auth tables in their own database (owner, 2026-10-16).

- **Pros:**
  - Auth is a separate deployable, as #49 intended. `apps/api` holds no auth logic and no auth
    secret, only public keys.
  - Per-request verification is stateless: no database read, no network hop, and it keeps working
    from the cached JWKS while `apps/auth` is down.
  - One limiter, database-backed, covers every sign-in path.
  - `apps/frontend` uses Better Auth natively, so the layer's removal trigger becomes meaningful.
- **Cons:**
  - The **revocation window** equals the JWT lifetime (15 minutes, Better Auth's default).
  - A new service, domain and Dockerfile.
  - Key management (`auth.jwks`, rotation, caching).
  - Account endpoints bound to the user's own JWT for profile, role and delete (H-2; originally an
    authenticated internal hop, removed by the owner on 2026-10-17).
  - A second database: a cross-database copy, app rows created on first use, deletion through a
    tombstone.
  - A client change for `apps/frontend` inside the window.
- **Risk:** medium-high. More moving parts land in the window. Staging deployments from the
  branch, a full rehearsal with both services, and the snapshot rollback mitigate it.

### Approach 2: Separate `apps/auth`, with `apps/api` validating Better Auth session tokens through the bearer plugin

`apps/api` would hold the shared `BETTER_AUTH_SECRET` and read `auth.session` on every request.

- **Pros:**
  - Instant revocation, which matches today.
  - Matches the issue's original decided item.
- **Cons:**
  - `apps/api` would import `better-auth`, hold the session-signing secret, and read the session
    table, so auth logic would remain inside it.
- **Not chosen:** the owner ruled that `apps/api` uses JWT verification.

### Approach 3: Better Auth in-process inside `apps/api`, with no public `/api/auth/*`

This was the first draft's proposal.

- **Pros:** the fewest moving parts in the window.
- **Cons:** auth stays inside `apps/api`.
- **Not chosen:** rejected by the owner.

**PR shape (independent of the above):** the cutover PR merged at the window, and a contract PR after the rollback deadline (C-2).

## Open Questions

**Critical (blocks progress)**

- **C-1: Migration SQL location (reopened by the two-database decision).** Two journals, one per
  database: `packages/auth/drizzle/` for the auth database and `apps/api/drizzle/` for the app
  database. The main architect's seven conditions were written for a single journal and need
  re-review; the spec states which carry over. No external migration framework is needed and
  Waleed is not a reviewer (owner).
- **C-2 (resolved, owner, 2026-10-16):** the cutover PR, merged at the window, plus a contract PR
  in the first release after the 24-hour rollback deadline. No database logins, so no
  provisioning PR. See Phasing.
- **C-4 (resolved, owner, 2026-10-16; clarified 2026-10-17):** the auth database is a Railway
  Postgres 18 service for `apps/auth`, with snapshots or PITR on before its first real row. In
  staging it **already exists, empty**. In production the owner creates it, or confirms it exists.
  Either way, window step 1 checks mechanically that it reports 18 and holds no tables.
- **C-3 (resolved, owner, 2026-10-16):** staging and production are isolated environments, and
  staging has its own database. **Owner amendment R-1 (2026-10-17):** the rehearsal uses the existing staging users in the
  staging app database (no production restore), seeded with one row per anomaly class, with a fresh
  staging auth database beside it. The rehearsal stays a hard prerequisite
  for promoting `develop` to `main` (R-2).

**Important (shapes design)**

- **I-1 (resolved, owner, 2026-10-15):** `apps/auth` is a separate service, and `apps/api` uses JWT
  verification.
- **I-2 (resolved):** every sign-in passes through `apps/auth`'s database-backed limiter, so the
  layer needs no limiter of its own.
- **I-3: Layer removal trigger.** "90 days after cutover or ≥ 95% new-client adoption, whichever
  first", owner Amr, carried from the reference. Is it measured by `/v2/users/*` traffic share or by
  released build versions? This affects only the follow-up issue.
- **I-4 (resolved, owner, 2026-10-16):** the owner operates the window. The owner also sets its
  date and time, which the runbook records.
- **I-5 (resolved, owner, 2026-10-16):** `auth.askansari.ai` (production) and
  `auth-staging.askansari.ai` (staging). `apps/api` reaches `apps/auth` there too, at the public
  domain, for every call (H-1; the private-network hop decided here was removed on 2026-10-17).
- **I-6: `apps/frontend` change and release timing** (app architect).
  - The web build ships in the window.
  - If a native `apps/frontend` build pointed at `apps/auth` is released to the stores, a snapshot
    rollback leaves it talking to an `apps/auth` with fewer users.
  - Does any native `apps/frontend` build ship before the rollback deadline passes?
- **I-7 (resolved, owner, 2026-10-16):** the JWT lifetime is Better Auth's default, 15 minutes.
  `apps/api` uses plain JWKS validation with no per-request session check. Sessions stay at the
  issue's 30 days, refreshed daily.

**Nice-to-know**

- **N-1:** Opportunistic rehash from bcrypt to scrypt on login is allowed, but not required. It is
  deferred unless the plan finds it cheap.
- **N-2:** Should `apps/api`'s `getClientIp` group IPv6 addresses to /64 like Better Auth does?
- **N-3:** JWKS key rotation cadence. The plugin manages keys, and the review documents the cadence
  and a manual rotation procedure.

## Test Scenarios

**Happy paths**

1. A legacy user (bcrypt hash, `first_name` and `last_name` set) is migrated, logs in through
   `/v2/users/login`, and gets a JWT and a session token. `GET /v2/users/me` with the JWT returns
   the frozen shape with the same `id`. Their threads list unchanged.
2. The same user signs in directly at `apps/auth` (as `apps/frontend` does), exchanges the session
   for a JWT, and calls `apps/api` with it.
3. A new user registers through `/v2/users/register`, and another directly at `apps/auth`. Both
   passwords are stored as scrypt. Both users log out and log back in.
4. The legacy mobile flow:
   - Login, then calls with the JWT.
   - After 15 minutes the JWT expires, the call gets 401, `refresh_token` returns a new JWT, and
     the retry succeeds.
   - After logout elsewhere, `refresh_token` returns 401 and the client logs the user out.
5. An admin assigned by the role script reaches `v2/admin/stats`. A non-admin gets 403. An
   unauthenticated request gets 401. A demoted admin gets 403 on the very next request, while their
   JWT is still valid. With `apps/auth` unreachable, an admin gets 503, never 200.
6. Password reset: the request emails a legacy-shaped link. The reset succeeds with a strong
   password, and no prior session can mint a new JWT.

**Edge cases**

7. A user with null first and last names, and a user with an empty email local-part, get the
   derived `name` (local-part, or `'User'`). `first_name` and `last_name` copy as null, and
   `login`'s response matches today's handling of null names.
8. A password longer than 72 bytes on a bcrypt hash verifies exactly as it does today, truncated.
9. `DELETE /v2/users/me` with a session 25 hours old succeeds. The session is dead, threads,
   preferences and feedback are gone through the `public.users` cascade, a tombstone is written,
   and the user's unexpired JWT gets 401 on data routes.
9a. With `apps/auth` failing after the app transaction, `DELETE me` leaves a tombstone pending. The
   next request carrying that `sub` completes the auth deletion and gets 401, and the profile path
   never re-creates the row.
9b. A system account's `DELETE /v2/users/me` is refused before any data is deleted, and all its
   threads, preferences and feedback remain.
9c. A user who signs up directly at `apps/auth` gets a `public.users` row on the first `apps/api`
   request, with the same id, email and names. Two concurrent first requests create one row. A
   `sub` that `apps/auth` does not know gets 401 and no row.
9e. The source scan finds no auth-database connection in `apps/api` and no app-database connection
   in `apps/auth`, and fails on a planted one.
9f. A user created at `apps/auth` whose email is already held in `public.users` under another id
   (a legacy row, a system row) gets 401 on the first request; no row is written, the log carries
   both ids and no email, and the alert fires. The same holds for an `@system.ansari.chat` address.
9g. With no JWT, a forged JWT or a token whose session has ended, the delete endpoint refuses and the
   account remains; with a token whose subject is already gone it answers 204 and changes nothing;
   `apps/api` never sends another user's JWT for a delete.
9h. The copy with one password hash altered in transit fails the hash audit, and the app cutover
   migration is not run. A step 2 failure leaves no import table behind.
9i. No verification email is sent to any copied user, and every copied user has
   `email_verified = true`.
9k. Rollback rehearsal: after the removal of post-cutover users by
   `created_at`, and a redeploy of the previous image, a migrated user signs in with the legacy
   password through the legacy code, and no post-cutover user remains.
9l. The source scan fails on a planted `APP_DATABASE_URL` or `AUTH_DATABASE_URL` in runtime code,
   on a planted read of `password_hash`, and on a planted `SELECT *` from `users`. The near-miss
   half: it **ignores a plain `DATABASE_URL`**, and a near-miss line for each pattern does not trip
   it. The scan **reports hit counts**, not a verdict.
10. Re-running the `account` backfill inserts zero rows. The auth-database copy transaction run
    against a non-empty `auth.users` aborts with no changes.
11. A fresh empty app database migrated through the full `apps/api` journal, and a fresh auth
    database through the `packages/auth` journal, each produce the post-cutover schema, and both
    parity tests pass.
12. A timestamp at a DST boundary or carrying microseconds is identical after the copy.
13. A legacy row stored as `  Alice@Example.COM` (mixed case, padded) is migrated as
    `alice@example.com`. It signs in with `ALICE@example.com` and its unchanged password, keeping
    the same UUID and threads. Registering `alice@example.com` returns the taken-email 409.
14. The copy transaction, and the app window migration, each run against two legacy rows
    `Bob@x.com` and `bob@x.com`, abort with no changes, and the pre-window audit reports that pair.
15. The scaffold cleanup run against a `public.account` scaffold table holding one row aborts and
    changes nothing. Against empty scaffold tables, or none, it succeeds.
16. Admin inventory: a legacy admin on the owner-approved list holds `role = 'admin'` after the
    role script. A legacy admin left off the list does not.
17. A JWKS key rotation on `apps/auth`: new tokens carry the new `kid`, `apps/api` re-fetches once
    and accepts them, and old unexpired tokens still verify while their key is published.
18. With `apps/auth` stopped, an unexpired JWT still works on `apps/api`, and sign-in and refresh
    fail cleanly.

**Error and security conditions**

19. Registering `x@system.ansari.chat`, or a taken email, returns the identical 409, on the layer
    and directly at `apps/auth`.
20. A system account cannot log in, does not exist in the auth database, and a reset request for
    its address sends no email and creates nothing.
21. Six legacy logins from one `X-Real-IP` in 60 seconds get 429 on the sixth at `apps/api`, before
    `apps/auth` is called. Forged `X-Forwarded-For` values don't change the bucket. Distinct
    `X-Real-IP` values don't share one. The per-email lock still trips behind it, from any IPs.
22. At `apps/auth`, more than the router's default maximum from one IP across two users draws no 429
    on the layer's paths (R1), while the per-email and per-session rules still trip. The removed hop's
    headers and `/internal/*` paths get nothing.
23. JWT rejection matrix, each case a 401:
    - `alg: none`, an HS256 token, an RS256 token
    - a wrong `iss`, a wrong `aud`
    - an expired token
    - a bad signature, an unknown key
    - a legacy JWT from before the cutover
24. A flood of tokens carrying random `kid`s causes at most the rate-limited number of JWKS fetches.
25. A user cannot read, rename, share or delete another user's thread.
26. `/api/v1/chat/completions` without the right `LEADERBOARD_API_KEY` gets 401, unchanged.
    `/api/v2/mcp-complete` keeps its IP limit, now keyed by `X-Real-IP`.
27. Removing the bcrypt branch, or `revokeSessionsOnPasswordReset`, makes a named test fail. The
    builder demonstrates this once and records it in the review.
28. A credentialed CORS request from a disallowed origin to `apps/auth` gets no allow response.
    `apps/api` does no credentialed CORS: `Allow-Credentials` is never set and `Allow-Origin` is `*`,
    so a credentialed cross-origin request is refused by the browser, while a bearer request from any
    origin passes its preflight (amended 2026-10-16, phase 9). With a valid admin session, every
    admin plugin endpoint (`/admin/set-role`, `/ADMIN/set-role`, `/admin/set-role/`,
    `/%61dmin/set-role`, impersonation included) gets the block response.
29. A raw session token from `/v2/users/login` mints a JWT at `apps/auth`. Turning on
    `requireSignature: true` makes that test fail.
30. The JWT payload contains exactly the pinned claims, and no email, names, `system_key` or role.
31. In the window, before its domain is attached, `apps/auth` is unreachable from the public
    internet, and after the domain is attached, sign-up and sign-in work.
32. IP fallback (only if the edge check fails):
    - Five wrong passwords for one email within 60 seconds, then the right password: 429.
    - After the window ends, the right password succeeds.
    - Ten correct sign-ins in a row are never limited.
    - Lockouts across many distinct emails fire the list-walk alert, which contains no raw email.

**Non-functional**

33. JWT verification on `apps/api` adds no network hop per request in steady state (JWKS cached),
    and no read beyond the `public.users` row it already reads today. Admin requests add one
    account call (`GET /api/account/me`).
34. The runtime of the copy, the audits and the app window migration on the production-sized
    clone is measured in the rehearsal and fits the window.

## Risks and Mitigation

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Mass lockout after cutover | Low | Critical | Dual verify with a removal-detecting test; legacy-row login test on both paths; full rehearsal with both services; 24-hour snapshot rollback |
| Released mobile users stranded | Low | High | Contract tests written against today's implementation pass unchanged; unmodified-client run in staging, including the expire-refresh-retry cycle. Legacy web is retired at go-live and replaced by the `apps/frontend` web build in the window |
| Revoked user keeps access until JWT `exp` | Certain (by design) | Medium | 15 minutes, Better Auth's default (I-7, owner); admin role asked of `apps/auth` per request; deleted `sub` rejected through the tombstone; window documented in arch-critical |
| JWT verification misconfigured (alg confusion, missing `aud` or `iss` check) | Low | Critical | Pinned `alg`, `iss`, `aud`, `exp`; rejection-matrix tests |
| Token payload leaks PII | Medium if the default is kept | Medium | `definePayload` restricted to `sub` and the session id; key-set test |
| `apps/auth` outage blocks sign-in and refresh | Medium | High | Cached JWKS keeps issued tokens working; healthcheck and alerting on `apps/auth`; rollback runbook |
| JWKS fetch amplification via random `kid` | Low | Medium | Rate-limited re-fetch; test |
| `apps/auth` reachable before the copy, accepting sign-ups | Low | High | Not deployed to production before the window; deployed after the copy; domain attached last; the copy guard aborts on a non-empty `auth.users` |
| Rate limit collapses into one global login bucket (edge, or the layer's one egress IP) | Medium without the fix | High | `X-Real-IP` only; no per-IP rule on any path the layer calls (R1); per-IP limits in `apps/api`; multi-entry XFF, two-client and one-IP-many-calls tests; empirical edge verification |
| A user's JWT stolen | Low | Medium (that user's profile read, their sessions revoked, their account deleted, within 15 min) | The same power it has through `apps/api`; live-session check; per-user budgets; a direct delete is the H-6 residual with its operator response |
| Railway changes `X-Real-IP` semantics later | Low | Medium | Documented header; re-verify on any Railway networking change; an arch-critical fact makes the dependency visible |
| Admin HTTP surface abused (stolen admin token or frontend XSS leads to account takeover) | Low | Critical | Whole admin surface blocked: `disabledPaths` plus a case-insensitive prefix middleware before `toNodeHandler`; variant tests; enumerating regression test |
| `apps/frontend` client change slips or breaks in the window | Medium | High | Agreed with the app architect up front; rehearsed; web rollback by redeploy; native release timing decided (I-6) |
| Long-lived branch drifts from `develop` | Medium | Medium | Regular `develop` merges; numbering re-check after each; `develop` frozen from the cutover merge to the production window (R-2), so the staging rehearsal runs on what production gets |
| More lands in one window | Medium | High | Full rehearsal on staging, seeded with every anomaly class, plus the production preflight (R-1); ordered, gated runbook; 24-hour snapshot rollback |
| Rollback after cutover | Low | High | A redeploy, never a restore: nothing legacy reads is dropped until the contract migration; post-cutover users removed by `created_at` (owner-accepted cost); rollback rehearsed |
| Legacy hashes readable by `apps/api`'s database account until the contract migration | Certain (owner: no separate logins) | Medium | No code reads them (Drizzle schema, scan); contract migration dated to the first release after the deadline |
| A compromised service runs DDL on its own database | Low | High | Owner-accepted (default accounts); it still cannot reach the other database; snapshots or PITR on both |
| Contract migration forgotten, leaving hashes in the app database | Medium | Medium | Dated to the first release after the deadline; a success criterion; part of this project's verify |
| Cross-database copy half-done (auth database filled, app migration failed) | Low | High | Ordered, gated steps; each step one transaction; audits before the app migration; `apps/auth` not deployed until both succeed; rehearsed on a clone |
| App row and auth user drift apart (missing row, orphan, resurrected deleted user) | Medium if unguarded | High | Same UUID; app row created on first use from the profile endpoint; tombstone blocks re-creation; pending deletions completed on access and by an operator script; profile-changing endpoints blocked |
| `apps/auth` outage blocks admin routes and first requests of new users | Medium | Medium | Admin fails closed (503); existing users unaffected (their row exists); alerting on `apps/auth` |
| Admin boot assertion crash-loops | Low | High | Role script runs before the deploy; the assertion is checked in the rehearsal |
| System accounts become loginable or resettable | Low | High | Never copied to the auth database (`WHERE system_key IS NULL`); audit; reset refusal test |
| Legacy admin silently dropped or added | Medium if overlooked | High | Owner-approved inventory; role-set audit |
| Mixed-case legacy email becomes unfindable | Unknown (older rows unverified) | High | Copy `lower(trim(email))`; in-transaction collision guard; pre-window audit with owner decisions; mixed-case sign-in test |
| A journal drifts from its database | Medium | High | One journal per database, each with a parity test and its own marker |
| Migration numbering collides after a concurrent merge | Medium | Medium | Numbering rule: merge `develop`, run generate, rename, re-check after every merge; schema freeze from the PR's merge to window close |
| #59 scaffold tables hold data at drop time | Low | Medium | In-migration guard aborts on any row |
| Targeted sign-in lockout under the IP fallback | Medium (fallback only) | Low | Failed-only counting, bounded to one 60s window per five failures; list-walk alert; reset unaffected |
| better-auth behaviour differs from the 1.7.7 citations | Low | High | Pin 1.7.7; tests pin each relied-on behaviour |
| Layer never removed | Medium | Low | Follow-up issue with a dated trigger and owner |

## References

- Issue #300. Reference spec and plan:
  `codev/specs/60-better-auth-migration-reference.md`,
  `codev/plans/60-better-auth-migration-reference.md` (#60, PR #134, PR #148, #299).
- #59 review: `codev/reviews/59-build-better-auth-in-apps-auth.md`. Spec 4:
  `codev/specs/4-auth-hardening-admin-roles-in-.md`.
- Related issues: #16 (refresh reuse, closes), #33 (RELEASE smoke admin bootstrap), #49 (apps/auth
  extraction, left open), #265 (stale expo-router peer, out of scope), #266 (vacuous origin test).
- `RELEASE.md` (deployment model, migration runbook); `codev/resources/arch.md` (Authentication,
  Monorepo layout and deploy).
- Railway: Public Networking → Specs & Limits,
  https://docs.railway.com/networking/public-networking/specs-and-limits. Central Station staff
  answers on client-IP trust (2026-09-12, 2026-10-04, 2026-10-05).
- better-auth 1.7.7 sources: `@better-auth/core` `dist/utils/ip.mjs:174-218`; `better-auth`
  `dist/api/rate-limiter/index.mjs:236-248`; `dist/api/routes/password.mjs`;
  `dist/api/routes/update-user.mjs`; `dist/db/internal-adapter.mjs`.
- better-auth 1.7.7 JWT plugin: `dist/plugins/jwt/index.mjs` (`/token` :141, `/jwks` :26,45, `set-auth-jwt` :194-207), `sign.mjs` (EdDSA :32, `15m` :81, `iss`/`aud` :86-88, payload :119), `schema.mjs` (`jwks`).
- Better Auth docs: Database (UUIDs), Email & Password (custom hash/verify), Admin plugin, Bearer plugin, JWT plugin.
