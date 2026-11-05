# Plan: Service API keys and the WhatsApp token exchange (apps/auth)

**Specification**: [codev/specs/329-apps-auth-service-api-keys-bet.md](../specs/329-apps-auth-service-api-keys-bet.md)

## Executive Summary

The plan implements the spec's Approach 1:
- `@better-auth/api-key` 1.7.7 for keys, created in-process by operator scripts, with its HTTP surface blocked by derivation and prefix, and better-auth's logger redacted;
- the WhatsApp user, account and session rows written directly with Drizzle;
- the exchange's decision (eligibility, ban, ~~phone number,~~ session) *(superseded by phase 8: no phone number)* made in one transaction holding `FOR NO KEY UPDATE` on the user row; the JWT is signed **after** that transaction commits, with the `exp` the session was checked against.

The order follows three rules:
1. **Probe before building, with a fail-closed gate before each probe's first consumer.** If a probe's result differs from the plan, work stops at that gate and the builder raises it with the security architect:
   - **before phase 4:** the key probes (`createApiKey` from a script, `shouldStore: false`, `updateApiKey`);
   - **before phase 5:** the JWT probe (`signJWT` claims and `exp`), the field probe (`returned: false` / `input: false`), the session-token probe, and the real-Postgres lock and pool probes;
   - **before phase 6:** the logger probe and the outage-mapping probe (phase 2).
2. **No commit publishes a surface it does not also guard.** The plugin is wired in the same commit that blocks its routes. The exchange route lands with its CORS placement, key check and timeouts in one commit.
3. **Library before service.** The identity and session core lives in `packages/auth` and is tested on pglite, then the apps/auth route wraps it.

Eight phases, each one commit in a single PR. Phase 8 implements spec §5, owner amendment 2 of 2026-10-30 ("drop phone number entirely, whatsapp id is enough"). That amendment withdraws amendment 1, the phone-number plugin and claiming by number, which was planned here and reviewed but never built. Deploy order (amended 2026-10-28, owner decision): the PR merges to `develop` (staging) once `0001` is applied and verified on staging; at the production cutover, the full auth journal as it stands then (`0000`, `0001` and any later migration) is applied in order before the promoted code deploys, owned by `docs/cutover/better-auth-cutover.md`.

**The green command for every phase** is the root `pnpm test && pnpm typecheck && pnpm lint` (Turborepo, all packages), from a cold cache at least once per phase (`--force`), because shared-package changes in `packages/auth` reach apps/auth and apps/api.

## Phases (Machine Readable)

```json
{
  "phases": [
    {"id": "phase_1", "title": "Plugin, schema and migration 0001, blocked key surface, library probes"},
    {"id": "phase_2", "title": "Redacted Better Auth logger"},
    {"id": "phase_3", "title": "Reserved noreply domain"},
    {"id": "phase_4", "title": "Service users and key operator scripts"},
    {"id": "phase_5", "title": "WhatsApp identity and session core"},
    {"id": "phase_6", "title": "The exchange route, boot assertion and alerts"},
    {"id": "phase_7", "title": "End-to-end contract test, source scan and documentation"},
    {"id": "phase_8", "title": "Remove the phone number (owner amendment 2)"}
  ]
}
```

## Limit sizing (owner decision 3, deferred to this plan)

**Sized by judgement, not data (owner, 2026-10-28).** The owner reports low traffic, one WhatsApp service instance initially, and no specific numbers. The caps exist to bound a **leaked key** and a **looping client**, not to meter normal use. So the values below carry about an order of magnitude of headroom over any plausible low-traffic day. The alerts sit well **below** the caps, so a surge is seen before anything is refused. These are the **initial values: the decision, not placeholders.** Every number is a named constant in `packages/auth/src/limits.ts`.

**Why the message rate bounds the exchange rate.** The consumer caches one token per BSUID per process for under 15 minutes. With one instance, a conversation costs about one exchange per 15 minutes, plus one after each restart. A looping or cache-broken client costs one per message. The caps are set against the second case.

| Constant | Initial value | Reasoning |
|---|---|---|
| `WHATSAPP_KEY_INITIAL.rateLimitMax` per `rateLimitTimeWindow` | 60 per 60 s | "tens per minute": far above one instance's normal exchange rate, low enough that a leaked key or a loop is capped within a minute |
| `WHATSAPP_KEY_INITIAL.refillAmount` per `refillInterval` | 3,000 per 24 h | "low thousands": hundreds of active conversations a day at one exchange per 15 minutes, with headroom |
| `WHATSAPP_EXCHANGE_PER_USER` (per user, `consumeWindow`) | 6 per 15 min | "a handful per token lifetime": normal use is 1 (plus a restart), and a looping client for one user hits 429 at once |
| `WHATSAPP_EXCHANGE_KEY_ALERT` (per-key, per minute) | 20 per min | one third of the window cap: a surge alerts before anything is refused |
| `WHATSAPP_EXCHANGE_DAILY_ALERT` (per-key, per day) | 1,000 per day | one third of the daily budget, for the same reason |
| `EXCHANGE_UNAUTHORIZED_ALERT` (401 volume) | 20 per 5 min | a healthy consumer sees no 401s except briefly during rotation |
| `WHATSAPP_KEY_BOUNDS` (what the create and update script accepts) | window cap 1 to 100,000 per window, window 1 s to 24 h; daily budget 1 to 10,000,000 | wide on purpose: raising a value never needs the bound to change, so it needs no code review of the bound |

**Applying and changing the key's values.**
- The key's two values live in the key's row, set by the operator through the script. The spec's no-defaults rule stands: the script requires them as explicit flags. The runbook's issuance command passes `WHATSAPP_KEY_INITIAL`'s values, so the constant is the recorded decision.
- To change them, the script has an `update-limits` subcommand that calls the plugin's server-side `auth.api.updateApiKey` with the new window cap, window and refill. It is validated against the same bounds, and probed in phase 1. Revoke-and-recreate (a rotation) is the documented fallback. The runbook carries both paths.
- Changing the per-user budget or an alert threshold is a one-line edit to `limits.ts`.

**Where the alert counters live.** Not in `auth.rate_limit`: better-auth's pruner deletes rows older than the longest window it knows (an hour), so a daily counter there would vanish under low traffic, a check that passes by not running.
- **The per-key minute and day alerts read the key's own row**, which `verifyApiKey` returns on success: `requestCount` within the current window, and `refillAmount − remaining` since `lastRefillAt`. The plugin keeps both durably and atomically, and they reset with the window and the refill. An alert fires when the minute count reaches `WHATSAPP_EXCHANGE_KEY_ALERT` or the day count reaches `WHATSAPP_EXCHANGE_DAILY_ALERT`. It fires once per window or refill period, deduplicated in process by the window start or `lastRefillAt`; a restart can re-fire once, which errs loud.
- **The short-window alerts** (401 volume per 5 minutes, `USAGE_EXCEEDED` and `RATE_LIMITED` once per window) are in-process counters. A restart loses at most one window; the service runs one instance.
- A clock-advance test shows the daily alert fires after a day's worth of verifies spread over hours, with pruning running in between.

**Other constants** (not traffic-dependent), all in `limits.ts`:

| Constant | Value | Why |
|---|---|---|
| `APIKEY_RELATION_CHECK_TTL` | 5 s | bounds the pre-401 check under an unknown-key flood; also the length of the misclassification residual |
| `SESSION_MARGIN` | 5 min | the session must outlive the token's `exp` by at least this much |
| `EXCHANGE_LOCK_TIMEOUT` | 2 s | a held user row fails one request, not the pool |
| `EXCHANGE_STATEMENT_TIMEOUT` | 5 s | the same, for any slow statement in the transaction |
| `EXCHANGE_BODY_LIMIT` | 1 KB | `bsuid` ≤ 256 + ~~`phone_number` ≤ 32~~ + JSON overhead (phase 8: `phone_number` accepted in any shape, ignored; room kept for it) |

## Phase Breakdown

### Phase 1: Plugin, schema and migration 0001, blocked key surface, library probes

**Dependencies**: None

#### Objective

Add the plugin and its table, and close its HTTP surface in the same commit. Prove every library behaviour the later phases rely on, so a wrong assumption surfaces before code is built on it.

#### Files to Create / Modify

- `packages/auth/package.json`, `pnpm-lock.yaml`: `@better-auth/api-key` pinned to `1.7.7` (exact).
- `packages/auth/src/schema.ts`: the `apikey` table, mirroring the plugin's model with generator column names, uuid id, `timestamptz`, and `reference_id` uuid → `auth.users` on delete cascade. ~~`users.phoneNumber` (`phone_number`, nullable text).~~ *(superseded by phase 8: no phone number)* `unique('account_provider_id_account_id_unique').on(providerId, accountId)` on `account`. The header comment records the departures.
- `packages/auth/drizzle/0001_*.sql`, `drizzle/meta/_journal.json`, `drizzle/meta/0001_snapshot.json`: generated by `pnpm --filter @ansari/auth db:generate`, SQL reviewed. **Before committing the journal entry, message `architect:main` so main numbers it.**
- `packages/auth/src/index.ts`:
  - the `apiKey({ enableMetadata: true, startingCharactersConfig: { shouldStore: false }, enableSessionForAPIKeys: false, rateLimit: { enabled: true } })` plugin;
  - `API_KEY_PATHS`, derived from `apiKey().endpoints` and filtered to defined paths;
  - `BLOCKED_AUTH_PATHS` including them;
  - ~~the `phone_number` additional user field (`input: false`, `returned: false`).~~ *(superseded by phase 8: no phone number)*
- `apps/auth/src/middleware/blocked-paths.ts`: an `/api/auth/api-key` prefix rule beside `ADMIN_PREFIX`.
- `packages/auth/tests/migration/auth-journal-parity.test.ts`: the "single fresh 0000" assertion becomes `idx` `[0, 1]`. **`AUTH_DEPLOYED_THROUGH`:** after the cutover, main sets it to `0000`. The deployed-state test then signs up against a database migrated through `0000` only, and the `phone_number` additional field makes that insert fail. (Amended 2026-10-28, owner decision; security architect, pending main's confirmation:) `AUTH_DEPLOYED_THROUGH` is production truth, and production has nothing applied until the cutover, so this PR leaves it `null` and adds no `auth-journal-applied` record; main sets it at the cutover to the last migration applied then, with one record per migration.
- `packages/auth/src/db.ts`: an explicit pool `max` (`AUTH_POOL_MAX`, 10, pg's default made visible) and `connectionTimeoutMillis` (`AUTH_POOL_CONNECT_TIMEOUT`, 5 s), so a starved pool is a loud error (500), never an unbounded wait during which `lock_timeout` and `statement_timeout` cannot fire. Both are constants in `db.ts`; they are pool settings, not rate limits.
- `packages/auth/tests/schema/auth-schema.test.ts`: seven tables; `apikey` shape; `account (provider_id, account_id)` unique; ~~`users.phone_number`~~. *(superseded by phase 8: no phone number)*
- `packages/auth/tests/config/api-key.test.ts` (new): probes 1, 2 and 4a as permanent pinning tests.
- `apps/auth/tests/blocked-paths.test.ts`: the API-key surface tests.
- `apps/auth/scripts/probes/exchange-lock-probe.ts` (new, operator-run): probe 4 against a throwaway Postgres 18 container.

#### Deliverables

- [ ] Plugin pinned and wired; table and migration `0001` generated and reviewed; main consulted before the journal commit.
- [ ] `API_KEY_PATHS` derived with assertions **7 endpoints, 5 routed**, and no `undefined` in `disabledPaths` or the middleware's set.
- [ ] Prefix rule; the finite variant list from the spec blocked for all 5 paths, plus `/verify` and `/delete-all-expired-api-keys` under the prefix.
- [ ] Pinning tests (pglite) for:
  - **Probe 1.** `auth.api.createApiKey({ body: { userId, prefix, name, permissions, metadata, rateLimit…, remaining, refillAmount, refillInterval } })`: the key verifies with the right permission; in its row the raw key appears in no column, `start` is null, and `key === defaultKeyHasher(raw)`; `permissions` and `metadata` round-trip.
  - **Probe 2.** `auth.api.signJWT({ body: { payload: { sub, sid, iat, exp } } })`: the claim set equals a `/api/auth/token` JWT's (keys, `alg`, `iss`, `aud`, `exp − iat`); the passed `exp` is honoured. Without `iat` the claim sets differ, which pins the reason for passing it.
  - **Probe 1b.** `auth.api.updateApiKey` server-side changes `rateLimitMax`, `rateLimitTimeWindow`, `refillAmount` and `refillInterval` on an existing key, and the change takes effect at the next verify.
  - **Probe 4a.** `phone_number` is absent from `get-session` and sign-in responses, and ignored when sent to sign-up.
  - The probed plugin behaviours: no-refill exhaustion deletes the key; refilled exhaustion refuses and keeps it, and verifies after the interval; disabled is kept; expired is deleted; a wrong permission spends no budget; `valid: false` for an unknown key.
  - `enableSessionForAPIKeys: false`: a valid key as `x-api-key` and as a bearer at `/get-session` and `/token` yields nothing.
- [ ] **Session-token probe:** `generateRandomString(32, 'a-z', 'A-Z', '0-9')` from the public `better-auth/crypto` export produces tokens of the same length and alphabet as a token `internalAdapter.createSession` writes (32 characters, `[A-Za-z0-9]`). This is the generator phase 5 uses. `generateId` itself is not exported from better-auth's entry, and `@better-auth/core` is not a dependency, so no deep import is used.
- [ ] **Probe 4** (real Postgres 18, `exchange-lock-probe.ts`, run by the builder against `docker run postgres:18`, output pasted into the review). Every step under a deadline that fails red:
  - under `FOR NO KEY UPDATE` on a user row, a session row inserted in the same transaction commits without waiting;
  - a ban (`UPDATE users SET banned…; DELETE FROM session…`) on another connection waits for the exchange and then deletes its session;
  - a session insert from another connection does not wait on the lock (`KEY SHARE` compatibility);
  - `lock_timeout` turns a held `FOR UPDATE` from another connection into error `55P03`;
  - **pool starvation:** with the pool's `max` deliberately set to 2, 10 concurrent exchanges (lock, decide, write the session, commit, then sign, which reads `jwks` on the pool) all finish, or fail with the pool's connect timeout as a 500. None hangs. The same run with signing moved *inside* the transaction reproduces the hang, which records why signing is outside.

#### Acceptance Criteria

- [ ] The green command passes.
- [ ] The migration SQL creates exactly the `apikey` table, the `account` unique constraint ~~and the `users.phone_number` column~~, and nothing else (phase 8: no phone column).
- [ ] **Gate before phase 4:** probes 1 and 1b match the plan. **Gate before phase 5:** probes 2 and 4a, the session-token probe and every step of probe 4 match the plan. A mismatch stops work at that gate and goes to the security architect.

#### Test Plan

Pinning tests on pglite as above. The probe 4 script is manual, against a disposable container. The blocked-path tests reuse the admin-path variant helper.

### Phase 2: Redacted Better Auth logger

**Dependencies**: Phase 1 (the plugin is the reason, and its catch-and-log path is the test case)

#### Objective

Make better-auth's logger obey the repo rule "never log a raw driver error", without silencing it. This is its own commit, because it changes every better-auth log line in apps/auth.

#### Files to Create / Modify

- `packages/auth/src/logger.ts` (new): `redactLogArgs`. An `Error` argument becomes exactly `{ name, code }`, where `code` comes from the error's own `code` or its `cause`'s, the same rule as `account.ts`'s `errorMeta`. Every other argument passes through unchanged. A `log(level, message, ...args)` writes through `console` at the matching level.
- `packages/auth/src/index.ts`: `logger: { log: … }` in `createAuth`.
- `packages/auth/tests/unit/logger.test.ts` (new).

#### Deliverables

- [ ] The redacting logger, wired into `createAuth`.
- [ ] Tests (probe 3):
  - a non-error log survives with its level and message;
  - a pg `DatabaseError` (built with `code: '42P01'` and a message containing an email) reduces to exactly `{ name: 'DatabaseError', code: '42P01' }`;
  - near misses survive unchanged: a plain object with `name`/`code` fields, and a string argument;
  - the plugin's own path: `verifyApiKey` against a pglite database with `auth.apikey` dropped logs only the redacted form, and returns `valid: false` / `INVALID_API_KEY`, which pins the outage mapping phase 6 relies on.

#### Acceptance Criteria

- [ ] All suites pass. No existing test that asserts better-auth log output needs editing, or each one that does is listed in the commit message.
- [ ] The criterion cannot be met by disabling the logger: the non-error survival test fails if `disabled: true`.
- [ ] **Gate before phase 6:** the logger probe and the outage mapping (`auth.apikey` dropped → `valid: false` / `INVALID_API_KEY`) match the plan.

#### Test Plan

Unit tests on the formatter. Integration through `verifyApiKey` with the relation dropped, capturing `console.error`.

### Phase 3: Reserved noreply domain

**Dependencies**: None (independent of phases 1 and 2; ordered here so phase 4's scripts can rely on it)

#### Objective

Reserve `@noreply.askansari.ai` on every public path, while `isSystemAddress` stays exactly as it is.

#### Files to Create / Modify

- `packages/auth/src/reserved.ts`:
  - `NOREPLY_EMAIL_DOMAIN = '@noreply.askansari.ai'` and `isNoreplyAddress`;
  - `isReservedAddress` = system **or** noreply;
  - address builders `whatsappAddress(userId)` and `serviceAddress(name)`.

  `isSystemAddress` and `SYSTEM_EMAIL_DOMAIN` are unchanged.
- `packages/auth/src/reset-email.ts`: the sender skips any reserved address (`isReservedAddress`), not only system ones.
- `packages/auth/src/index.ts`: exports. The hook and `signUpGuard` already call `isReservedAddress`, so they need no logic change.
- `apps/auth/scripts/grant-admin.ts`: refuse a noreply address, as it refuses the system domain.
- Tests: `packages/auth/tests/config/sign-up.test.ts`, `packages/auth/tests/unit/reset-email.test.ts`, `apps/auth/tests/reset.test.ts`, `apps/auth/tests/grant-admin.test.ts`, and a new `packages/auth/tests/unit/reserved.test.ts`.

#### Deliverables

- [ ] Reserved check, reset skip, `grant-admin.ts` refusal and address builders.
- [ ] Tests:
  - sign-up with a noreply address (mixed case, surrounding spaces) returns the 409 body identical to a taken address;
  - near misses `someone@askansari.ai`, `x@noreply.askansari.ai.example.com` and `x@notnoreply.askansari.ai` sign up;
  - a reset request for an existing noreply user returns the response an unknown address gets, with the mailer never called;
  - the `user.create.before` hook refuses both domains;
  - sign-in for a noreply user returns the same response as an unknown address;
  - `grant-admin.ts` refuses a noreply address;
  - `isSystemAddress` tests pass unedited.

#### Acceptance Criteria

- [ ] All suites pass, and `isSystemAddress` / `SYSTEM_EMAIL_DOMAIN` are byte-unchanged in the diff.

#### Test Plan

Through `auth.api` and the apps/auth HTTP harness (`startService`), as the existing sign-up and reset tests do.

### Phase 4: Service users and key operator scripts

**Dependencies**: Phases 1 and 3

#### Objective

The operator can create a service user and issue, list, rotate and revoke its keys, in `grant-admin.ts`'s posture, with the raw key printed once and a durable record of every action.

#### Files to Create / Modify

- `packages/auth/src/limits.ts`: `WHATSAPP_KEY_BOUNDS` and `WHATSAPP_KEY_INITIAL` (see Limit sizing).
- `packages/auth/src/service-users.ts` (new): `SERVICES`, the fixed map from service name to permissions and key prefix (`whatsapp → { whatsapp: ['mint'] }, wa_`; `ansari-mcp → { mcp: ['complete'] }, amcp_`, reserved, no route yet). It also exports `SECRET_SCANNING_PATTERNS`, one regex per prefix (`wa_[A-Za-z]{64}`, `amcp_[A-Za-z]{64}`), the patterns the runbook asks the owner to register in GitHub. `createServiceUser(db, name)` writes the user (`service-<name>@noreply.askansari.ai`, no credential, role `user`, `registered_via = 'service'`) and its `{ providerId: 'service', accountId: name }` row in one transaction. `findServiceUser(db, name)` resolves by the `service` row and reports zero, one or many.
- `apps/auth/scripts/service-keys.ts` (new): one script, subcommands `create-service <name>`, `create-key <name> --rate-max --rate-window --daily [--name] [--client-id]`, `list <name>`, `rotate <name> …`, `update-limits <name> --key <id> --rate-max --rate-window --daily`, `revoke <name> --key <id>`. Each write takes a `--confirm <service user id>`.
  - It refuses to run without a database URL.
  - Show first; write only with a matching `--confirm` (a mismatch writes nothing, exit 2).
  - Before any write it prints the database hostname and port only (`urlHost`, already in `scripts/cutover/rehearsal-anomalies.ts`, moved to a shared helper).
  - It logs the key id acted on.
  - `create-key` calls `auth.api.createApiKey` with the service's fixed permissions and prefix, no expiry, and the operator's limits validated against `WHATSAPP_KEY_BOUNDS`. It refuses a budget without a refill and offers no expiry flag. It prints the raw key once, framed with the handoff instruction.
  - `revoke` sets `enabled = false` and keeps the row. `rotate` is `create-key`, plus a printed reminder to revoke the old key after the consumer switches.
  - Each create, rotate, update-limits and revoke sends one Sentry event (service, key id, name, action; no key material). The script initialises Sentry and awaits `Sentry.flush` with a timeout before exit. If the flush fails or times out, the write stands, the script prints a loud banner telling the operator to record the key id and action in the runbook's key log, and exits non-zero so it is noticed.
- `apps/auth/tests/service-keys.test.ts` (new); `apps/auth/tests/helpers/` as needed.

#### Deliverables

- [ ] `service-users.ts` and the script, with all of the above.
- [ ] Tests:
  - no database URL → refused;
  - show writes nothing; a mismatched confirm writes nothing;
  - the output for `postgres://user:secret@db.example:6543/auth?sslmode=require` contains `db.example:6543` and none of `user`, `secret`, `sslmode`;
  - the create output contains the raw key exactly once, and the row holds only its hash (probe 1's assertions);
  - list prints no key or hash;
  - rotate → two live keys, both verify;
  - revoke → `enabled = false`, row kept, verify refused;
  - update-limits → the new values are in the row and enforced at the next verify; out-of-bounds values are refused;
  - refused inputs: a budget without refill, out-of-bounds limits, any expiry flag, an existing service name;
  - the Sentry event is captured with no key material, and the script awaits the flush before exit; a failed flush prints the banner and exits non-zero, with the write kept;
  - per subcommand (`create-service`, `create-key`, `list`, `rotate`, `update-limits`, `revoke`): refuses without a database URL; refuses a mismatched `--confirm`; prints hostname and port only; logs the key id it acted on (where a key is involved);
  - each `SECRET_SCANNING_PATTERNS` entry matches a key freshly created for its service, and does not match a 63-letter tail, the other service's prefix or a 32-character session token;
  - output fields: `list` prints id, name, prefix, permissions, enabled, limits, created and last-request dates per key; `rotate` prints the new key once plus the old key's id; `revoke` prints the key id and `enabled = false`; none prints a key or a hash;
  - the service user's address and `service` row are created in one transaction (pglite, a forced failure leaves neither).

#### Acceptance Criteria

- [ ] The green command passes. A runnable harness, `apps/auth/scripts/probes/service-keys-demo.ts`, builds a pglite database from the journal, runs every subcommand in sequence and prints their outputs, so the documented output is checked by running it, not by reading it.

#### Test Plan

Script functions are tested directly, as `grant-admin.test.ts` tests its parser and actions. Sentry through the existing test transport.

### Phase 5: WhatsApp identity and session core

**Dependencies**: Phases 1 (schema, signJWT behaviour, lock probe) and 3 (address builders)

#### Objective

The exchange's whole decision as a library function in `packages/auth`, testable on pglite without HTTP: resolve or create the user, then, under the lock, check eligibility and ban, ~~update the phone number,~~ write the session and sign. *(superseded by phase 8: no phone number)*

#### Files to Create / Modify

- `packages/auth/src/whatsapp.ts` (new):
  - `resolveOrCreateWhatsappUser(db, bsuid, ~~phone~~)`: a fixed-provider lookup. With no row, one transaction: generate the UUID, insert the user (`whatsapp-<id>@noreply.askansari.ai`, `WhatsApp user`, `registered_via = 'whatsapp'`, `phone_number` when given) and the `whatsapp` account row. A unique violation on `(provider_id, account_id)` rolls back and re-reads the winner. Returns `{ userId, created }`. *(superseded by phase 8: no phone number)*
  - `issueWhatsappToken(auth, db, { userId, bsuid, ~~phone~~ })`: one transaction with `SET LOCAL lock_timeout` / `statement_timeout`. *(superseded by phase 8: no phone number)*
    1. `SELECT … FOR NO KEY UPDATE` on the user; gone → `UserGone`.
    2. Eligibility: the user's sole account row is `whatsapp` **with `account_id` equal to this request's BSUID** (so a row re-pointed between resolve and lock is caught), noreply address, `registered_via = 'whatsapp'`, role not admin; else `Ineligible`.
    3. `isBanned` → delete sessions, commit, `Banned`.
    4. ~~The phone number, updated when provided and different.~~ *(superseded by phase 8: no phone number)*
    5. `iat = now`, `exp = now + JWT lifetime`; reuse a session with `expiresAt ≥ exp + SESSION_MARGIN`, else delete the user's sessions and insert one directly. Every column is named: `token` from `generateRandomString(32, 'a-z', 'A-Z', '0-9')` (`better-auth/crypto`), `expiresAt` 30 days, `createdAt` and `updatedAt` (no database default for `updatedAt`), `ipAddress` `''` and `userAgent` `''` (better-auth's own values without a request), `userId`.
    6. Commit.
    7. **After the commit**, `auth.api.signJWT({ body: { payload: { sub, sid, iat, exp } } })` with the same `iat` and `exp`. Signing reads `jwks` on the pool; inside the transaction it would need a second connection and could starve the pool (probe 4). The invariant holds: at signing time the session outlives the token, because `expiresAt` was checked against this `exp` before the commit. A signing failure → 500; the session stays and is reused next time.

    Typed outcomes, not thrown strings.
- `packages/auth/src/limits.ts`: `SESSION_MARGIN`, `EXCHANGE_LOCK_TIMEOUT`, `EXCHANGE_STATEMENT_TIMEOUT`, `WHATSAPP_EXCHANGE_PER_USER`.
- `packages/auth/tests/whatsapp.test.ts` (new); rerun `apps/auth/scripts/probes/exchange-lock-probe.ts` against the real functions.

#### Deliverables

- [ ] Both functions, with typed outcomes.
- [ ] Tests (pglite):
  - new BSUID → one user (exact address), one account row, one session, ~~with `phone_number` stored when given~~; *(superseded by phase 8: no phone number)*
  - repeat → same `sub` and `sid`;
  - margin → replaced, old deleted;
  - ~~phone: updated when different, untouched when absent, only in its column (scan every row and column);~~ *(superseded by phase 8: no phone number)*
  - forced conflict on the unique constraint → one user, both callers get it;
  - a ban committed between resolve and lock → `Banned`, no session;
  - user deleted between resolve and lock → `UserGone`, no session;
  - eligibility matrix (a `whatsapp` row on an email, service or admin user; a promoted user; an altered address; an altered `registered_via`; the `whatsapp` row's `account_id` changed between resolve and lock) → `Ineligible`, no token;
  - an expired ban (`banExpires` in the past) is not refused;
  - claim-set equality with `/api/auth/token`, and `{sub, sid}` equal to `definePayload`'s output for the same session;
  - the session token is 32 characters from `[A-Za-z0-9]`, pinned, so a silent fallback to a weaker generator fails a test (it is a 30-day bearer credential);
  - `ipAddress` and `userAgent` are `''` and `updatedAt` is set, as a better-auth-written session;
  - a directly written session is accepted by the bearer plugin (`/api/auth/token` with its token) and by `/api/account/me`'s live-sid check;
  - the BSUID appears only in `account.account_id`.
- [ ] A source-level test: the eligibility re-read, ban check, ~~phone update~~ and session write sit inside the `FOR NO KEY UPDATE` transaction body; `signJWT` sits **after** it, and `consumeWindow` is not in it. *(superseded by phase 8: no phone number)*
- [ ] Probe 4 rerun against these functions on real Postgres; output in the review.

#### Acceptance Criteria

- [ ] The green command passes; probe 4 (including pool starvation) green on real Postgres under deadlines, rerun against these functions.

#### Test Plan

pglite with seams (a hook between resolve and lock) for the interleavings, real Postgres for the lock itself, and source-level for transaction scope. Each states what it proves, per the spec.

### Phase 6: The exchange route, boot assertion and alerts

**Dependencies**: Phases 1, 2, 4 and 5

#### Objective

`POST /api/whatsapp/session` on apps/auth, exactly to the spec's contract, plus the definite-answer boot assertion and the alerts.

#### Files to Create / Modify

- `apps/auth/src/routes/whatsapp.ts` (new): the router.
  1. Bearer → `verifyApiKey({ key, permissions: { whatsapp: ['mint'] } })`.
  2. On `valid: false`, `checkApiKeyRelation` (a query on `auth.apikey`, success cached for `APIKEY_RELATION_CHECK_TTL`) → 401 or 500. A missing or malformed bearer → 401 with no database query.
  3. `findServiceUser('whatsapp')`: not exactly one → 500 + alert; `referenceId` mismatch → 401.
  4. The route first checks `Content-Type` itself: anything but `application/json` → the exact 400. (body-parser 2.x skips an unsupported media type instead of raising, so the error handler alone would never see it, and an unparsed body is treated as 400 too.) Then route-local `express.json({ limit: EXCHANGE_BODY_LIMIT })`, followed by a route-local error handler. It maps the parser's errors (`entity.parse.failed`, `entity.too.large`, a wrong content type) to the exact 400 `{ "message": "Invalid request" }`, so no Express error page and no body fragment is ever sent. Sanity bounds → the same 400.
  5. `resolveOrCreateWhatsappUser`.
  6. `consumeWindow` on the pool, keyed `sub:<userId>|/api/whatsapp/session` → 429 with integer `X-Retry-After`.
  7. `issueWhatsappToken` → 200, 403 or 500; a lock timeout → 500.

  Every error logs `{name, code}` only. No response contains the bearer, BSUID, phone number or body.
- `apps/auth/src/app.ts`: mount `app.use(WHATSAPP_SESSION_PATH, whatsappRouter(…))` **before** `app.use(corsFor(…))`, with a comment on why. Mounting first is not enough by itself: a request the router does not answer would fall through to `corsFor`, which answers `OPTIONS` preflights. So **the router terminates every request to its path**: `POST` is the exchange; every other method, `OPTIONS` included, gets 404 with an empty body and no `Access-Control-*` header, and never calls `next()`.
- `apps/auth/src/boot.ts` (new) and `apps/auth/src/index.ts`: `assertSchema(db)` before `listen()`.
  - Query `auth.apikey`: `42P01` → refuse.
  - Catalog lookup for the constraint: empty → refuse.
  - Every refusal logs `{name, code}` only (the missing-constraint case included).
  - Any other error → log `{name, code}` and continue to `listen()`.
- `packages/auth/src/users.ts`: the stale "boot assertion" header line now names `assertSchema`.
- `apps/auth/src/alerts.ts`: per-key volume (per minute and per day), `USAGE_EXCEEDED` and `RATE_LIMITED` (one per window each), 401 volume, eligibility (count) and service user missing. Each carries counts, windows and hash prefixes only, the `alerts.ts` posture. The eligibility case also writes one `console.warn` with the user id (the apps/api "app row refused" precedent). The per-key minute and day counts come from the key row, as described under Limit sizing.
- `packages/auth/src/limits.ts`: `APIKEY_RELATION_CHECK_TTL`, `EXCHANGE_BODY_LIMIT`, `WHATSAPP_EXCHANGE_KEY_ALERT`, `WHATSAPP_EXCHANGE_DAILY_ALERT`, `EXCHANGE_UNAUTHORIZED_ALERT`.
- `apps/auth/src/alerts.ts` (where `Sentry.init` lives): a `beforeSend` scrub for the exchange path (no body, no `Authorization`).
- Tests: `apps/auth/tests/whatsapp-session.test.ts` (new), `apps/auth/tests/boot.test.ts` (new), `apps/auth/tests/public-face.test.ts` (route inventory).

#### Deliverables

- [ ] Route, mounting, boot assertion, alerts and Sentry scrub.
- [ ] Tests (HTTP through `startService`):
  - every key refusal → the byte-identical 401 (missing, non-Bearer, empty, session token, JWT, unknown, disabled, expired, exhausted, rate-limited, `mcp` only, no permissions, another service's `whatsapp: mint` key), and after each one the user, account and session row counts are unchanged;
  - delegation inputs over HTTP: an admin's and an email user's id and email, and a `google` user's `account_id`, passed as `bsuid` → each creates a new WhatsApp user, never the seeded one;
  - an expired ban is let through;
  - the `rate_limit` row's key contains the user id and neither the BSUID nor the phone number;
  - malformed JSON, a `text/plain` body, a missing `Content-Type` and an over-limit body → the exact 400 body, with no HTML and no body fragment;
  - the exhaustive body cases from the spec (non-JSON, oversized, `bsuid` missing, non-string, empty, over 256 characters, with whitespace, with a control character; ~~`phone_number` non-string, empty, over 32 characters, non-digits~~ (phase 8: every `phone_number` shape → 200, ignored)) → 400; a sane but unusual `bsuid` is accepted;
  - a missing or malformed bearer → 401 with **zero** database queries (a query-counting `Db` wrapper);
  - `UserGone` (user deleted between resolve and lock) → 500 over HTTP, with no session row;
  - a JWT issued before a ban fails `GET /api/account/me` after the ban;
  - Sentry events from the exchange contain no phone number;
  - each alert fires once per window, not per request;
  - `GET`, `PUT` and `OPTIONS` on the path → 404 with no `Access-Control-*` header;
  - service user missing → 500 + alert;
  - body cases → 400 after a valid key; a body with no key is never parsed (spy);
  - happy path, repeat, 403 banned, 429 with integer `X-Retry-After`;
  - the counter survives a 403 and a 500;
  - another user is unaffected;
  - a lock held from another connection → 500 within the timeout;
  - CORS: no `Access-Control-*` on `POST` or `OPTIONS` for each `CORS_ORIGIN`, `null`, `https://evil.example` and no `Origin`; a middleware-order test pins the mount before `corsFor`;
  - not reachable under `/api/auth/*`;
  - `auth.apikey` dropped under the running service → 500 after the TTL elapses;
  - log capture across all cases: no raw key, hash, session token, BSUID, phone number or driver error;
  - a captured Sentry event has no body or `Authorization`;
  - raw response bytes contain none of the request's sensitive values;
  - alerts fire at their thresholds with counts only.
- [ ] Boot tests:
  - `42P01` → refuses to start with a `{name, code}` log;
  - constraint missing → refuses;
  - database unreachable → starts, `/health` reports down, and recovers when the database returns.
- [ ] Production-shaped run (manual, recorded in the review): apps/auth with `NODE_ENV=production` against the Postgres 18 container; stop the container under the running service; after `APIKEY_RELATION_CHECK_TTL`, a valid key and an unknown key both get 500; restart the container and the exchange recovers.

#### Acceptance Criteria

- [ ] All suites pass. The public-face route inventory lists the new path. `ROUTER_RULES` are unchanged (all `false`).
- [ ] The production-shaped run shows 500, never 401, after the TTL, and recovery.

#### Test Plan

HTTP integration against `startService` on pglite. Real Postgres for the outage and the lock timeout. Log, Sentry and response-byte capture as the spec requires.

### Phase 7: End-to-end contract test, source scan and documentation

**Dependencies**: Phase 6

#### Objective

Prove an exchange token works in apps/api unchanged, prove apps/api has no WhatsApp code, and give the operator and the consumer everything they need.

#### Files to Create / Modify

- `apps/api/tests/contract/whatsapp-exchange.test.ts` (new): start apps/auth through the existing harness, seed a service user and key, exchange a BSUID, and call an apps/api route with the token. `requireUser` passes, first-use `GET /api/account/me` runs, and a `public.users` row exists under the same UUID with `registered_via = 'whatsapp'`. The phone number is in no apps/api row or response.
- `apps/api/tests/auth/resolve-user.test.ts`: one test pinning that apps/api's first-use refusal covers only the system domain. A `whatsapp-<id>@noreply.askansari.ai` profile from `/me` is accepted and its app row created. WhatsApp users must pass it, so a future tightening of `resolve-user.ts` would otherwise break WhatsApp with no failing test.
- `apps/api/tests/source-scan/` (existing scan module): a `whatsapp` scan over `apps/api/src/**` and `apps/api/lib/**` (tests excluded) that reports its hit count (0). Its negative tests: a known-bad fixture line under the scanned glob is caught, and a near miss outside it is not.
- `docs/self-hosting.md`: the route, the scripts, `limits.ts` bounds, the migration-before-code order.
- `docs/cutover/service-keys-runbook.md` (new):
  - issuance;
  - the handoff (straight into the consumer's Railway variable);
  - rotation overlap and the doubled ceiling;
  - revocation;
  - pruning (none expected);
  - the limit values, their judgement-based reasoning, and how to change them (`update-limits`, or revoke-and-recreate);
  - the pre-apply duplicate check for `(provider_id, account_id)`, with the ACCESS EXCLUSIVE lock note and quiet-window guidance;
  - the alert meanings, and the eligibility repair procedure;
  - the key log: where the operator records key id and action when a script's Sentry flush fails;
  - scheduled rotation every 6 months per key, owned by the operator, with the rotate, switch, revoke steps;
  - secret scanning: the owner registers each `SECRET_SCANNING_PATTERNS` entry as a GitHub organisation custom pattern (Settings → Code security → Secret scanning → Custom patterns), and the runbook says what to do when one fires (revoke at once, rotate, check the alerts for use).

  The runbook must not contain a bare `auth-journal-applied:` line outside backticks: the parity test scans `docs/**` for that record.
- `codev/resources/arch.md` (Authentication & Authorization): that apps/api's first-use refusal covers only the system domain, and why WhatsApp users depend on it; service keys, the exchange, the noreply domain, and the alert posture.
- `packages/auth/README.md`: the `apikey` table and migration `0001`.
- Coordination (outside this repo's diff): the contract summary, sent to the #327 builder through the architect, with the spec 321 amendment on their branch: header, `phone_number`, error statuses, no per-message retry on 500, re-exchange once on an apps/api 401, and the staging smoke (5 messages within 1 s) recorded as a comment on PR #327.

#### Deliverables

- [ ] The end-to-end test, the source scan with its negative tests, and the four documents.
- [ ] The contract summary sent.

#### Acceptance Criteria

- [ ] All suites pass, the root `turbo run test` included; the scan reports 0 hits plus its two negative results.
- [ ] Documentation consistency tests (`self-hosting-docs.test.ts`, `cutover-docs.test.ts`) pass or are extended for the new content.
- [ ] No new environment variable (checked by the four-way derivation); `turbo.json` is unchanged.

#### Test Plan

The contract test through the existing harness; scan negative tests; doc consistency tests.

### Phase 8: Remove the phone number (owner amendment 2)

**Dependencies**: Phase 7 (the shipped exchange, tests and docs, which this phase changes in place)

#### Objective

Implement spec §5, owner amendment 2: no phone number is stored anywhere. The exchange accepts `phone_number` and ignores it, so the merged #327 keeps working. Migration `0001` loses `auth.users.phone_number`, in place. Identity, eligibility and the delegation rule are unchanged, because they were always BSUID-only.

#### Step 1: confirm `0001` is applied nowhere (T12)

Before editing `0001`, read staging's auth database: `select to_regclass('auth.apikey')` and whether `auth.users` has a `phone_number` column, through the operator, read-only.
- Absent everywhere (expected, since the owner says `0001` has not run): `0001` changes in place.
- Present anywhere: stop. `0001` stays as it is, and a new `0002` drops the column. That decision is named here so it is not made under deploy pressure.

The result goes in the review.

#### Files to Create / Modify

**Schema and migration**
- `packages/auth/src/schema.ts`: remove `phoneNumber` from `users`.
- `packages/auth/drizzle/0001_*`: regenerated in place with `drizzle-kit generate --name api_key`, after removing the old `0001` and its snapshot from the journal. The tag becomes `0001_api_key`, since the old name would mislead. The SQL is reviewed again; `AUTH_DEPLOYED_THROUGH` stays `null`. Every reference to the old tag is updated in the same commit: the journal tests, the copy and auth-journal tests, the cutover, runbook and self-hosting docs, and the README.
- `packages/auth/tests/schema/auth-schema.test.ts` and `tests/migration/auth-journal-parity.test.ts`: `auth.users` has no `phone_number`.
- `packages/auth/tests/schema/better-auth-model.test.ts` (new, the owner's compatibility ask): `getAuthTables(createAuth(…).options)` against the journal-built database. Every model and field better-auth expects exists, with a compatible type and nullability. One deviation is allowed and commented: `apikey.reference_id` is `uuid` with a foreign key, where the model says string. Negative control: a column dropped from the test database turns it red.

**Better Auth config**
- `packages/auth/src/index.ts`: remove the `phone_number` additional field.
- `packages/auth/tests/config/api-key.test.ts` and `options.test.ts`: the probe 4a pins of `phone_number` (refused at sign-up; absent from sign-in and get-session) are removed. A test that sign-up with a `phone_number` field writes no such value replaces them, since better-auth's own unknown-field handling then applies.

**The exchange**
- `packages/auth/src/whatsapp.ts`: `resolveOrCreateWhatsappUser` and `issueWhatsappToken` take no phone. The create path writes none, and the phone update under the lock is removed. The source-level placement assertion loses "the phone update".
- `apps/auth/src/routes/whatsapp.ts`: `exchangeBody` reads `bsuid` only. `phone_number` is accepted in any shape (no bound, no 400) and never read further. `EXCHANGE_BODY_LIMIT` keeps room for it: the field may still arrive, in any shape, until #327 stops sending it.
- `packages/auth/src/limits.ts`, `reserved.ts` and `apps/auth/src/alerts.ts`: comments that name the phone number are kept where it stays a needle, such as "never logged", and the rest removed.

**Tests**
- `packages/auth/tests/whatsapp.test.ts` and `apps/auth/tests/whatsapp-session.test.ts`:
  - the phone storage, update and "untouched when absent" tests are removed;
  - the body tests turn the `phone_number` 400 cases into **200 accepted-and-ignored** cases (a number, a string, `null`, empty, 33 characters, non-digits);
  - a new test sends a distinctive number, then scans every column of every table in the `auth` schema (`information_schema.columns`, cast to text) and finds it in no row;
  - the needles stay: the never-log capture, the Sentry scrub test, and the raw-response-bytes assertion all still include the number.
- `apps/auth/tests/whatsapp-session-sentry.test.ts`: the number stays a needle.
- `apps/api/tests/contract/whatsapp-exchange.test.ts`: the exchange still sends a number. The app-database dump still finds no number, and the auth side's all-tables scan joins it.
- A source-level check: no file in `packages/auth/src` or `apps/auth/src` reads `phone_number`, beyond the route's documented "accepted and ignored" line. Its negative test: a planted read is caught.

**Probes**
- `packages/auth/scripts/probes/library-probes.ts` and `exchange-lock-probe.ts`: the 4a phone probe and the phone parts of F1–F4 are removed. Their earlier outputs stay in the review as the record.
- `packages/auth/scripts/probes/phone-plugin-probe.ts`: not committed as code. Its output and the security architect's T1–T20 go in the review as the record of why amendment 1 was withdrawn.

**Docs**
- `docs/cutover/service-keys-runbook.md`, `docs/self-hosting.md`, `codev/resources/arch.md` and `packages/auth/README.md`: the phone column and its storage rules are removed. The contract reads "`phone_number` accepted and ignored", and the never-log lists keep the number.
- The new tag `0001_api_key` everywhere the old one was named.
- Coordination: none from this builder. The security architect asks #327's author, through the community architect, to stop sending the field, and a later PR removes it from the contract.

#### Deliverables

- [ ] Step 1 recorded (staging read), and `0001` regenerated in place as `0001_api_key` with no `phone_number`.
- [ ] The better-auth model test, with its one documented deviation and a negative control.
- [ ] The exchange accepts and ignores `phone_number`; the all-tables scan, the needles and the source check.
- [ ] Phone tests, probes and docs removed or updated; the old tag renamed everywhere.

#### Acceptance Criteria (spec §5)

- [ ] `0001` creates no `phone_number`; the schema, journal-parity and model tests agree.
- [ ] Every shape of `phone_number` → 200, and afterwards the all-tables scan finds it in no row; no response, log line or Sentry event carries it.
- [ ] The source check reports no read of `phone_number` beyond the route's accept line; its planted negative goes red.
- [ ] All suites green, typecheck and lint clean; no new environment variable; the doc tests updated for the new tag.

#### Test Plan

pglite for the exchange and the all-tables scan; the model test against the journal-built database, with a dropped-column negative control; the existing capture and Sentry tests with the number kept as a needle; apps/api's contract test end to end; doc tests for the renamed tag. Mutation checks: storing the number again turns the scan red, and a 400 on an odd `phone_number` turns the accept tests red.

## Criterion → owning phase → test

Each spec success criterion has exactly one acceptance owner. An earlier probe may pre-test it, but the owner's test is the one that must stay green.

| Spec criterion (short) | Owner | Test |
|---|---|---|
| Plugin pinned to 1.7.7, core not bumped | 1 | `packages/auth/tests/config/api-key.test.ts` (version read from the lockfile) |
| `apikey` table shape; `0001` with the constraint and `phone_number` | 1 | `tests/schema/auth-schema.test.ts`, `tests/migration/auth-journal-parity.test.ts` |
| Boot refuses on `42P01` or a missing constraint; starts when the database is unreachable | 6 | `apps/auth/tests/boot.test.ts` |
| Blocked list derived, 7 endpoints / 5 routed, finite variant list | 1 | `apps/auth/tests/blocked-paths.test.ts` |
| `enableSessionForAPIKeys` false: no session or token from a key | 1 | `tests/config/api-key.test.ts` |
| Key row: raw key absent, `start` null, hash equality | 1 | `tests/config/api-key.test.ts` (probe 1) |
| Create prints the key once; list, rotate and revoke output fields | 4 | `apps/auth/tests/service-keys.test.ts` |
| Every subcommand: URL refusal, confirm, hostname and port only, key id logged | 4 | `service-keys.test.ts` (per subcommand) |
| Create refuses a budget without refill, out-of-bounds limits, expiry | 4 | `service-keys.test.ts` |
| Service user and `service` row in one transaction; duplicate refused | 4 | `service-keys.test.ts` |
| Rotate: two live keys; revoke disables and keeps | 4 | `service-keys.test.ts` |
| Script Sentry events, no key material; flush failure banner and exit code | 4 | `service-keys.test.ts` |
| Secret-scanning patterns match real keys and reject near misses | 4 | `service-keys.test.ts` |
| Runbook covers scheduled rotation and secret scanning | 7 | review of `docs/cutover/service-keys-runbook.md` |
| Refilled exhaustion refuses and keeps, then verifies after the interval | 1 | `tests/config/api-key.test.ts` |
| `grant-admin.ts` refuses noreply | 3 | `apps/auth/tests/grant-admin.test.ts` |
| Every key refusal → identical 401, no rows | 6 | `apps/auth/tests/whatsapp-session.test.ts` |
| Missing or malformed bearer → 401 with zero database queries | 6 | `whatsapp-session.test.ts` |
| `auth.apikey` dropped / database stopped → 500 after the TTL | 6 | `whatsapp-session.test.ts` (dropped); production-shaped run in the review (stopped) |
| Service user missing → 500 + alert | 6 | `whatsapp-session.test.ts` |
| User deleted mid-exchange → 500 | 5 (library), 6 (HTTP) | `packages/auth/tests/whatsapp.test.ts`; `whatsapp-session.test.ts` owns the HTTP 500 |
| New BSUID: user, account, session, exact address, verifiable JWT | 5 | `whatsapp.test.ts` |
| Same BSUID twice → same `sub` and `sid` | 5 | `whatsapp.test.ts` |
| Session ≥ `exp` + `SESSION_MARGIN`, else replaced | 5 | `whatsapp.test.ts` |
| Claim-set equality with `/token`; `definePayload` agreement | 5 | `whatsapp.test.ts` |
| Eligibility matrix → 500 + alert, never a token | 5 (library), 6 (alert) | `whatsapp.test.ts`; `whatsapp-session.test.ts` owns the alert |
| Delegation inputs are unknown BSUIDs | 6 | `whatsapp-session.test.ts` |
| Ban → 403, sessions deleted, pre-ban JWT fails `/me`; expired ban passes | 6 | `whatsapp-session.test.ts` |
| Per-user 429 with integer `X-Retry-After`; counter survives refusals; `rate_limit` key holds the user id | 6 | `whatsapp-session.test.ts` |
| Lock timeout → 500, not a hang | 6 | `whatsapp-session.test.ts`, plus probe 4 |
| Concurrency (conflict, ban under the lock, source-level scope) | 5 | `whatsapp.test.ts`, plus probe 4 |
| Exhaustive body cases → 400; content type | 6 | `whatsapp-session.test.ts` |
| BSUID only in `account.account_id`; phone only in its column | 5 | `whatsapp.test.ts` (row scan) |
| `phone_number` refused as input, never returned | 1 | `tests/config/api-key.test.ts` (probe 4a) |
| Logs carry no secret, BSUID, phone or driver error | 6 | `whatsapp-session.test.ts` (capture across all cases) |
| Logger: redacted, not silenced; near misses survive | 2 | `packages/auth/tests/unit/logger.test.ts` |
| Sentry from the exchange: no body, `Authorization` or phone | 6 | `whatsapp-session.test.ts` |
| No response contains sensitive input | 6 | `whatsapp-session.test.ts` |
| No CORS for the four Origin cases; mounted before `corsFor` | 6 | `whatsapp-session.test.ts` |
| Alerts at thresholds, once per window, counts only | 6 | `whatsapp-session.test.ts`, plus the clock-advance daily test |
| Reserved domain: sign-up 409, near misses, reset, hook, sign-in | 3 | `tests/config/sign-up.test.ts`, `apps/auth/tests/reset.test.ts` |
| `isSystemAddress` unchanged | 3 | existing tests, unedited |
| End to end through apps/api `requireUser` | 7 | `apps/api/tests/contract/whatsapp-exchange.test.ts` |
| apps/api first-use refusal is system-only | 7 | `apps/api/tests/auth/resolve-user.test.ts` |
| No WhatsApp code in apps/api (scan, negative tests, count) | 7 | `apps/api/tests/source-scan/` |
| Staging smoke | 7 (coordination) | comment on PR #327 by its builder |
| Documentation | 7 | `self-hosting-docs.test.ts`, `cutover-docs.test.ts`, review |
| `ROUTER_RULES` unchanged; no new env var | 6, 7 | `public-face.test.ts`; four-way derivation in the review |
| Amendment 2: no `phone_number` column in `0001`; schema matches better-auth's model | 8 | `auth-schema.test.ts`, `auth-journal-parity.test.ts`, `better-auth-model.test.ts` |
| Amendment 2: `phone_number` accepted and ignored; in no row, response, log or Sentry event | 8 | `whatsapp-session.test.ts` (body cases, all-tables scan), capture and Sentry tests, `whatsapp-exchange.test.ts` |
| Amendment 2: no code reads `phone_number` | 8 | source-level check with a planted negative |
| Amendment 2: `0001` applied nowhere (T12) | 8 | staging read recorded in the review |

## Risks and Mitigation

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| A probe contradicts the spec (e.g. `signJWT` overrides `exp`, `returned: false` leaks through an adapter path, the lock pattern waits) | Medium | High | Phase 1 runs every probe first; any difference stops the plan and goes to the security architect before phase 5 |
| Migration numbering collides with another branch | Medium | High | Message `architect:main` before committing the journal |
| Signing inside the transaction starves the shared pool | Low (designed out) | High | Sign after commit; explicit pool `max` and connect timeout; the pool-starvation probe reproduces the hang with signing inside, and passes with it outside |
| The session token generator silently weakens | Low | High | The generator comes from the public `better-auth/crypto`; length and alphabet pinned by a test |
| The lockfile has two `better-call` copies (zod peer variants) | Low | Low | Harmless here: the exchange maps every `valid: false` to 401 and classifies outages by the relation check, not by error class identity |
| The judgement-based values prove too low or too high | Medium | Low | Alerts at one third of the caps, so a surge is seen first; `update-limits` changes a key's values without code; bounds are wide, so a raise needs no bound change |
| The logger change alters an existing test's expectations | Low | Low | Its own commit; affected tests listed in the commit message |
| Real-Postgres steps are manual, so they can be skipped | Medium | High | Their output is a review deliverable for phases 1, 5 and 6; the plan's acceptance criteria name them |
| Other work on `develop` reshapes `index.ts`, `app.ts` or `limits.ts` | Medium | Low | Tests pin behaviour, not line positions |
| The plugin's 7/5 shape changes on a future bump | Low | Medium | Both counts asserted; the prefix rule covers any new routed path anyway |

## Documentation Updates

- `docs/self-hosting.md`, `docs/cutover/service-keys-runbook.md` (new), `codev/resources/arch.md` (Authentication & Authorization), `packages/auth/README.md`.
- `codev/resources/lessons-learned.md`, at review time: plugin behaviours (deletion on no-refill exhaustion, outage reported as `INVALID_API_KEY`, `signJWT` without `iat`), and the `FOR UPDATE` versus `KEY SHARE` hazard.
- Spec 321's amendment lands on PR #327's branch, coordinated with its builder.
