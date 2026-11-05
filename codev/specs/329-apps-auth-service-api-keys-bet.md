# Specification: Service API keys and the WhatsApp token exchange (apps/auth)

## Problem Statement

apps/auth knows only one kind of caller: a person who signs in. The only way into apps/api is a user JWT minted from a live Better Auth session. Nothing can act on behalf of a user who never signs in, and apps/auth has no way for a service to prove who it is.

The WhatsApp service (spec 321, PR #327) needs exactly that. A WhatsApp user is identified only by Meta's business-scoped user id (BSUID). They never visit a sign-in page, yet their messages must reach apps/api as an ordinary user (threads, limits, deletion) under one stable UUID. Spec 321 assumes an apps/auth endpoint that takes a BSUID and returns a JWT. The endpoint does not exist, and the builder has run nothing against a live apps/auth. #314 (MCP) needs the same service-identity primitive later.

Two things are missing:

1. **Service identity**: a credential a service holds, issued and revoked by an operator, hashed at rest, scoped per service and per action, with its own throttle.
2. **A delegation rule**: which users a given service may mint tokens for. For WhatsApp the rule is "only a user whose sole account row is `whatsapp`, keyed by BSUID, and only for a key owned by the WhatsApp service". A WhatsApp key must never yield a token for an email user, an admin, a system identity, a service user, another provider's user, or a user who has gained any second account row or role.

Affected: the WhatsApp service and its users (no path into apps/api today), the operator (who will hold a new credential type), and the security model of apps/auth (a new credential, table and public route).

## Current State

- **Callers.** apps/auth serves Better Auth's router at `/api/auth/*`, the account endpoints at `/api/account/*` (bound to the caller's own JWT and a live `sid`), `/health` and a diag route. `corsFor(CORS_ORIGIN)` is mounted globally, ahead of every route. `express.json` is not global. There is no service credential of any kind. The leaderboard (the IslamicMMLU benchmark harness, driving `POST /v1/chat/completions` on apps/api) uses a static shared secret; MCP (`/v2/mcp-complete`) has none (#314).
- **Tokens.** apps/api accepts only apps/auth's EdDSA JWT (15 minutes, payload `{sub, sid}` plus `iss`, `aud`, `iat`, `exp`), verified against the public JWKS. On first use, `requireUser` → `resolveUser` fetches `GET /api/account/me` with that JWT, which requires the `sid` to name a live row in `auth.session`, and then inserts `public.users` under the same UUID. A bare signature with no session behind it is therefore useless: first use fails.
- **Sessions are credentials.** `auth.session.token` is unique, and the bearer plugin accepts an *unsigned* session token as a bearer (kept deliberately for the compatibility layer). A session token is therefore a 30-day account credential that can reach `/api/auth/token`, `/api/account/*` and `DELETE /api/account`. The jwt plugin's `/token` endpoint is wrapped by apps/auth's perimeter hook (`TOKEN_EXCHANGE_PER_SESSION`, a `rate_limit` row per session). Its `signJWT` is `serverOnly` and has no route.
- **Reserved addresses.** `@system.ansari.chat` is reserved through `isReservedAddress`, which today is just `isSystemAddress`:
  - sign-up refuses it with the same 409 as a taken address;
  - the reset sender skips it silently;
  - the `user.create.before` hook refuses it on every path (spec 300: the auth database never holds one).

  apps/api keeps its **own** copy of `isSystemAddress` / `SYSTEM_EMAIL_DOMAIN` and refuses only the system domain at first use. `grant-admin.ts` refuses the system domain and nothing else.
- **Accounts.** `auth.account` carries `unique(user_id, provider_id)`. There is no `unique(provider_id, account_id)`. Only the `credential` provider exists today.
- **Blocked paths.** `BLOCKED_AUTH_PATHS` goes into `disabledPaths`, which better-auth matches exactly. apps/auth's `blocked-paths` middleware canonicalizes the path, then gives **prefix** matching only to `/api/auth/admin`; every other blocked path is matched exactly. `ADMIN_PATHS` is derived from `admin().endpoints`, so a plugin bump cannot silently publish a route.
- **Limits.** `ROUTER_RULES` are all `false` (apps/auth sees apps/api's egress IP on legacy calls). Routes outside Better Auth's handler carry no per-IP rule. The account routes have a per-user budget (`ACCOUNT_ENDPOINT`, through `consumeWindow`). `packages/auth/src/limits.ts` is the single home of limit numbers.
- **Alerts.** `apps/auth/src/alerts.ts` sends Sentry events that carry counts and hash prefixes, never identifiers.
- **Boot.** apps/auth does no database work before `listen()`: the pool connects lazily, and the owner amendment of 2026-10-17 removed the boot admin check so that nothing stale can stop sign-in. `users.ts`'s header mentions a boot assertion, but none exists. The pool is pg's default (10 connections), shared by every route.
- **Operator scripts.** `grant-admin.ts` shows an account, then acts only on an explicit `--confirm <id>`; it prints no secrets and runs from the auth image or a checkout with the auth `DATABASE_URL`. No script refuses to run outside the image, and none prints the database host. The issue's "refuse to run outside the auth image" describes a guard that does not exist, and a marker could not prove it. This spec drops it (correction directed by the security architect).
- **Better Auth's logger.** `createAuth` sets no `logger`, so better-auth logs error objects as they are.
- **What Meta sends** (Meta's business-scoped user ID documentation, checked by the security architect, 2026-10-28):
  - A BSUID is a two-letter ISO 3166 alpha-2 country code, a period, then up to 128 alphanumeric characters (e.g. `US.13491208655302741918`). A parent form `US.ENT.<id>` exists for businesses in linked portfolios; Ansari is not enrolled.
  - Meta **regenerates** the BSUID when the user changes phone number and reports it as a system message (`system.type` `user_changed_user_id` or `user_changed_number`, with `system.previous_user_id`).
  - The webhook carries `from` and `wa_id` (the phone number) beside `from_user_id` (the BSUID): always for users without a username; for username users only inside a 30-day contact window. #327 currently reads `from_user_id` only.
- **Better Auth transactions.** better-auth 1.7.7's internal adapter resolves its adapter through `getCurrentAdapter`, and `runWithTransaction` binds internal-adapter calls to an open transaction.
- **`@better-auth/api-key` 1.7.7.** Peer `better-auth ^1.7.7`. Read from the published package and **proven against pglite** (throwaway specify-phase probe, the plugin wired to the real `auth` schema):
  - The `apikey` model: `configId` (default `"default"`), `name`, `start`, `referenceId` (owning user's id; `references` defaults to `"user"`), `prefix`, `key` (SHA-256, base64url), `refillInterval`, `refillAmount`, `lastRefillAt`, `enabled`, `rateLimitEnabled`, `rateLimitTimeWindow`, `rateLimitMax`, `requestCount`, `remaining`, `lastRequest`, `expiresAt`, `createdAt`, `updatedAt`, `permissions` (JSON text), `metadata` (JSON text, kept only with `enableMetadata: true`). The owner column is `referenceId`, not `userId`.
  - HTTP endpoints: `/api-key/create`, `/api-key/get`, `/api-key/list`, `/api-key/update`, `/api-key/delete`. `verifyApiKey` and `deleteAllExpiredApiKeys` are `serverOnly`.
  - `enableSessionForAPIKeys` defaults to `false`; only when true does an `x-api-key` header become a session on Better Auth's routes.
  - `startingCharactersConfig.shouldStore` exists in the 1.7.7 types (default `true`: `start` keeps the first 6 characters, i.e. the prefix plus 3 random characters with `wa_`).
  - `verifyApiKey` order: hash found → `enabled` → `expiresAt` → `permissions` → exhausted → consume `remaining` and a rate-limit slot, atomically against the row.

    | Case | Result | Row |
    |---|---|---|
    | `remaining` reaches 0, **no refill** | refused `USAGE_EXCEEDED` | **deleted** on the next verify |
    | `remaining` reaches 0, **with refill** | refused `USAGE_EXCEEDED` until the interval passes, then refilled (first cycle from a null `lastRefillAt`, and later cycles) | kept |
    | per-window rate limit exceeded | refused `RATE_LIMITED` | kept |
    | expired | refused `KEY_EXPIRED` | **deleted** |
    | disabled | refused | kept |
    | wrong permission | refused `KEY_NOT_FOUND`, `remaining` untouched | kept |

  - Every failure is caught and returned as `{ valid: false, error }`. An error that is not an `APIError` (a driver error, or a missing `auth.apikey` relation) comes back as `INVALID_API_KEY`, the same code as an unknown key. Before returning, the plugin logs the caught error object raw through better-auth's logger.
  - The default key is the prefix plus 64 random letters.

## Desired State

### 1. Service identity

**The table.** `packages/auth` carries `@better-auth/api-key` pinned to the core version (1.7.7). Its `apikey` table is hand-written in `schema.ts`:
- it mirrors the plugin's model exactly, with the column names better-auth's generator would produce;
- it follows the `auth` schema style (uuid ids, `timestamptz`, `reference_id` a uuid referencing `auth.users` with cascade delete);
- the schema comment records the departures, as for the other tables.

It ships as migration `0001`, generated, reviewed as SQL, applied by hand before code, and numbered by main. The same migration adds `unique(provider_id, account_id)` to `auth.account`. (It no longer adds a `phone_number` column to `auth.users`: owner amendment 2, §5.) Better Auth never changes the database shape. **Boot assertion (the #165 class: code shipped before its migration).** Before `listen()`, apps/auth checks the schema this spec needs: the `auth.apikey` relation (a query against it) and the `unique(provider_id, account_id)` constraint (a catalog lookup).
- It refuses to start **only on a definite answer** that one is missing: Postgres `42P01` (undefined table) for the relation, or an empty catalog result for the constraint.
- When the database is **unreachable** (connection refused, timeout, any other error), the service starts as it does today and `/health` reports the database. A blip at deploy must not become a crash loop under the restart policy that takes sign-in down with it.
- Failures log `{name, code}` only.

**A service is one auth user**, created only by an operator script:
- address `service-<service name>@noreply.askansari.ai` (Part 4), no credential, role `user`;
- exactly one account row `{ providerId: 'service', accountId: <service name> }`, which is how it is resolved (never by email);
- one user per service: `whatsapp` now; later `ansari-mcp`, and the leaderboard if it migrates;
- it cannot sign in: there is no `service` provider in Better Auth, and it has no credential.

**Permissions are fixed per service, in code.** The script takes no free-form permissions. The `whatsapp` service gets `{ whatsapp: ['mint'] }`, and `ansari-mcp` will get `{ mcp: ['complete'] }` (#314).

**Keys are created in-process with `auth.api.createApiKey`**, server-side, with the service user's id. They are never inserted by hand, so the plugin's own hashing, `permissions` and `metadata` handling apply. `enableMetadata: true`; `startingCharactersConfig.shouldStore: false`. The plan's first probe proves this path: a script-created key verifies at the exchange, its row holds exactly the hash, and no column holds any substring of the raw key.

**Key settings.** Each key has:
- a per-service prefix (`wa_` for WhatsApp) and a name;
- `metadata` carrying the partner's client id;
- a per-window rate limit (`rateLimitTimeWindow`, `rateLimitMax`) and a daily budget (`remaining` with `refillAmount` and `refillInterval` of 24 h), both required with no defaults. The create script validates them against bounds declared in `limits.ts`, the single home of limit numbers. Values are chosen by the operator within wide bounds; the initial values are set in the plan by judgement (owner decision 3), and an `update-limits` script path changes a live key's values.
- **no expiry.** A production credential must not die silently, so rotation is driven by the runbook. The create script offers no expiry option.

The script refuses `remaining` without a refill: probed above, that configuration deletes the key the first time a burst exhausts it. **Budgets are per key, not per service:** while two keys are live during a rotation, the service's ceiling doubles. The runbook says so, and rotation overlap is kept short.

**Operator scripts** (create service user, create key, list, rotate, revoke) follow `grant-admin.ts`'s posture:
- refuse to run without a database URL;
- show the account, then write only with a matching `--confirm <id>` (a mismatch writes nothing);
- before any write, print the database **hostname and port only**, never the URL, user, password, query string or a URL parse error;
- log the key id acted on;
- print nothing secret, except the new key exactly once at creation;
- **revoke sets `enabled = false` and keeps the row** (refused and kept, as probed), so the trail survives. Rotate creates a second live key; the old one is revoked once the consumer has switched.

Every create, rotate and revoke also sends a durable Sentry event (service, key id, name, action, no key material), so the record does not live only in a terminal. If that event cannot be sent (the flush fails or times out), the write stands, the script prints a loud banner telling the operator to record the key id and action in the runbook's key log, and exits non-zero.

**Where the raw key lives.** In exactly two places, briefly in one and durably in the other:
- the create script's single output, in the operator's shell inside the auth service;
- the consumer's secret variable (the WhatsApp service's Railway variable), into which the operator pastes it directly.

It is never put in chat, tickets, docs, git or logs. apps/auth stores only its hash.

**No HTTP surface.**
- The blocked paths are derived from `apiKey().endpoints` as `ADMIN_PATHS` derives from `admin().endpoints`, but **filtered to endpoints with a defined path**: `verifyApiKey` and `deleteAllExpiredApiKeys` are `serverOnly` with no path, and copying `ADMIN_PATHS`' map would inject two `undefined` entries into `disabledPaths`. Two assertions pin today's shape: 7 endpoints, 5 routed. A plugin bump that changes either number fails loudly.
- They join `BLOCKED_AUTH_PATHS`, and the middleware gains a `/api/auth/api-key` **prefix** rule like `/api/auth/admin`'s, so canonicalized variants and suffixes are blocked (the finite test list is under Success Criteria).
- `enableSessionForAPIKeys` stays `false`: a key is never a session anywhere on the router.

**Verification is `auth.api.verifyApiKey`, in-process**, with the route's required permission. The route also binds the key's `referenceId` to its own service user, resolved by the `service` account row:
- a key for another service fails twice over, by permission and by owner;
- if the WhatsApp service user cannot be resolved, or resolves to more than one user, that is a misconfiguration: 500 plus an alert, never 401.

No verify route at the public origin is built here; #314 adds one.

**Better Auth's logger is redacted, not silenced.** `createAuth` configures better-auth's `logger` so an argument that is an error object is reduced to exactly `{name, code}`, while the level, the message and non-error arguments survive. This closes the plugin's catch-and-log path. It changes every better-auth log line in apps/auth, so it lands as its own commit.

### 2. The WhatsApp token exchange: `POST /api/whatsapp/session`

Mounted outside Better Auth's handler path, like the account routes, so no router per-IP rule sees it (the WhatsApp service calls from a Railway egress IP). `ROUTER_RULES` stays all `false`.
- **No CORS.** No response from the exchange, preflight included, carries `Access-Control-Allow-Origin`, so browser use is structurally impossible. **Mechanism:** the exchange router is mounted **before** `app.use(corsFor(…))` in `app.ts`. `corsFor` decides by origin alone and answers `OPTIONS` itself, so a route mounted after it would get CORS for the configured origin. Mounted first, the exchange also never passes through `mergeExposedHeaders` or `blockedPaths`, neither of which applies to it.
- **No other credential.** A session token or a JWT presented as the bearer is just an unknown key (401). There is no fallback to user authentication, and the route is not reachable under `/api/auth/*`.
- **Body parsing** is route-local, mounted after the key check, with a strict byte limit, so an unauthenticated or oversized body costs no parsing.

**Contract** (replaces the assumption in spec 321 and the `X-Whatsapp-Api-Key` header in #327):

| | |
|---|---|
| Request | `Authorization: Bearer <api key>`; JSON body `{ "bsuid": "<BSUID>", "phone_number": "<digits>"? }`. `phone_number` is optional, and an explicit `null` counts as absent (amended in the review phase: JSON clients commonly send `null` for an absent field). **Amendment 2 (§5): `phone_number` is accepted and ignored**, any shape, with no sanity bound; it is never stored, parsed into state, logged or echoed. Meta sends it (`from` / `wa_id`) always for users without a username, and for username users only inside a 30-day contact window, so its absence is normal |
| 200 | `{ "token": "<JWT>" }`: the same EdDSA 15-minute `{sub, sid}` token apps/auth issues every client, signed from a live session of the BSUID's user |
| 400 | `{ "message": "Invalid request" }`: body not JSON, too large, or `bsuid` failing the sanity bounds (`phone_number` is no longer checked: amendment 2, §5) |
| 401 | `{ "message": "Unauthorized" }`, byte-identical for **every** key refusal: missing, malformed, unknown, revoked, disabled, expired, budget-exhausted, rate-limited, wrong permission, or owned by another service |
| 403 | `{ "message": "Forbidden" }`: the BSUID's user is banned |
| 429 | `{ "message": "Too many requests" }` with `X-Retry-After` (an integer number of seconds until the window frees, from `consumeWindow`'s `retryAfter`, as the account endpoints do): this one user's exchange budget is spent (the key itself is fine) |
| 500 | `{ "message": "Internal error" }` for anything else: database outage, `auth.apikey` missing, service user unresolvable, an ineligible user behind a `whatsapp` row, the user deleted mid-exchange |

No response contains the bearer, the BSUID, the phone number or any part of the request body.

**Contract duties of the consumer (#327):** send `Authorization: Bearer`; ~~send `phone_number` (Meta's `wa_id`) whenever the webhook carries it~~ (amendment 2, §5: the field is accepted and ignored, and #327 is asked to stop sending it; a later PR removes it from the contract); cache a token per BSUID for under 15 minutes; on a 401 **from apps/api**, re-exchange once, because a session can die after signing (ban, deletion), and the token's `sid` then fails first use. Treat 401 from the exchange as "my key is bad" (page the operator), 403 as "this user is banned", and 429 as "slow this user down". A 500 is either an outage or a permanent, local identity fault for that one user (an ineligible user, below): **do not retry a 500 per message**. Send the user the failure notice, page on a sustained 500 rate, and do not page on isolated 500s. Spec 321 is not on develop, so its amendment lands on #327's branch, coordinated with that builder.

**Outage versus refusal.** The plugin reports a database failure as `INVALID_API_KEY`, the same code as an unknown key. So the route runs a relation check on **every plugin refusal** (`valid: false`), and only then answers 401:
- The check is a query against `auth.apikey` itself, not `select 1`, which would pass with the relation missing.
- A failed check → 500.
- A missing or malformed bearer never reaches the plugin and is answered 401 without touching the database.
- A successful check is cached in-process for `APIKEY_RELATION_CHECK_TTL` (a constant in `limits.ts`, a few seconds), so an unknown-key flood does not double database work.
- A sustained 401 volume per window raises an alert.

**Accepted residuals:**
- an outage that begins between the verify and the check (or inside the cache window) is misclassified as 401;
- a database that recovers between them turns an outage into a 401;
- an unknown-key flood still costs one plugin lookup per request (no budget can attach to a key that does not exist), and is bounded by the cache and surfaced by the 401-volume alert.

**Per request:**

1. **Key.** Verify with permission `whatsapp: mint` → on refusal, the relation check → 401 (or 500). Bind `referenceId` to the WhatsApp service user (unresolvable → 500 + alert; another owner → 401).
2. **Body.** Parse (route-local, byte-limited) and apply sanity bounds only → 400. No strict BSUID format is enforced (owner decision: Meta may change it, and the caller is the trusted WhatsApp service).
   - `bsuid`: a non-empty string of at most 256 characters, with no whitespace or control characters.
   - ~~`phone_number`, when present: a non-empty string of at most 32 characters, digits with an optional leading `+`.~~ *Amendment 2 (2026-10-30): no phone number is stored; see §5.* `phone_number` has no bound; it is ignored.
3. **Resolve or create.** Look up `auth.account` where `provider_id = 'whatsapp'` and `account_id = <bsuid>`. The provider is fixed in code; the lookup never goes through email. With no row, create the user and the account row in **one transaction**:
   - the exchange generates the user's UUID itself;
   - the address is `whatsapp-<user id>@noreply.askansari.ai`, the display name `WhatsApp user`, `registered_via = 'whatsapp'`, and there is no credential;
   - the account row is `{ providerId: 'whatsapp', accountId: <bsuid>, userId }` (the BSUID stored raw, owner decision 2);
   - ~~`phone_number` is stored on the user when provided.~~ *Amendment 2 (2026-10-30): no phone number is stored; see §5.*

   `unique(provider_id, account_id)` makes a BSUID map to exactly one user under concurrency: the losing request rolls back and uses the winner's user.
4. **Per-user budget.** Spend one unit with `consumeWindow`, keyed by the user id (never the BSUID), numbers in `limits.ts`; spent → 429. It runs on the **pool, outside any transaction**, after the user is resolved and before the lock, like the account endpoints' budget. Inside the locking transaction, every refusal (403, 429, 500) would roll the counter back, and the limit would never bind. The budget bounds per-user session churn and per-user probing. **It does not protect the key's budget:** `verifyApiKey` has already spent a unit of the key's `remaining` and window by then. The key's budget is sized to absorb a looping user, and the per-key volume alert catches one.
5. **Lock, then decide.** In one transaction, with `lock_timeout` and `statement_timeout` set on it, so the worst case is a 500 rather than a stalled connection in the pool shared with sign-in and JWKS:
   - **Lock** the user's row with `SELECT … FOR NO KEY UPDATE`. It serializes exchanges for one user and conflicts with the ban and the role update (both plain row updates), but not with the `KEY SHARE` lock that a session insert's foreign key takes. So no write, even one on another connection, can wait on the request's own lock.
   - **Re-read under the lock.** The user gone → 500 (deleted mid-exchange; the next message creates a new user).
   - **Eligibility**, all required: the user's *only* account row is this `whatsapp` row; the address is under `@noreply.askansari.ai`; `registered_via = 'whatsapp'`; `role` is not `admin`. A violation → 500, never a token. It raises a Sentry alert carrying counts only, and logs a server warning line naming the user id (the precedent: apps/api's "app row refused" warning). The runbook gives the repair: inspect that user's rows, remove the stray account row or role, or delete the user so the next message recreates them. Without that repair the BSUID stays refused.
   - **Ban** (admin plugin `banned`, honouring `banExpires`) → delete all the user's sessions, commit, 403.
   - ~~**Phone number.** When provided and different from the stored one, update it. When absent, leave the stored one untouched (never clear it).~~ *Amendment 2 (2026-10-30): no phone number is stored; see §5.*
   - **Session.** Fix the token's times first: `iat = now` and `exp = now + JWT lifetime`. Reuse the user's live session only if `expiresAt ≥ exp + SESSION_MARGIN` (a constant in `limits.ts`). Otherwise delete the user's sessions and **write the new session row directly with Drizzle in this transaction**, as the user and account rows are written:
     - the token comes from the generator better-auth's own session creation uses (its 32-character id generator);
     - `expiresAt` is the configured session lifetime (30 days);
     - there is no IP address and no user agent;
     - the token is never returned, logged or sent to Sentry.

     `internalAdapter.createSession` inside better-auth's `runWithTransaction` is the alternative, if the plan's real-Postgres probe prefers it. Either way, the session write shares the locking transaction.
   - **Commit.**
6. **Sign, after the commit**, with the jwt plugin's server-side `auth.api.signJWT`, passing `{sub, sid, iat, exp}` explicitly: the same `iat` and `exp` the session was checked against under the lock. That keeps the comparison non-circular. It also matters because `signJWT` sets `iat` only when the caller passes it, while `/api/auth/token` goes through `getJwtToken`, which injects `iat` and applies `definePayload`. The exchange's claim set must equal `/token`'s. A signing failure → 500; the session stays and is reused next time. Then return the token.

   *Amended in implementation (security architect, 2026-10-28):* an earlier draft had signing inside the transaction. It moved out in plan iteration 2 (security review P1): `signJWT` reads `jwks` through the shared pool, so inside the transaction each exchange would hold one connection while waiting for a second. On real Postgres with a pool of 2, 10 concurrent exchanges then hang with no connect timeout, or fail loudly with one, while signing after the commit finishes 10/10 (probe 4, steps E1 and E2, output in `codev/reviews/329-*.md`).

   The ban re-read, the eligibility check and the session write run in that one transaction, so a ban, deletion or promotion that commits first is always honoured. One that commits between the commit and the signature is the same case as one just after signing (below): a ban or deletion leaves a dead `sid` that fails apps/api's first use, and admin authority is never in the token (`role` is read at `/api/account/me` on every request). A session written directly must be indistinguishable from one better-auth wrote: the bearer plugin, `/api/account/me`'s live-`sid` check and revocation all treat it as their own. Tests read it back through better-auth.
   - **`/token` is not used.** Signing bypasses `/token`'s perimeter hook, so `TOKEN_EXCHANGE_PER_SESSION` and its `rate_limit` row do not apply. The per-user budget above replaces them for this route.

The invariant is: **at signing time, the session outlives the token**: `expiresAt ≥ exp + SESSION_MARGIN` is checked under the lock against the `exp` that is then signed, and a session can only be deleted after the commit, never shortened. A ban, deletion or revocation after the commit can still kill the session; the token then fails apps/api's first use, and the consumer re-exchanges once.

The WhatsApp service caches the token per BSUID for under 15 minutes and calls apps/api with it. apps/api resolves the user on first use exactly as for a web user. **apps/api gains no WhatsApp code** (spec 321 success criterion).

**Accepted oracle residual.** A holder of the WhatsApp key can confirm whether a given BSUID has used Ansari, and whether that user is banned, both from the responses and from latency (new, existing and refused take different times). Guessed BSUIDs also create durable, inert users. This is accepted because the WhatsApp service is the delegation authority: it already holds every BSUID it would ask about. BSUIDs are not enumerable, so this is targeted confirmation, not harvesting. The mitigations are detection, not prevention: per-key request-volume alerts, `USAGE_EXCEEDED` and `RATE_LIMITED` alerts (otherwise invisible, since they collapse to 401), and rotation and revocation. No constant-time padding is built.

### 3. The phone number (owner decision, reversing spec 321's baked decision 2)

> **Withdrawn by §5 (owner amendment 2, 2026-10-30): no phone number is stored.** This reverses owner decision D3. Kept as the record of what was approved first.

The exchange stores the WhatsApp user's phone number when the WhatsApp service has it:
- **Rules.** Store it on create. On a later exchange, update it when it is provided and different. Never clear it when it is absent (absence is normal, see Current State).
- **Storage.** One nullable column, `auth.users.phone_number`, declared as a Better Auth additional user field with `input: false` and `returned: false`, like `first_name` but never input and never output. It sits on the user rather than the `whatsapp` account row, beside the identity that the deferred number-change continuity work will need. It is PII.
- **Never exposed.**
  - `GET /api/account/me` does not return it (its projection is explicit), so apps/api never sees it, and "apps/api gains no WhatsApp code" still holds.
  - No Better Auth path accepts or returns it: `update-user` is already blocked, `input: false` refuses it on every write path, and `returned: false` strips it from every response (`get-session`, sign-in, and so on).
  - It never appears in any log, alert, Sentry event or response; it joins the never-log list and the log-capture assertions.
  - Rate-limit keys stay on the user id.
- **Scope.** Only the exchange writes it, and only for WhatsApp users. It is never used to find a user: lookup stays on the BSUID alone.

### 4. A non-interactive address domain

A second reserved domain, **`@noreply.askansari.ai`** (owner decision 1), for service users and WhatsApp users. The account kind is a prefix of the local part:

| Account | Address | How many |
|---|---|---|
| WhatsApp user | `whatsapp-<user id>@noreply.askansari.ai` | one per person who messages Ansari on WhatsApp |
| Service user | `service-<service name>@noreply.askansari.ai`, e.g. `service-whatsapp@…`, later `service-ansari-mcp@…` | one per service that holds an API key |

Prefixes keep each kind together in listings and logs. The reserved check looks only at the domain, and nothing ever finds a user by email, so the prefix carries no security weight. Ordinary `@askansari.ai` addresses (staff, admins) are not reserved.

**Implementation boundary:** `isReservedAddress` is extended to cover both domains. `isSystemAddress` and `SYSTEM_EMAIL_DOMAIN` are not widened: they name the system-domain invariant, apps/api keeps its own copy, and existing tests assert them.

The reserved domain is:
- refused by sign-up with the same 409 as a taken address (response shape; see the timing residual below);
- skipped by the reset-request sender with the same response as an unknown address (no mail attempt);
- never created by any Better Auth path: the `user.create.before` hook refuses both reserved domains unconditionally;
- refused by `grant-admin.ts`, like the system domain;
- created only by the exchange and the service-user script, which write their rows directly in a transaction.

A user in this domain has no password, so they cannot sign in anywhere. A WhatsApp user's only account row is `whatsapp`; a service user's is `service`. `GET /api/account/me` answers for them only with their own JWT and a live `sid`. The system domain keeps every rule it has today.

**Timing residual:** sign-in and reset for an existing passwordless noreply user and for an unknown address give the same response shape, but are not guaranteed to take the same time. Only response equivalence is promised. The addresses are server-generated and not guessable from anything public, which bounds the value of the difference.

### 5. Owner amendment 2 (2026-10-30): no phone number

**Owner decision**, verbatim: "we don't need to deal with this complexity for now, change of plans, drop phone number entirely, whatsapp id is enough."

This **withdraws owner amendment 1** of the same day, which brought in better-auth's phone-number plugin, verified numbers, and claiming and superseding accounts by phone number. That amendment was committed (1d84f91d, ca1452db) and reviewed (security's T1–T20 and the external round), but never implemented. It also **reverses owner decision D3** (§3): the exchange no longer stores the phone number at all. The review keeps the record of why amendment 1 was withdrawn: its inputs, the phone-number plugin probe, and T1–T20.

**What changes:**
- **Identity stays BSUID-only.** Phases 1–7 never used the number to find a user, so lookup, eligibility and the delegation rule are unchanged.
- **Schema:** migration `0001` (applied nowhere; a phase step verifies that, with `0002` as the named fallback) no longer adds `auth.users.phone_number`. The Better Auth additional field goes with it. `auth.apikey` is unchanged (owner: keep).
- **Contract: accepted and ignored.** The exchange keeps accepting `phone_number`, in any shape and with no sanity bound, because a 400 would break the merged #327 on an odd value. It never stores it, parses it into state, logs it or echoes it.
  - The never-log list, the log-capture assertions, the Sentry scrub tests and the raw-response-bytes assertion keep the number as a needle.
  - A new assertion proves that no row in any auth table contains it.
- **The consumer:** the security architect asks #327's author, through the community architect, to stop sending it. A later PR removes the field from the contract, and spec 321's "never sent on" rule then applies again.

**Success criteria (amendment 2):**
- [ ] `0001` creates no `phone_number` column. The schema, journal-parity and better-auth model tests agree.
- [ ] A `phone_number` sent in several shapes (a number, a string, `null`, empty, too long, non-digits) is accepted with a 200, and afterwards no row in any auth table contains it. No response, log line or Sentry event carries it.
- [ ] No code path in apps/auth or packages/auth reads `phone_number` beyond accepting the request body (a source-level check).
- [ ] Verified, as a phase step, that `0001` is applied nowhere (staging's `auth.users` has no `phone_number` column); otherwise `0002` drops it.

## Success Criteria

**Service keys and scripts**
- [ ] `@better-auth/api-key` is pinned to exactly the installed `better-auth` version (1.7.7); core is not bumped.
- [ ] The `apikey` table mirrors the plugin's model with generator column names, in the `auth` schema (uuid id, `timestamptz`, `reference_id` uuid → `auth.users` on delete cascade). Migration `0001` (with `unique(provider_id, account_id)`, and no `phone_number` column: amendment 2, §5) is the reviewed `drizzle-kit generate` output, numbered by main. The schema tests cover it, and a test checks the schema against better-auth's own model of the configured auth (`getAuthTables`), with `reference_id`'s uuid type and foreign key the one documented deviation.
- [ ] apps/auth refuses to start when `auth.apikey` is absent (`42P01`) or the `(provider_id, account_id)` constraint is absent, with a `{name, code}` log.
- [ ] Database unreachable at boot → apps/auth starts and listens, and `/health` reports the database as down; when the database returns, `/health` recovers without a restart.
- [ ] The blocked list is derived from `apiKey().endpoints`, filtered to defined paths, with two assertions: 7 endpoints, 5 routed; neither `disabledPaths` nor the middleware contains `undefined`. For each of the 5 paths, this finite list gets the block response: exact; upper-case; mixed case; trailing slash; percent-encoded letter (`%61pi-key`); double-encoded (`%2561pi-key`); doubled slash; `/./` segment; `/x/../` segment; backslash; absolute-form target; a `/suffix` appended. `/api/auth/api-key/verify` and `/api/auth/api-key/delete-all-expired-api-keys` are blocked by the prefix too.
- [ ] `enableSessionForAPIKeys` is `false`. A valid key sent as `x-api-key` and as a bearer to `/api/auth/get-session` and `/api/auth/token` yields no session and no token.
- [ ] A key created by the script verifies at the exchange. In its row: the full raw key appears in no column; `start` is null (`startingCharactersConfig.shouldStore: false`); `key` equals the plugin's hash of the raw key (`defaultKeyHasher`, SHA-256 base64url).
- [ ] The create script prints the raw key exactly once. List, rotate and revoke print ids, names, prefixes, permissions, limits and dates, never a key or a hash.
- [ ] Every script refuses to run without a database URL, writes only with a matching `--confirm <id>`, and logs the key id acted on. Before any write it prints the hostname and port only; tested with a URL carrying a user, a password and a query string, none of which appears in the output.
- [ ] The create script refuses `remaining` without a refill, a missing rate limit, values outside the `limits.ts` bounds, and any expiry option.
- [ ] The service-user script creates `service-<name>@noreply.askansari.ai` and its `service` account row in one transaction, and refuses an existing service name.
- [ ] Rotate leaves two live keys, both verifying. Revoke sets `enabled = false` and keeps the row; the revoked key then fails at the exchange with the 401 body.
- [ ] Create, rotate and revoke each send one Sentry event with service, key id, name and action, and no key material. A failed send keeps the write, prints the key-log banner and exits non-zero.
- [ ] Exhausting a refilled budget refuses the key and keeps the row; after the refill interval, the same key verifies again.
- [ ] `grant-admin.ts` refuses a `@noreply.askansari.ai` address, as it refuses the system domain.

**Exchange: key refusals** (identical 401 body; no user, account or session created)
- [ ] no `Authorization` header (answered without touching the database); non-Bearer scheme; empty bearer; a session token as the bearer; a JWT as the bearer;
- [ ] unknown key; revoked (disabled) key; expired key (seeded);
- [ ] budget exhausted; per-window rate limit exceeded;
- [ ] key with `{ mcp: ['complete'] }` only; key with no permissions;
- [ ] a `{ whatsapp: ['mint'] }` key owned by a different service user (seeded directly; the script cannot produce it).

**Exchange: failures that are not 401** (once the relation-check cache window has elapsed)
- [ ] `auth.apikey` dropped under a running apps/auth (boot passed earlier, then the relation goes): after waiting out `APIKEY_RELATION_CHECK_TTL`, a formerly valid key and an unknown key both get 500.
- [ ] Database stopped under a running apps/auth (production-shaped, `NODE_ENV=production`): after waiting out `APIKEY_RELATION_CHECK_TTL`, a valid key and an unknown key both get 500. Inside the window, a 401 is the stated residual.
- [ ] A missing or malformed bearer gets 401 with zero database queries (counted).
- [ ] WhatsApp service user missing → 500 plus an alert.
- [ ] The resolved user deleted between lookup and lock → 500, no session row, no token.

**Exchange: identity and delegation**
- [ ] A new BSUID creates exactly one user (address exactly `whatsapp-<sub>@noreply.askansari.ai`), one `whatsapp` account row and one session. It returns a JWT that verifies against apps/auth's JWKS with the same `alg`, `iss`, `aud` and lifetime as a `/api/auth/token` JWT, payload `{sub, sid}` naming that user and session.
- [ ] The same BSUID twice returns the same `sub` and the same `sid`; the user has one session.
- [ ] For every returned token, the session's `expiresAt` ≥ the token's `exp` + `SESSION_MARGIN`. A session that would fail this is replaced (old one deleted, `sid` names the new one).
- [ ] **Claim-set equality.** An exchange JWT and a `/api/auth/token` JWT for the same kind of user have the same claim keys (`sub`, `sid`, `iat`, `exp`, `iss`, `aud`), the same `alg` and `kid` source, the same `iss` and `aud`, and the same `exp − iat`. A test also pins that the exchange's hand-built `{sub, sid}` equals what `definePayload` returns for the same session, so the two cannot drift.
- [ ] **Only a user whose sole account row is `whatsapp` is ever minted for.** Each of these gets 500 and an alert, never a token:
  - a `whatsapp` row attached to an email user (one with a `credential` row);
  - a `whatsapp` row attached to a service user;
  - a `whatsapp` row attached to an admin;
  - a WhatsApp user later promoted to admin (seeded, since `grant-admin.ts` refuses);
  - a WhatsApp user whose address or `registered_via` was changed.
- [ ] Passing an admin's or email user's id or email as `bsuid` is just an unknown BSUID: it creates a new WhatsApp user and never reaches the seeded user. The same holds for a `google` user's `account_id`. This is the lookup's property (fixed provider), not a format check's.
- [ ] A banned WhatsApp user gets 403, all their sessions are deleted, and a JWT minted before the ban then fails `GET /api/account/me`. An expired ban is not refused.
- [ ] The per-user budget returns 429 with an integer `X-Retry-After` once spent; another user under the same key is unaffected; the `rate_limit` key contains the user id, not the BSUID.
- [ ] **The counter survives a refused request:** after a request refused with 403 (banned) or 500 (ineligible), the user's `rate_limit` count has still increased by one.
- [ ] The locking transaction sets `lock_timeout` and `statement_timeout` (values in `limits.ts`). A test holding the user's row lock from another connection gets a 500 within the timeout, not a hang.
- [ ] **Concurrency, scoped to what each test proves.** On pglite, which serializes connections:
  - a forced conflict on `unique(provider_id, account_id)` leaves one user, and both callers get its token;
  - a ban landing between the account lookup and the lock is seen under the lock (403, no session).

  A source-level assertion pins that the eligibility re-read, the ban check and the session write all run inside the transaction that holds `FOR NO KEY UPDATE`, that `signJWT` runs after it (amended; see §2, step 6), and that `consumeWindow` runs outside it. The plan's real-Postgres probe shows a ban and a session write behave as specified under that lock, each step **under a test deadline** (a red test on timeout, never a hung suite). Concurrent messages for one user are exercised in the staging smoke.

**Exchange: privacy, logging, transport**
- [ ] No created row (user email and name, session IP and user agent, account, `rate_limit`) contains the BSUID except `account.account_id`.
- [ ] **The phone number is stored nowhere** (amendment 2, §5). A `phone_number` sent to the exchange, in any shape, is accepted and ignored: no row in any table contains it after an exchange (asserted by a scan of every auth table), and it is absent from every response, log line and Sentry event.
- [ ] Across every refusal, failure and outage case, `console.*` and better-auth's logger contain no raw key, key hash, session token, BSUID, phone number or driver error object.
- [ ] Better Auth's logger: a non-error log survives with its level and message; a known driver error passed to it is reduced to exactly `{name, code}`; a near miss (a plain object with `name`/`code`-like fields, and a non-error string argument) survives unchanged. This criterion cannot be met by disabling the logger.
- [ ] Sentry events from the exchange carry no request body, no `Authorization` header and no phone number (tested on a captured event).
- [ ] No response from the exchange contains the bearer, the BSUID, the phone number or the request body (asserted per case on the raw response bytes).
- [ ] No response from the exchange carries `Access-Control-Allow-Origin` (or any `Access-Control-*` header), for `POST` and `OPTIONS` alike, with `Origin` set to: each configured `CORS_ORIGIN`; `null`; `https://evil.example`; and no `Origin` at all. The exchange router is mounted before `corsFor`, pinned by a test on the middleware order.
- [ ] A body over the byte limit → 400 (after the key), and a body sent with no key is never parsed.

**Alerts** (through `alerts.ts`, in its posture: Sentry events carry counts, windows and hash prefixes, never a personal identifier. An operator-actionable user id goes only in a server log line. Key ids may appear in the scripts' events: they identify a credential, not a person.)
- [ ] Per-key exchange request volume over `WHATSAPP_EXCHANGE_KEY_ALERT` per window.
- [ ] `USAGE_EXCEEDED` and `RATE_LIMITED` refusals (one event per window each).
- [ ] 401 volume per window over `EXCHANGE_UNAUTHORIZED_ALERT`.
- [ ] Eligibility violations (count event, plus a server log line with the user id) and an unresolvable service user.
- [ ] The alert thresholds are named constants in `limits.ts`; their values are set with owner decision 3.

**Reserved domain**
- [ ] Sign-up with a `@noreply.askansari.ai` address (any case) returns the same 409 body as a taken address. With surrounding spaces, sign-up's validation (which runs first, in the legacy register order) answers 400 for every address, reserved or not, so a padded noreply address and a padded taken address still answer identically (amended in phase 3: the original text promised 409 for a padded address, which the existing guard order never gives).
- [ ] Near misses are not reserved: `someone@askansari.ai`, `x@noreply.askansari.ai.example.com` and `x@notnoreply.askansari.ai` sign up normally.
- [ ] A reset request for an existing noreply user returns the same response as an unknown address, and the mailer is never called.
- [ ] The `user.create.before` hook refuses both reserved domains on every Better Auth path.
- [ ] Sign-in with a noreply user's address returns the same response as an unknown address (shape only; see the timing residual).
- [ ] `isSystemAddress` and `SYSTEM_EMAIL_DOMAIN` are unchanged, and their existing tests pass unedited.

**End to end**
- [ ] In the existing apps/api contract tests (which start a real apps/auth), a JWT from the exchange passes `requireUser`: JWKS verification, first-use `GET /api/account/me`, and a `public.users` row under the same UUID with `registered_via = 'whatsapp'`.
- [ ] apps/api's source gains no WhatsApp-specific code. A scan over `apps/api/src/**` and `apps/api/lib/**` (tests excluded, since the contract test names `registered_via = 'whatsapp'`) for `whatsapp` (case-insensitive) reports its hit count, 0 today and 0 after. Its negative tests: a known-bad line (`if (registeredVia === 'whatsapp')` in a fixture under the scanned glob) is caught; a near miss outside the glob is not.
- [ ] Staging smoke, run and signed off by the WhatsApp builder (#327) against staging apps/auth and apps/api with a key issued by the create script: a phone-visible user, a phone-hidden user, and 5 messages from one user sent within one second. Expected: 5 answers, 1 user and 1 session in apps/auth afterwards, and at most 5 exchanges (fewer if the consumer's token cache serves some). Recorded as a comment on PR #327 by its builder, with the counts. This is a pre-production gate, not a merge gate for this PR.

**Documentation**
- [ ] `docs/self-hosting.md` covers the new route, the service-user and key scripts, the `limits.ts` bounds, and the migration-before-code order.
- [ ] The runbook covers:
  - issuance (service user, then key, inside the auth service);
  - the handoff: paste straight into the consumer's Railway variable, never anywhere else;
  - rotation overlap and the doubled ceiling while two keys are live;
  - revocation (`enabled = false`), and pruning of expired rows (none expected, since production keys have no expiry);
  - budget sizing (owner decision 3);
  - the pre-apply check that `auth.account` holds no duplicate `(provider_id, account_id)` before `0001`, noting that adding the constraint takes an ACCESS EXCLUSIVE lock on a table every sign-in reads (apply in a quiet window);
  - the alert meanings;
  - **scheduled rotation**: every 6 months per key, owned by the operator. Production keys have no expiry, so nothing else forces a rotation;
  - **secret scanning**: a GitHub organisation custom secret-scanning pattern per key prefix (e.g. `wa_` followed by 64 letters), so a key committed to any repository in the organisation is flagged. Configuring it is an owner action in GitHub's settings; the runbook gives the exact patterns.
- [ ] Each documented secret-scanning pattern is tested in the repo: it matches a freshly created key of its service, and it does not match a near miss (a 63-letter tail, another service's prefix, a session token).
- [ ] `codev/resources/arch.md` (Authentication & Authorization) describes service keys, the exchange, the noreply domain and the alert posture (counts and hash prefixes in Sentry; user ids only in server log lines).
- [ ] The runbook gives the repair for an eligibility alert: find the user from the log line, inspect its account rows, role, address and `registered_via`, then remove the stray row or role, or delete the user so the next message recreates them.

**Unchanged**
- [ ] `ROUTER_RULES` are all `false`; no per-IP rule applies to the exchange.
- [ ] Every existing apps/auth, packages/auth and apps/api test passes unedited, except tests that enumerate the blocked paths, the schema or the reserved check (which gain the new entries), and tests that assert better-auth's log output (which change with the redacted logger, each listed in that commit's message).
- [ ] No new environment variable. If one appears, it is added to `turbo.json` `globalEnv` by the four-way derivation and reviewed by main.

## Constraints

- **Risk tier High** (auth model, new table, new credential type): porch's consultation on spec, plan and PR, plus the security architect's 3-way review at each gate. All four owner decisions are answered (decision 3's numbers are set in the plan).
- **Pin, do not bump.** The plugin's newest release requires core 1.7.14; bumping core is a separate, joint change.
- **Schema discipline.** `schema.ts` is hand-written; `drizzle-kit generate` → reviewed SQL → applied by a human with `psql -v ON_ERROR_STOP=1 --single-transaction` against the auth database. Never `db:push`. `architect:main` is messaged before the journal entry is committed. Migration before code at deploy.
- **Two databases.** Everything here is in the auth database and apps/auth. apps/api changes only in tests. No query crosses the two.
- **Tokens.** The exchange's JWT must be indistinguishable from any other apps/auth JWT, and signed from a real session that outlives it at signing time.
- **Client IP.** No per-IP rule on the exchange; `ROUTER_RULES` stays all `false`.
- **Where secrets live.** The raw key lives in the consumer's secret variable and, once, in the create script's output; apps/auth holds its hash. Session tokens created by the exchange never leave apps/auth. Never log a raw key, a key hash, a session token, a raw driver error, a BSUID or a phone number. The phone number is stored in exactly one column and returned by nothing.
- **Limits.** Every number lives in `packages/auth/src/limits.ts`.
- **Sequencing** (amended 2026-10-28, owner decision). The PR merges to `develop`, which deploys to staging, where `0000` is already applied; `develop` is not frozen, and further features land there before production. Staging: the duplicate check, then `0001` applied and verified, **before** the merge, because apps/auth refuses to boot without it. Production: at the production cutover, the full auth journal as it stands then (`0000`, `0001` and any later migration) is applied in order before the promoted code deploys, owned by `docs/cutover/better-auth-cutover.md`. The migration is `0001` in `packages/auth/drizzle`.
- **Scope guard.** #314's verify route does not creep in. The leaderboard is not migrated.
- **Process.** Explicit `git add` only; no AI attribution; commits `[Spec 329][Phase: x] type: message`; `.env` files are never read.

## Assumptions

- The spec 300 cutover lands without changing `createAuth`'s plugin list, the account-route mounting or `BLOCKED_AUTH_PATHS` in a way that conflicts with this design. Any conflict is reconciled on the branch before merge.
- BSUIDs follow Meta's documented shape (see Current State), but the exchange enforces only sanity bounds, so a format change by Meta does not refuse real users.
- A BSUID is stable per user per business portfolio, until the user changes phone number: Meta then issues a new BSUID, which this spec treats as a new user (continuity is deferred; see Nice-to-know).
- The WhatsApp service holds one key at a time (two during rotation) and is the only consumer of `whatsapp: mint`.
- PR #327 adopts the contract above (header, error handling, re-exchange on an apps/api 401). It still sends `phone_number`, which the exchange accepts and ignores (amendment 2, §5). It is asked to stop, and spec 321's "phone number is never sent on" rule then applies again.
- `@better-auth/api-key` 1.7.7 behaves as probed, and better-auth's `returned: false` / `input: false` field attributes behave as their source reads. The plan probes the parts not yet proven: `createApiKey` from a script, `shouldStore: false`, `signJWT`'s claims, the logger redaction, and the session write and ban under `FOR NO KEY UPDATE` on a real Postgres. Tests pin every behaviour relied on, so a later bump that changes one fails loudly.

## Solution Approaches

### Approach 1 (recommended): plugin for keys; identity rows written directly; one locking transaction for the decision

Keys come from `@better-auth/api-key` (hashing, permissions, budgets, atomic usage accounting), created in-process by the scripts, with its HTTP surface blocked by derivation and prefix, and its logger redacted. The exchange:
- verifies the key and binds its owner;
- creates the WhatsApp user and account row in its own transaction, the pattern `banUserByEmail` uses;
- spends the per-user budget on the pool, outside any transaction;
- in one locking transaction (with lock and statement timeouts): re-reads eligibility and ban, writes the one session row directly (or through `internalAdapter.createSession` under `runWithTransaction`); then, after the commit, signs with `signJWT` (amended; see §2, step 6).

The `user.create.before` hook refuses both reserved domains unconditionally. That is stronger than the issue's "permitted only when the creating context is the exchange or a script", with the same outcome and no context check to get wrong.

- **Pros:**
  - user and account are atomic;
  - the hook stays unconditional;
  - the delegation rule is a fixed-provider lookup plus an owner check plus an eligibility check under a lock;
  - no credential crypto is maintained here.
- **Cons:**
  - the exchange writes `auth.users` and `auth.account` rows itself, so it must match Better Auth's row shape (pinned by the hand-written schema and read back through Better Auth in tests);
  - the exchange writes the session row too, so it must match Better Auth's session shape (token generator, lifetime); tests read it back through Better Auth.
- **Risk:** medium. The plan's first phase probes the unproven library paths before anything is built on them.

### Approach 2: identity through Better Auth's internal adapter with a context marker

Users and accounts are created through `internalAdapter.createUser` / `createAccount`, and the hook permits the noreply domain only when a marker set by the exchange or the script is present.

- **Pros:** every row is written by Better Auth's code.
- **Cons:**
  - user and account are not one transaction unless wrapped in the same transaction context;
  - the hook's safety rests on a marker no HTTP path can forge, a subtle invariant across upgrades.
- **Risk:** medium. Rejected in favour of an unconditional hook.

### Approach 3: hand-rolled service keys (no plugin)

A small table of hashed keys with permissions and limits, verified by apps/auth's own code.

- **Pros:** no dependency and no surface to block; outage and refusal are distinguishable by construction.
- **Cons:**
  - re-implements the atomic accounting, refill and rotation the plugin already does and tests;
  - diverges from the issue and from #314's consumer model.
- **Risk:** medium (new credential code). Rejected. The plugin's weaknesses found here (outage reported as `INVALID_API_KEY`, raw error logging, deletion on no-refill exhaustion) are closed by the relation check, the redacted logger and the script's refill rule, with the residuals stated.

**Recommendation: Approach 1.**

## Open Questions

**Critical: owner decisions (all answered, 2026-10-28)**

1. ~~The non-interactive domain name.~~ **Decided by the owner (2026-10-28):** `@noreply.askansari.ai`, a fixed reserved subdomain with the account kind as a local-part prefix (`whatsapp-<user id>`, `service-<service name>`). This follows the common convention (GitHub's `users.noreply.github.com`, Apple's `privaterelay.appleid.com`). Considered and rejected:
   - a hostname per user (e.g. `whatsapp-<id>.askansari.ai`): the reserved check would have to pattern-match hostnames instead of testing one fixed suffix, and the id would sit in a DNS label;
   - the bare `@askansari.ai`: it would refuse real staff addresses.
2. ~~Store the BSUID raw or HMAC it.~~ **Decided by the owner (2026-10-28): raw**, in `account.account_id`, no HMAC. The original reasoning: The BSUID is already Meta's business-scoped pseudonym and is needed for lookup, as any OAuth provider id is. HMAC defends against correlation after a database leak, but costs a new secret, a new env var and a rotation story that re-keys every row.
3. **The WhatsApp key's limits. Decided by the owner (2026-10-28): sized by judgement in the plan.** Traffic is low, there is one WhatsApp service instance initially, and there are no specific numbers. The caps bound a leaked key and a looping client, not normal use. The plan sets generous initial values with about an order of magnitude of headroom, alert thresholds well below the caps, and wide `limits.ts` bounds, so raising a value is a one-line change. A live key's values change through the script's `update-limits` (the plugin's `updateApiKey`) or by rotation. The original framing: The decision is two numbers per key:
   - a per-window ceiling (`rateLimitMax` per `rateLimitTimeWindow`, e.g. per minute);
   - a daily budget (`refillAmount` per 24 h).

   Recommendation: both, at about twice the legacy peak, sized for instances × restarts, since the consumer's 15-minute token cache is per process. A refilled budget is safe: exhaustion refuses and keeps the key. The `limits.ts` bounds and the per-user exchange budget are set in the plan from the same traffic data. Budgets are per key, so rotation briefly doubles them.
4. **The leaderboard. Decided by the owner (2026-10-28): later, out of scope.** It stays on its static secret. Nothing forces it, and this spec ships one consumer.

**Resolved** (by the security architect's direction or by builder decision; recorded so the plan does not re-decide them)

5. Every key refusal, including the plugin's 429s, is the one 401 (architect).
6. Banned user: 403 `{ "message": "Forbidden" }`, so the consumer can tell "this user is banned" from "my key is bad". This is an accepted oracle toward a trusted key holder.
7. Order: key, then body (route-local parsing after the key).
8. Image guard dropped. The scripts follow `grant-admin.ts`'s posture plus hostname-and-port output (architect).
9. No strict BSUID format (owner decision): sanity bounds only, i.e. a non-empty string of at most 256 characters with no whitespace or control characters. Meta may change the format, and the caller is the trusted WhatsApp service. A changed format, or a parent-form `US.ENT.<id>` after an enrolment change, therefore creates new users rather than 400s. That is a known consequence, to be watched through the creation signal (item 18).
10. `start` not stored (`shouldStore: false`).
11. Revoke disables and keeps the row. Production keys have no expiry.
12. A per-user exchange budget inside the key's bound, keyed by user id, with its 429.
13. ~~The phone number is stored on `auth.users` (owner decision), with the rules in Desired State §3.~~ Reversed by owner amendment 2 (§5): no phone number is stored.
14. The session row is written directly in the locking transaction, under `FOR NO KEY UPDATE` (architect).
15. The exchange router is mounted before `corsFor`; the boot assertion fails only on a definite missing-schema answer; the per-user budget runs outside the transaction; `iat` and `exp` are passed to `signJWT` explicitly; the relation check runs on every plugin refusal, with a named TTL; a 500 is not retried per message (architect, iteration 3).

**Nice-to-know**

16. **Session sliding.** The reused session is 30 days and slides daily on use. An active user keeps one session; a quiet one gets a fresh one.
17. **Deleting a WhatsApp user.** `DELETE /api/account` with the user's own JWT cascades the account row away, so the next message from that BSUID creates a new user. This is intended; a user-facing delete flow for WhatsApp is out of scope.
18. **New-user volume.** An alert on WhatsApp user creations per window would add a second signal beside per-key volume, and would surface a Meta format or enrolment change (item 9). Plan-level option.
19. **Number-change continuity (deferred, as spec 321 defers it).** When a user changes phone number, Meta issues a new BSUID and sends a system message (`system.type` `user_changed_user_id` or `user_changed_number`, with `system.previous_user_id`). Today the new BSUID becomes a new user. That message is the hook for the deferred work: re-pointing the `whatsapp` account row from the old BSUID to the new one. (Amendment 2, §5: no stored number is available as corroboration; that work needs its own proof.)

## Test Scenarios

**Probes first (plan phase 1, before anything is built on them)**
1. `auth.api.createApiKey` from a script context: the key verifies; the raw key is in no column, `start` is null, and `key` equals `defaultKeyHasher(raw)`; `permissions` and `metadata` round-trip.
2. `auth.api.signJWT` with explicit `{sub, sid, iat, exp}`: the claim set equals a `/api/auth/token` JWT's (with no `iat`, it would differ, per `sign.mjs`). The passed `exp` is honoured, not overridden by the configured lifetime.
3. The redacted logger: non-error logs survive; error objects are reduced to `{name, code}`.
4. Real Postgres, every step under a deadline: under `FOR NO KEY UPDATE` on the user, a directly written session row commits without waiting on its own lock; a concurrent ban waits for the exchange, then deletes its session; `lock_timeout` turns a held lock into an error. A directly written session is accepted by the bearer plugin and `/api/account/me`. `signJWT` does no database write, but it reads `jwks` through the pool, so it runs after the commit (amended; see §2, step 6). The probe includes pool starvation: signing after the commit finishes, signing inside hangs or fails loudly.
4a. ~~`returned: false` / `input: false`: `phone_number` is absent from `get-session` and sign-in responses, and ignored when sent to sign-up.~~ Withdrawn (amendment 2, §5): there is no phone field.

**Functional (pglite: packages/auth and apps/auth suites)**
5. Happy path: new BSUID → 200; the token verifies; `sub`/`sid` match; rows as specified; address exact.
6. Repeat: same BSUID → same `sub`, same `sid`, one session.
7. Session margin: a session whose `expiresAt` < token `exp` + margin is replaced.
8. Conflict: a forced second insert for the same BSUID → one user, both callers get its token.
9. Ban under the lock: a ban committed between lookup and lock → 403, no session.
10. Deleted mid-exchange: the user removed between lookup and lock → 500, no session.
11. Every key refusal → the identical 401 body, no rows.
12. Owner binding: a `whatsapp: mint` key under another service user → 401. Service user missing → 500 + alert.
13. Eligibility matrix: `whatsapp` row on an email, service or admin user; a promoted WhatsApp user; an altered address or `registered_via` → 500 + alert, no token.
14. Delegation inputs: admin and email-user ids and emails, and a `google` user's `account_id`, passed as `bsuid` → each is an unknown BSUID: a new WhatsApp user is created, and the seeded user is never reached.
15. Ban: 403, sessions deleted, an earlier JWT dead at `/api/account/me`; an expired ban is let through.
16. Per-user budget: 429 with an integer `X-Retry-After`; another user unaffected; the `rate_limit` key holds the user id; the counter survives a 403 and a 500; it runs on the pool, outside the transaction.
16a. Lock timeout: the user row held from another connection → 500 within `lock_timeout`.
16b. Claim-set equality with `/api/auth/token`; `definePayload` agreement.
17. Body: non-JSON, oversized, `bsuid` missing, non-string, empty, over 256 characters, containing whitespace or a control character → 400 (all after a valid key). `phone_number` in any shape (string, number, null, empty, too long) → accepted and ignored (amendment 2, §5). No key → never parsed. A lower-case or unusual but sane `bsuid` is accepted.
17a. Phone number (amendment 2, §5): sent with an exchange in several shapes, then a scan of every auth table finds it in no row, and no response, log line or Sentry event contains it.
18. Transport: no `Access-Control-*` header on `POST` or `OPTIONS` for the four `Origin` cases, and the router is mounted before `corsFor`; a session token or JWT as the bearer → 401; not reachable under `/api/auth/*`.
19. Blocked surface: derived from 7 endpoints, 5 routed, no `undefined`; the finite variant list under `/api/auth/api-key` is blocked; `/api-key/verify` → 404.
20. Keys are never sessions: a valid key as `x-api-key` and as a bearer at `/get-session` and `/token` → nothing.
21. Reserved domain: sign-up 409 identical to taken; near misses sign up; reset identical to unknown, mailer not called; hook refusal; sign-in identical to unknown; `grant-admin.ts` refuses noreply; `isSystemAddress` unchanged.
22. Scripts: no database URL; show without confirm; mismatched confirm; hostname-and-port only (URL with userinfo and query); create prints once; refuses no-refill, out-of-bounds and expiry; list has no secrets; rotate gives two live keys; revoke disables and keeps; Sentry events with no key material.
23. Refilled budget: exhaust → refused, row kept; past the interval → verifies.
24. Source-level: the eligibility re-read, ban check and session write sit inside the `FOR NO KEY UPDATE` transaction; signing sits after it (amended; see §2, step 6).

**Non-functional**
25. Log and Sentry capture across 5–23: no raw key, hash, session token, BSUID, phone number or driver error object; Sentry events carry no body or `Authorization`.
26. Outages: boot refuses on `42P01` or a missing constraint; boot with the database unreachable starts, `/health` reports it and later recovers; `auth.apikey` dropped under a running service → 500 after the cache window; database stopped under a running apps/auth (`NODE_ENV=production`) → 500, never 401.
27. Alerts fire for per-key volume, `USAGE_EXCEEDED`, `RATE_LIMITED`, 401 volume, eligibility violations and a missing service user.
28. End to end in apps/api's contract harness: exchange token → `requireUser` → `public.users` row.
29. Staging smoke (WhatsApp builder signs off): phone-visible, phone-hidden, concurrent messages from one user.

## Risks and Mitigation

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| A WhatsApp key mints for a non-WhatsApp user (a `whatsapp` row on another user, a promotion, a future social provider) | Low | Critical | Fixed-provider lookup; owner binding; **eligibility under the lock** (sole `whatsapp` row, noreply domain, `registered_via`, not admin), else 500 + alert; `grant-admin.ts` refuses noreply; eligibility matrix tests |
| Ban or deletion races token issuance | Medium | High | Lock first, re-read under it; session in the same transaction, signing after its commit against the same `exp`; consumer re-exchanges once on an apps/api 401 |
| A write waits on the request's own user lock (self-deadlock), or a held lock stalls the shared pool | Low | High | `FOR NO KEY UPDATE`, which does not conflict with a foreign key's `KEY SHARE`; session written in the same transaction; `lock_timeout` and `statement_timeout` make the worst case a 500; real-Postgres probe under deadlines |
| A session token (30-day bearer credential) leaks | Low | Critical | Better-auth's generator; never returned, logged or sent to Sentry; in the log-capture assertions |
| An outage or unapplied migration answered as 401 | Medium | High | Relation-level check on every plugin refusal, cached for a named TTL; boot assertion on definite answers only; tests for an absent relation and a stopped database; residual window stated |
| An unknown-key flood amplifies database work | Medium | Medium | Cached relation check; 401-volume alert; residual stated |
| The plugin logs raw driver errors | High without mitigation | High | Redacted logger (not disabled), with near-miss tests |
| A burst deletes the production key | High if `remaining` were set without refill (probed) | High | The script refuses no-refill; refilled exhaustion pinned as refused-and-kept; no expiry; revoke disables and keeps |
| One looping user exhausts the key for everyone | Medium | High | Not prevented by the per-user budget (the key is spent at verify, before it). The key's budget is sized to absorb a looping user; the per-key volume alert catches one; the per-user budget bounds that user's session churn and probing |
| A leaked key confirms BSUID membership and bans, or creates users | Low | High | Accepted residual toward the delegation authority; per-key volume, exhaustion and rate-limit alerts; rotate and revoke |
| The plugin surface reachable through a variant or a new endpoint | Low | Critical | Derived list asserted at 7 endpoints and 5 routed; `/api/auth/api-key` prefix rule; `enableSessionForAPIKeys` pinned false |
| CORS lets a browser call the exchange | Low | Medium | No allow-origin on any exchange response, tested |
| A raw key mishandled at handoff | Medium | High | The runbook's direct-to-variable handoff; printed once; Sentry events carry no key material |
| Migration `0001` collides, ships unapplied, or locks `auth.account` at a bad moment | Medium | High | Main numbers it; boot assertion; pre-apply duplicate check and quiet-window guidance in the runbook |
| Conflicts with other work landing on `develop` | Medium | Low | Reconciled on the branch before merge; tests pin behaviour |
| A plugin or core bump changes relied-on behaviour | Medium | Medium | Each behaviour pinned by a test; plugin pinned to core |
| The phone number the consumer still sends leaks (row, response, log, Sentry) | Low | High | Accepted and ignored, never stored (amendment 2, §5); the all-tables row scan, never-log list, capture tests and Sentry scrubbing keep it as a needle; #327 asked to stop sending it |
| (withdrawn) The stored phone number leaks (response, log, Better Auth output, apps/api) | Low | High | One column; `input: false` and `returned: false`; absent from `/api/account/me`; never-log list and capture tests; Sentry scrubbing |
| A Meta format or enrolment change splits users | Low | Medium | Sanity bounds only, so real users are never refused; the creation-volume signal surfaces a jump; continuity is deferred work (Nice-to-know 19) |

## References

- Issue #329 (this spec); spec 321 / PR #327 (WhatsApp, first consumer); issue #314 (MCP, second consumer)
- `codev/specs/300-better-auth-migration.md`: two databases, reserved addresses, account endpoints, rate limits and client IP
- `codev/resources/arch.md`: Authentication & Authorization
- `codev/resources/lessons-learned.md`: Better Auth migration (spec 300); Auth hardening (spec 4)
- `@better-auth/api-key` 1.7.7 package source (`dist/index.mjs`: schema, endpoints, `validateApiKey`, `consumeRemaining`, `verifyApiKey`'s catch), and the specify-phase pglite probe whose results are tabled above
- better-auth 1.7.7 `db/internal-adapter.mjs` (`getCurrentAdapter`, `runWithTransaction`, `createSession`'s `generateId(32)` token), `db/schema.mjs` (`returned: false` output filter) and `plugins/jwt` (`signJWT`, server-only)
- Meta, Business-scoped user IDs: developers.facebook.com/documentation/business-messaging/whatsapp/business-scoped-user-ids
- Security architect's consolidated spec review, iteration 2 (inputs kept in `codev/projects/329-apps-auth-service-api-keys-bet/`)
