# Review: Service API keys and the WhatsApp token exchange (spec 329)

## Summary

apps/auth gains service identity through `@better-auth/api-key` (pinned to core 1.7.7): a service is one credential-less auth user, its keys are issued only by `apps/auth/scripts/service-keys.ts`, and the plugin's HTTP surface is blocked. Phase 6 adds `POST /api/whatsapp/session`, which turns a `whatsapp: mint` key and a BSUID into the ordinary EdDSA `{sub, sid}` JWT, only ever for a WhatsApp user. A second reserved domain, `@noreply.askansari.ai`, is refused on every public path. Eight phases: phases 1 to 7 were approved by Codex, and phase 8's recorded verdict is COMMENT, which porch counts as approval (Codex's one point was this document's stale summary, since fixed). The Gemini lane was skipped in every round. Phase 8 implements owner amendment 2 (2026-10-30): no phone number is stored anywhere, and a `phone_number` the WhatsApp service sends is accepted and ignored. Amendment 1 (better-auth's phone-number plugin and claiming accounts by number) was withdrawn before being built; the record is in the appendix. The end-to-end test shows an exchange token passing apps/api's `requireUser` unchanged, and apps/api gains no WhatsApp code. Two items stay open, neither of which this PR can close: applying migration `0001` to staging before the merge (owner decision, 2026-10-28; production gets the whole auth journal at its cutover), and the staging smoke, which #327's builder runs.

## Spec Compliance

Owner phase per the plan's criterion table. Where the plan named a test, that test is green; the evidence for the real-Postgres criteria is in the appendix.

**Service keys and scripts**
- [x] Plugin pinned to exactly 1.7.7; core not bumped (Phase 1)
- [x] `apikey` table in the `auth` schema; migration `0001_api_key` with `unique(provider_id, account_id)` and no phone column (regenerated in place by phase 8; it was applied nowhere), generated and reviewed as SQL; schema, journal-parity and better-auth model tests (Phases 1 and 8). `0001` is applied to staging before the merge; `AUTH_DEPLOYED_THROUGH` stays `null` until main sets it at the production cutover (see Follow-up).
- [x] Boot refuses on `42P01` or a missing constraint, bound to `auth.account` and the exact column order (Phase 6, tightened in review iteration 1)
- [x] Database unreachable at boot → starts, `/health` 503, recovers without a restart (Phase 6; production-shaped run, steps 4 to 5a)
- [x] Blocked list derived from `apiKey().endpoints` (7 endpoints, 5 routed), the full variant list, `/verify` and `/delete-all-expired-api-keys` covered by the prefix; the prefix proven load-bearing (Phase 1)
- [x] `enableSessionForAPIKeys` false: no session or token from a key, as `x-api-key` or as a bearer (Phase 1)
- [x] Key row: the raw key in no column, `start` null, `key` = `defaultKeyHasher(raw)` (Phase 1)
- [x] Create prints the key once; list, rotate and revoke print no key or hash (Phase 4)
- [x] Every subcommand: URL required, `--confirm <id>`, host and port printed before connecting, key id logged; the URL leak test (Phase 4)
- [x] Create refuses a budget without refill, a missing rate limit, out-of-bounds values and any expiry (Phase 4)
- [x] `create-service` writes the user and its `service` row in one transaction and refuses a duplicate name (Phase 4)
- [x] Rotate leaves two live keys; revoke sets `enabled = false`, keeps the row, and the key then gets the 401 (Phase 4, Phase 6)
- [x] Sentry event per write with no key material; a failed flush keeps the write, prints the banner and exits 3 (Phase 4; breadcrumb leak found and closed in review iteration 2)
- [x] Refilled exhaustion refuses and keeps the key, then verifies after the interval (Phase 1)
- [x] `grant-admin.ts` never grants to a noreply address, as for the system domain; `--revoke` stays allowed (the repair for a promoted WhatsApp user), pinned in the PR review (Phase 3, PR review iteration 1)

**Exchange: key refusals**
- [x] Every listed key state answers the identical 401 and creates no row: no header (zero queries), non-Bearer, empty, a session token, a JWT, unknown, revoked, expired, exhausted, rate-limited, `mcp: complete`, no permissions, mis-owned (Phase 6)

**Exchange: failures that are not 401**
- [x] `auth.apikey` dropped under a running service → 500 for both keys after `APIKEY_RELATION_CHECK_TTL` (Phase 6)
- [x] Database stopped under a production-mode service → 500 after the TTL; 401 inside it is the stated residual (Phase 6; real Postgres run, 3b to 3d)
- [x] Missing or malformed bearer → 401 with zero counted queries (Phase 6)
- [x] Service user missing → 500 plus an alert (Phase 6)
- [x] User deleted between lookup and lock → 500, no session, no token (Phase 5 library, Phase 6 HTTP)

**Exchange: identity and delegation**
- [x] New BSUID → one user at `whatsapp-<sub>@noreply.askansari.ai`, one `whatsapp` row, one session, a JWT that verifies against JWKS (Phase 5)
- [x] Same BSUID twice → same `sub` and `sid`, one session (Phase 5)
- [x] Session `expiresAt` ≥ `exp` + `SESSION_MARGIN`, else replaced (Phase 5)
- [x] Claim-set equality with `/api/auth/token` (keys, `alg`, `kid`, `iss`, `aud`, lifetime) and agreement with `definePayload` (Phase 5; `kid` added in review iteration 1)
- [x] Eligibility matrix (email user, service user, admin, promoted, address or `registered_via` changed, plus a re-pointed row) → 500 and an alert, never a token (Phase 5, Phase 6)
- [x] An admin's or email user's id or email, or a `google` `account_id`, passed as `bsuid` is an unknown BSUID (Phase 6)
- [x] Ban → 403, sessions deleted, a pre-ban JWT fails `/me`; an expired ban passes (Phase 6)
- [x] Per-user 429 with integer `X-Retry-After`; another user unaffected; the `rate_limit` key holds the user id (Phase 6)
- [x] The counter still counts a request refused with 403 or 500 (Phase 6)
- [x] `lock_timeout` and `statement_timeout` from `limits.ts`; a row lock held from another connection → 500 at 2027 ms (Phase 6, real Postgres)
- [x] Concurrency: a forced unique conflict yields one user; a ban between lookup and lock is seen under the lock; the source-level placement assertion; probe 4 F1 to F4 on real Postgres (Phase 5)

**Exchange: privacy, logging, transport**
- [x] BSUID only in `account.account_id` (Phase 5)
- [x] **Amendment 2: no phone number stored anywhere.** `phone_number` in seven shapes → 200, and an all-tables scan of `auth` finds none of them; the end-to-end test scans the auth side too; a source check finds no code reading it; a sign-up carrying it leaves it in no row (Phase 8)
- [x] `auth.users` has no `phone_number` column, and the schema matches better-auth's own model of the configured auth, with one documented deviation (`apikey.reference_id` uuid with a foreign key) (Phase 8)
- [x] No raw key, hash, session token, BSUID, phone or driver error in any captured log (Phase 6)
- [x] Logger redacts to `{name, code}`, is not silenced, near misses survive (Phase 2)
- [x] Exchange Sentry events carry no body, `Authorization` or phone, with a negative control (Phase 6)
- [x] No response echoes the bearer, BSUID, phone or body (Phase 6)
- [x] No `Access-Control-*` header for the four Origin cases, POST and OPTIONS; mounted before `corsFor` (Phase 6)
- [x] Over-limit body → 400 after the key; an unkeyed body is never parsed (Phase 6)

**Alerts**
- [x] Per-key volume, `USAGE_EXCEEDED` / `RATE_LIMITED`, 401 volume, ineligible user (with the server log line) and unresolvable service user; thresholds are named `limits.ts` constants at one third of the caps (Phase 6)

**Reserved domain**
- [x] Sign-up: noreply and taken answer identically, 409 unpadded and 400 padded (Phase 3; the spec text was amended, see Deviations)
- [x] Near misses sign up normally (Phase 3)
- [x] Reset for a noreply user answers as an unknown address, and the mailer is never called (Phase 3)
- [x] `user.create.before` refuses both reserved domains on every Better Auth path (Phase 3)
- [x] Sign-in with a noreply address answers as an unknown one (Phase 3)
- [x] `isSystemAddress` and `SYSTEM_EMAIL_DOMAIN` unchanged; their tests unedited (Phase 3)

**End to end**
- [x] Exchange JWT passes `requireUser`: JWKS, first-use `/me`, `public.users` row with `registered_via = 'whatsapp'` (Phase 7)
- [x] Source scan 5: 0 hits in 65 files, a known-bad line caught, near misses outside the glob not caught, a planted file goes red (Phase 7)
- [ ] Staging smoke: not run yet. It is #327's builder's to run against staging with a script-issued key, and to record on PR #327. The spec makes it a pre-production gate, not a merge gate for this PR.

**Documentation**
- [x] `docs/self-hosting.md`: route, scripts, `limits.ts` bounds with their ranges, migration before code (Phase 7)
- [x] Runbook: issuance, handoff, rotation overlap, revocation, budget sizing, the duplicate pre-check and lock warning for `0001`, alert meanings, scheduled rotation, secret scanning, eligibility repair, key log (Phase 7)
- [x] Secret-scanning patterns tested against real keys and near misses (Phase 4), and the runbook's table equals the code's patterns (Phase 7)
- [x] `arch.md` Authentication & Authorization describes keys, the exchange, the noreply domain and the alert posture (Phase 7)

**Unchanged**
- [x] `ROUTER_RULES` all `false`, pinned (Phase 6)
- [x] Existing tests pass. Edited only where the spec allows (blocked paths, schema, reserved check, log output), plus one change the spec did not foresee: a 100 s hook deadline in `apps/auth/tests/secrets.test.ts` and `apps/auth/tests/cutover/copy.test.ts`, so they finish under machine load (see Flaky Tests; no assertion changed).
- [x] No new environment variable (four-way derivation, Phase 7); `turbo.json` unchanged.

## Deviations from Plan

- **Phase 1:** the probe scripts live in `packages/auth/scripts/probes/`, not `apps/auth/scripts/probes/`, because apps/auth has no direct `pg` / `drizzle-orm` dependency. `probe-db.ts` holds the setup they share.
- **Phase 2:** the two spec 300 setup hooks got a 100 s deadline (a `chore(test)` commit). They kept timing out the plan's green command on the shared machine. The security architect said fix them, don't skip them.
- **Phase 3:** the spec said a padded noreply sign-up gets 409. `signUpGuard` validates first (the frozen legacy order), so every padded address gets 400. The code was left alone and the spec text amended. The property the criterion protects, no oracle, holds.
- **Phase 4 (choices inside the plan):** `create-service` confirms with the service name, since no user exists yet. `update-limits` resets `remaining` to the new budget. `create-service` also sends a Sentry event. The exit codes are 0, 1, 2 and 3. The script has its own Sentry options and prints through `process.stdout.write` (from review iteration 2). The plan's URL leak test was narrowed, because the script's own text contains the word "user". `ansari-mcp` borrows `WHATSAPP_KEY_BOUNDS` until #314.
- **Phase 5:** eligibility requires the exact address `whatsapp-<id>@noreply.askansari.ai`, which is stricter than any address under the domain. Lifetimes moved to `src/lifetimes.ts`. Signing after the commit is the approved plan (plan iteration 2, P1). The spec's §2 sentence that put signing inside the transaction was amended to match.
- **Phase 6:** there is one constant beyond the plan's list, `EXCHANGE_ALERT_WINDOW`. The catalog lookup `hasAuthUniqueConstraint` lives in packages/auth, because apps/auth has no `drizzle-orm`. The window alert is deduplicated by the time since it last fired, because the plugin's window resets after a gap rather than on a fixed clock.
- **Phase 7:** the key log is a table at the end of the runbook; the spec named it and the plan did not place it.
- **Review phase (security architect, superseded by phase 8):** an explicit `"phone_number": null` was accepted as absent (200, a stored number untouched) instead of 400. The contract calls the field optional, and JSON clients commonly send `null` for an absent field. Phase 8 goes further: every shape is accepted and ignored. It deleted the six `phone_number` 400 cases and this `null` case, and replaced them with accept-and-ignore tests over every shape, each followed by an all-tables scan.
- **Review phase (gitleaks):** the probes' invented placeholder secrets are gone. `setProbeEnv` now calls `setAuthEnv` and overrides only `DATABASE_URL`, so the probes print the test issuer and audience (`auth.test.example`, `ansari-api-test`), not the `probe` ones shown in the appendix's earlier runs. The two literals stay in branch history, so `.gitleaks.toml` allowlists them as adjudicated fixtures (the run is under "Secret scan (gitleaks)" below).

- **Review phase (security architect, PR-gate pass 2):** **service-wide, Sentry keeps no breadcrumbs.** `SERVICE_SENTRY_OPTIONS` now sets `maxBreadcrumbs: 0` and `beforeBreadcrumb: () => null` for all of apps/auth, not only the exchange. Nothing relies on breadcrumbs, and the ineligible-user log line (a user id) otherwise rode on the alert as a console breadcrumb. Per-key alerts carry the key id (`keyId`, as `list` prints it) instead of an 8-character hash prefix: a key id names a credential, not a person. The fire-once alerts lose their count fields (always 1 or the threshold), and the runbook says they mark the first occurrence in the window. `hashPrefix` was removed as unused.

- **Review phase (security architect, PR-gate pass 1):** eligibility now requires the role to be **exactly `user`**, an allowlist. Before, it refused only `admin`, which missed `user,admin` (which better-auth's admin plugin reads as admin) and unknown roles. The reason is renamed from `admin` to `role` in code, the runbook and the doc test. `update-limits` and `revoke` now confirm with the **key's** id, not the service user's. `--name` and `--client-id` are restricted to an inert charset (1 to 64 characters) with key-shaped values refused. With no `SENTRY_DSN`, the script takes the unrecorded path on purpose, through an explicit `unrecordedRecorder`.

- **Owner amendments 1 and 2 (2026-10-30):** amendment 1 (the phone-number plugin and claiming accounts by number) was folded into the spec, planned as phase 8 and reviewed, then withdrawn by the owner before any of it was built. Amendment 2 ("drop phone number entirely, whatsapp id is enough") replaced it: phase 8 removed the phone number, reversing owner decision D3. Porch was rolled back from review to plan for this.
- **Phase 8 (choices inside the plan):** the migration was regenerated in place under a new tag, `0001_api_key`, since the old name would mislead (agreed with the security architect, main informed). Step 1 (T12, `0001` applied nowhere) rests on the owner's written record; the two read-only queries were not run, because the apply step never ran.
- **Porch re-walk:** the rollback reset every plan phase. Phases 1 to 7 were re-walked by replaying their recorded reviews, with no code change and no new consult (appendix).

- **Merge of develop with #334 (2026-10-29):** the exchange's Sentry scrub is now #334's `scrubRequestEvent`, applied to every request. An exchange event keeps its method, path and the `host`, `user-agent` and `content-type` headers, where the exchange-only scrub kept method and path. None of those headers carries a key, BSUID or phone number. The phase 6 notes below describe the exchange-only scrub as it was then.

### Accepted residuals

- **The eligibility read of account rows is not serialized against a concurrent insert of a second account row for the same user** (security architect, review phase). An account insert takes `KEY SHARE` on its user row, which `FOR NO KEY UPDATE` does not block, so a second row committed during the exchange's transaction is not seen by that exchange. No Better Auth path can create an account row for a noreply user (the create hook and every public path refuse the domain), so only an operator can write one. The next exchange reads it under the lock and refuses with `ineligible: accounts`, raising the alert, so the window is one exchange and its token (at most 15 minutes, `{sub, sid}` only, carrying no authority beyond that WhatsApp user's own).

## Consultation Feedback

In every round the Gemini lane returned `COMMENT` with "lane skipped — agy exited with code 3". It has no content, is non-blocking, and is not repeated below. No `CONSULT_ERROR`.

### Specify (Round 1)

#### Codex (REQUEST_CHANGES)
- **Concern**: open questions change the requirements → **Addressed** in part: throttle statuses, ban status, check order, image guard, `start` storage resolved. **N/A**: domain, BSUID storage, limits and leaderboard timing are the owner's, answered at the gate (D1 to D4).
- **Concern**: bind the key's `referenceId` to the WhatsApp service user → **Addressed**: services found by a `service` account row, fixed per-service permissions, an owner check at the exchange, a mis-owned-key test.
- **Concern**: "one session per user" not guaranteed → **Addressed**: session work serialized under a lock on the user row; a near-expiry session is replaced.
- **Concern**: address derivation from the BSUID and collisions → **Addressed**: the address is independent of the BSUID (final form `whatsapp-<user id>@…`); a collision is a 500.
- **Concern**: the plugin reports driver errors as `INVALID_API_KEY` and logs raw errors → **Addressed**: relation check before a 401; redacted logger.

### Specify (Rounds 2 and 3, security architect: Codex + Claude inputs)
- **Concerns** C1 to C11 (CORS ordering, boot failure scope, budget executor, explicit `iat`, the relation check on every refusal, timeouts, alert posture, etc.) and the testability items → all **Addressed** (`329-specify-iter3-rebuttals.md`). The BSUID regex items became moot under owner decision D1 (sanity bounds only).

### Plan (Round 1)

#### Codex (REQUEST_CHANGES)
- **Concern**: provisional limits → **Addressed**: owner decision 3 adopted; initial values, alerts at one third, bounds, `update-limits`.
- **Concern**: CORS through an OPTIONS fall-through → **Addressed**: the router answers every request to its path; tests.
- **Concern**: JSON parser errors → **Addressed**: a route-local error handler.
- **Concern**: eligibility must bind the BSUID → **Addressed**: the account row's `account_id` re-checked under the lock.
- **Concern**: scripts must flush Sentry → **Addressed**.
- **Concern**: missing tests (expired ban, delegation over HTTP, `rate_limit` contents, row counts after a refusal) → **Addressed**.

### Plan (Round 2, security architect: Codex + Claude inputs)
- **Concerns** P1 to P12 (sign after commit with a pool-starvation probe, session-token generator, fail-closed probe gates, the journal bump, key-row alert reads, the criterion table, the flush banner, Content-Type, the apps/api system-only refusal, one green command per phase) → all **Addressed** (`329-plan-iter2-rebuttals.md`).

### Phase 1 (Round 1)

#### Codex (REQUEST_CHANGES)
- **Concern**: probe 1b did not prove every limit field changed → **Addressed**: all four fields changed and exercised.
- **Concern**: the absolute-form target covered 2 of 5 endpoints → **Addressed**: every path plus a mixed-case variant.

Round 2: Codex APPROVE, no issues.

### Phase 2 (Round 1)
No concerns raised. Codex APPROVE.

### Phase 3 (Round 1)

#### Codex (REQUEST_CHANGES)
- **Concern**: a padded noreply sign-up returns 400, not the spec's 409 → **Rebutted**: validation runs first in the frozen legacy order, and changing it would alter sign-up for every address. No oracle exists (padded noreply, taken and fresh addresses are identical). The spec's text was the error and was amended.

Round 2: Codex APPROVE.

### Phase 4 (Rounds 1 and 2)

#### Codex (REQUEST_CHANGES, round 1)
- **Concern**: the database host was printed after the write → **Addressed**: lines are printed as produced and the host comes before `connect()`; the call order is asserted; the buffered variant turns 6 tests red.

#### Codex (REQUEST_CHANGES, round 2)
- **Concern**: the raw key reached Sentry as a console breadcrumb → **Addressed**: breadcrumbs off and stdout printing, each guard enough alone; a production-shaped test (default integrations on) with a negative control that reproduces the leak.

Round 3: Codex APPROVE.

### Phase 5 (Round 1)

#### Codex (REQUEST_CHANGES)
- **Concern**: signing after the commit breaks the locking invariant → **Rebutted**: this is the approved plan, decided on probe evidence (signing inside hangs a pool of 2). Every window it opens is a residual the spec already accepts, and the session-outlives-token check stays under the lock. The spec sentence was amended with the security architect.
- **Concern**: claim equality did not check `kid` or `definePayload` → **Addressed** (`kid`); **Rebutted** for `definePayload`, since the `/token` JWT for the same session is `definePayload`'s output.

Round 2: Codex APPROVE.

### Phase 6 (Round 1)

#### Codex (REQUEST_CHANGES)
- **Concern**: the boot check matched the constraint by name only → **Addressed**: bound to the table and exact column order; three spoof tests, red against the old query; the production-shaped run repeated (13/13).

Round 2: Codex APPROVE.

### Phase 7 (Round 1)

#### Codex (REQUEST_CHANGES)
- **Concern**: the docs named `WHATSAPP_KEY_BOUNDS` without its ranges → **Addressed**: both docs state the ranges; the tests compute them from the constant; a negative run turns 2 red.

Round 2: Codex APPROVE.

### PR review (Round 1)

#### Codex (REQUEST_CHANGES)
- **Concern**: merge is blocked because `AUTH_DEPLOYED_THROUGH` is `null`, there is no `0001` apply record, and staging is unverified → **Rebutted**: this is the agreed merge precondition, done at the rebase after spec 300's cutover. Bumping now would assert an apply that has not happened. It is stated in the PR body and the runbook. *(Superseded on 2026-10-28 by the owner's decision: no rebase step; `0001` goes to staging before the merge, and production gets the whole auth journal at its cutover. `AUTH_DEPLOYED_THROUGH` stays `null` in this PR. See Follow-up Items.)*
- **Concern**: `grant-admin --revoke` on a noreply address bypasses the reserved-domain check → **Addressed** (docs) and **Rebutted** (code). A demotion only lowers a role, it is the runbook's repair for a promoted WhatsApp user, and the system domain has never been refused on revoke either. The overclaiming wording in `arch.md`, `RELEASE.md` and the script header is narrowed to "never grants". A regression test pins grant-refused and revoke-allowed, and goes red under the suggested change.

### PR review (Round 2)

#### Codex (COMMENT)
- **Concern**: the runbook's post-apply check matched the constraint by name only, so a same-named constraint elsewhere could answer `t` → **Addressed**: the query is now the boot check's own (`auth.account`, `contype = 'u'`, columns in order). Run against Postgres 18 with the journal applied: `t|t`; with the constraint moved to `auth.decoy`: `t|f`; with the columns reversed: `t|f`.

### PR gate, security architect pass 2 (route, alerts, apps/api, docs; two external reviewers read against the tree)
- **Q1 (blocking)**: an ineligible user's id reached Sentry as a console breadcrumb, because the service init kept the default Console integration → **Addressed**: breadcrumbs off service-wide. New case in `whatsapp-session-sentry.test.ts`: the user is promoted to admin, the exchange answers 500, and neither the user id, the BSUID, the key nor the token is in any envelope. Negative control: with the two options removed, the case goes red on the user id.
- **Q2**: hash prefixes in per-key alerts are not actionable → **Addressed**: the alerts carry `keyId`; the runbook says to match it against `list`.
- **Q3**: the outcome switch had no default → **Addressed**: a `never` default that answers 500.
- **Q4**: `/health` logged only `err.name` → **Addressed**: it logs `redactError`'s `{name, code}`, asserted in the recovery test.
- **Q5**: confirm the runbook's constraint query at the tip → confirmed (`auth.account`, `contype = 'u'`, ordered columns).
- **Q6**: the Bearer scheme should be case-insensitive (RFC 7235) → **Addressed**: tests for `bearer`, `BEARER` and `BeArEr` (all 3 red without the flag).
- **Q7**: format characters in a BSUID → **Addressed**: `\p{Cf}` excluded; zero-width space, zero-width joiner and bidi override give 400 (all 3 red without it).
- **Q8**: fire-once alerts carried counts that are always 1 or the threshold → **Addressed**: fields dropped; the runbook's alert section says what the event marks.
- **Q9**: comments on `EXCHANGE_LOCK_TIMEOUT` and `APIKEY_RELATION_CHECK_TTL` name `exchange-outage-probe.ts` → **Addressed**.
- **Q10**: the contract test's key comment was wrong → **Addressed** (no rate limit, so `requestCount` never moves).
- Verified: apps/auth 441/441; `whatsapp-session`, `whatsapp-session-sentry` and `boot` 92/92; doc tests 117; typecheck and lint clean. CI on 4495396 (before this pass) passed all four jobs: gitleaks, frontend, auth and api.

### PR gate, security architect pass 1 (library and credential surface; Claude APPROVE WITH CHANGES, Codex REQUEST CHANGES)
- **R1**: the under-lock role check was a denylist (`role === 'admin'`), and `user,admin` counts as admin to the plugin → **Addressed**: an allowlist, `role !== USER_ROLE` → `ineligible: role`. Tests: `user,admin`, `admin,user`, `moderator`, `User`, empty and null. All 6 are red against the old check.
- **R2**: `--name` and `--client-id` were unrestricted, so a pasted key would be printed and sent to Sentry, and a newline injected output → **Addressed**: `[A-Za-z0-9 ._-]{1,64}`, and values holding a key prefix, matching a secret-scanning pattern, or containing a 32-letter run (a key body without its prefix; one step past the request) are refused without being echoed. Ten refusal cases on both flags, plus accepted near misses. 10 tests are red with the check bypassed.
- **R3**: the no-DSN exit-3 path depended on an uninitialised `Sentry.flush` answering false → **Addressed**: `scriptRecorder(undefined)` returns `unrecordedRecorder` (no capture, no flush), and the banner states the reason. New file `service-keys-no-dsn.test.ts` uses the real, never-initialised Sentry: exit 3, the key id in the banner, the write standing, Sentry still uninitialised. Red against the old choice. A capture with no client leaves no observable trace (`lastEventId` stays undefined; a control proved it), so the test checks the chosen path and its banner rather than the absence of a call.
- **R4**: `--confirm` for `update-limits` and `revoke` was the service user's id, so a confirm from another key's show step still wrote → **Addressed**: it is bound to the key id. The show step and rotate's revoke hints print it, and the runbook and demo harness follow. Tests: the user's id and another key's id both write nothing (2 red against the old binding).
- **Noted, no change** (per security): `AUTH_DEPLOYED_THROUGH` stays null in this PR (main sets it at the production cutover); the boot check fails open on non-`42P01` errors by design; a leaked key can create up to its daily budget of new noreply users (the spec's threat model, visible as table growth).
- Verified: apps/auth 459/459; packages/auth 252 + 1 skipped; apps/api doc and contract tests 118; typecheck and lint clean; the demo harness has the same exit tally and both checks pass. CI on 485e55f (pass 2) passed all four jobs.

### Main architect, items A and B (the cutover applies the whole auth journal), 2026-10-28
- **A (blocking)**: `deploy-guide.md` step 3 and `better-auth-cutover.md` step 5 applied only `0000` and checked a hardcoded 6 tables, which `0001` makes 7 → **Addressed** (0c2da21). Both now apply every journal file in `_journal.json` order, one `psql -X -v ON_ERROR_STOP=1 --single-transaction` each, before the copy. The check is `auth-journal.mjs check`, derived per migration from the objects its SQL creates (it refuses a statement kind it cannot check), so a later migration needs no runbook edit. Tests: `apps/auth/tests/cutover/auth-journal.test.ts` (the check on pglite through the whole journal, and through `0000` only, where it names `0001`), and a doc test pinning both pages' commands, their order before the copy, and no hardcoded count. It is red against the old guide (4 failed).
- **B (blocking)**: `copy.sh --dry-run` on a schema-less database applied only the static `0000` → **Addressed** (05554db). `02-import-auth.sql` includes `:dry_run_baseline`, which is `auth-journal.mjs sql` (every file in order, then an assertion that each migration is present) read from a file descriptor that `copy.sh` holds open, so no file is written. The psql test harness gained `\i`. Tests: the baseline order, and a baseline of `0000` plus the full-journal assertion that fails naming `0001` (red against the old `\ir 0000`). Real-Postgres dry run below.
- The runbooks' wording, verbatim from main, goes in the service-keys runbook's staging half (d177e80): the apply discipline, and the duplicate pre-check only where data exists.

### Plan (Round 3, owner amendment 1, withdrawn)

#### Codex (REQUEST_CHANGES), plus the security architect's T1-T20 and the external round (Codex and Claude, both REQUEST CHANGES)
- **Concerns**: Sentry injection for the stub sender; a claimable holder already linked; phone-number normalisation; race assertions; wiring. T1 found the placeholder SMS sender left all five plugin routes live (confirmed by probe), and T2-T20 covered supersede, holder states, the canonical form, locking, HMAC keys and more → **N/A**: the owner withdrew amendment 1 before it was built (amendment 2). Only T12 carried into the new phase 8. The record is in `329-plan-iter2-rebuttals.md` and the appendix.

### Phase 8 (Round 1)

#### Codex (COMMENT)
- **Concern**: the review document's summary still said seven phases, and its compliance list still described the stored phone number → **Addressed** in this review phase (summary, compliance, deviations, lessons).

### PR review, extra Codex pass on the phase 8 diff (security architect's request, 2026-10-30)

In the review phase, porch replayed the recorded PR reviews of 2026-10-28, so no fresh PR-level consult ran on phase 8. The security architect asked for one manually, as an extra artifact (`329-review-extra-phase8-codex.txt`), and ran their own Claude pass in parallel.

#### Codex (COMMENT)
- **Concern**: the PR body still said only the exchange is scrubbed, but since #334 `SERVICE_SENTRY_OPTIONS.beforeSend` scrubs every apps/auth request → **Addressed**: the PR body is corrected (Changes and "Known, out of scope").
- **Concern**: migration `0001_api_key` remains a pre-merge staging gate → **N/A**: already documented as the merge precondition; no code change.

### PR review, security architect's Claude pass on the phase 8 increment (APPROVE WITH CHANGES, 2026-10-30)

The full text is in `329-review-extra-phase8-security-claude.md`.
- **U1**: the journal checker's ADD COLUMN branch lost its only coverage when the phone assertions were inverted → **Addressed**: a unit test checks that `ALTER TABLE "auth"."users" ADD COLUMN "x" text;` yields the `column_name = 'x'` check.
- **U2**: the sign-up scan in `api-key.test.ts` could pass on an empty dump, and accepted either sign-up outcome → **Addressed**: a positive control (the dump contains the sign-up's email), and the observed better-auth 1.7.7 behaviour pinned (200; undeclared fields are dropped), with a comment.
- **Doc nits** → **Addressed**: the summary states phase 8's COMMENT verdict; the superseded review bullet no longer describes the deleted 400 tests; the plan's phone lines are marked superseded by phase 8, so the spec, plan and review agree.
- **Optional nits** → **Addressed**: a nested-object `phone_number` shape, the JSON-number shape registered as a needle, and a maximal valid body (a 256-character BSUID and a 501-digit phone value) answering 200 with the number in no row.

## Lessons Learned

### What Went Well

- **Probes before code.** The pinning probes, on pglite and then on real Postgres, settled every library behaviour the design rested on before the code depending on it was written. The behaviours: key deletion on exhaustion without a refill, `INVALID_API_KEY` for an outage, `signJWT` without `iat`, the session-token alphabet, and the `FOR NO KEY UPDATE` semantics. Each gate had a named first consumer, so nothing downstream was built on an assumption.
- **Mutation tests on the security checks.** Every guard that matters went red when broken, in the route, the scripts, the boot check, the logger, the scan and the docs. Two mutants survived at first, and both taught something. M2 survived because of a cache, so the test now advances the clock. M7 is an equivalent mutant, recorded as such.
- **A production-shaped outage run** (real pool, `NODE_ENV=production`, database stopped under the process) owned the criteria pglite cannot show: the post-TTL 500s, the lock timeout and `/health` recovery.

### Challenges Encountered

- **Sentry leaks hidden by the test setup.** The key reached Sentry through console breadcrumbs, and the first test missed it because it turned default integrations off. Separately, the request-data integration attaches the body and `Authorization` to any event raised in a request. The script now has its own options and prints through stdout, the exchange has `beforeSend`, and the pre-existing leak on other paths went to the security architect.
- **Signing inside the transaction hangs a small pool.** The spec first said to sign inside the transaction. Probe 4 E2 showed a pool of 2 hanging, so the plan moved signing after the commit and the spec text followed.
- **A placeholder sender does not make an auth plugin safe.** better-auth's phone-number plugin with a `sendOTP` that throws still stored live codes, created sessions on verify, signed in by phone and password without calling the sender, and set passwords through reset-by-phone (probe, appendix). An unused plugin route is a live route. Amendment 1 was withdrawn before any of it shipped.
- **Porch's rollback resets every plan phase.** After `porch rollback <id> plan`, phases already built and approved came back pending. Parent mode and `none` mode both dead-end for plan phases in this codev version. Normal mode replays the recorded review files, so the re-walk cost no new consults.
- **Load-induced timeouts on the shared machine.** Load averages ran up to about 280, and 30 s pglite hooks failed across all four packages. The two files that blocked this branch's green runs got a measured deadline; the rest is recorded for main.

### What Would Be Done Differently

- Write the Sentry tests production-shaped from the start (default integrations on, spy transport only). A `defaultIntegrations: false` test proves nothing about what production sends.
- Check the spec's literal wording against the existing guard order before writing it. The padded-409 criterion was a drafting error, caught only in phase 3's review.

### Methodology Improvements

- porch's `tests` check truncates its output, so a one-off failure under load names no test (phase 7). Keeping the full log would make an unreproduced failure diagnosable.
- porch: a rollback into a phased protocol should keep completed plan phases, or offer a skip; parent mode should register its `phase-review-*` gate so `porch approve` accepts it (today it emits a gate nothing can clear).
- The Gemini lane was skipped in every round (`agy` exit 3), so each "3-way" review was Codex alone, plus the security architect's own rounds on the spec and plan. A preflight that refuses to start a consult round whose lanes cannot run would surface this before a round counts as reviewed.

## Architecture Updates

- Routed: cold — `codev/resources/arch.md`, Authentication & Authorization — a new paragraph on service keys and the WhatsApp exchange (service identity, the issuing script, blocked plugin surface, eligibility under the lock, BSUID storage, the noreply domain, alert posture, the boot check, the runbook). Phase 8 replaced the phone-storage sentence: no phone number is stored; the exchange accepts and ignores it. The first-use refusal is now stated as system domain only, with the reason. `grant-admin.ts` is corrected to refuse both reserved domains (also in `RELEASE.md`). (Phase 7)
- Hot tier (`arch-critical.md`) unchanged. It is at its cap of 10 facts, and the service-key facts are subsystem detail that the Authentication map entry already routes to. The cross-cutting facts are untouched: two databases, the JWT shape, `ROUTER_RULES` all `false`, and migrations by hand.

## Lessons Learned Updates

- Routed: cold — `codev/resources/lessons-learned.md`, new section "Service API keys and the WhatsApp exchange (spec 329)": `@better-auth/api-key` 1.7.7 behaviours (no-refill exhaustion deletes the key, an outage reported as `INVALID_API_KEY` after logging the raw error, `signJWT` without `iat`); the `FOR UPDATE` versus `FOR NO KEY UPDATE` hazard on a row other tables reference; pool starvation from a pooled call inside an open transaction; Sentry's console breadcrumbs and request data, and why `defaultIntegrations: false` hides them; drizzle putting the SQLSTATE on `cause`; a mutant surviving behind a cache.
- Routed: cold — the same section, two more: an auth plugin's routes are live even with a placeholder sender (probe it before relying on it), and porch's rollback to plan resets every plan phase (parent and `none` modes dead-end; normal mode replays the recorded reviews).
- Hot tier (`lessons-critical.md`): no lesson added, since it is at its cap of 10. The map entry for spec 300 now also names spec 329, so the map stays at its current count. Candidate for promotion at the next MAINTAIN: "a Sentry test with default integrations off cannot show what production sends".

## Flaky Tests

### `apps/auth/tests/secrets.test.ts` and `apps/auth/tests/cutover/copy.test.ts` (fixed with a targeted deadline)

Both are spec 300 tests (the secrets guard and the cutover copy). Their setup hooks (`beforeAll` in `secrets.test.ts`, which starts two services; `beforeEach` in `copy.test.ts`, which builds two pglite databases) crossed the 30 s `hookTimeout` when the whole monorepo's tests ran at once. They pass when apps/auth runs alone (261/261). **Not skipped** (security architect): each hook now has its own 100 s deadline, in those two files only (`chore(test)` commit in phase 2).

**Conditions: a real shared-machine run, no artificial load harness.** The machine runs other builders' sessions and iOS simulators. Load averages (1/5/15 min) sampled during the measurement: 20.75 / 50.01 / 71.33, 54.04 / 46.78 / 55.22, 22.15 / 41.07 / 51.18. Each run is a full root run with `--force --continue`, alternating `turbo run test` and `turbo run test typecheck lint`.

**Timings (N = 6, hooks given a temporary 600 s deadline and timed):** slowest per run, in ms.

| Run | Tasks | `secrets` beforeAll | `copy` beforeEach (max) | Both target files |
|---|---|---|---|---|
| 1 | test | 35,465 | 39,005 | pass |
| 2 | test, typecheck, lint | 34,839 | 36,490 | pass |
| 3 | test | 31,703 | 30,088 | pass |
| 4 | test, typecheck, lint | 42,296 | 47,098 | pass |
| 5 | test | 27,097 | 30,239 | pass |
| 6 | test, typecheck, lint | 40,547 | 43,910 | pass |

Maximum 47 s; the deadline is 100 s (about 2x, above the architect's 60 s floor).

**Proof: 30 s versus 100 s, same conditions, counted on the two target files only** (the rest of the suite is red from machine load regardless, see below):

```
before run 1 [test] deadline=30_000 secrets=RED copy=RED slowest=[copy=9296 copy=32440 ]
before run 2 [test typecheck lint] deadline=30_000 secrets=RED copy=RED slowest=[copy=7926 copy=41851 ]
before run 3 [test] deadline=30_000 secrets=RED copy=green slowest=[copy=29012 secrets=31456 ]
before run 4 [test typecheck lint] deadline=30_000 secrets=RED copy=RED slowest=[copy=10031 copy=41717 ]
before run 5 [test] deadline=30_000 secrets=green copy=green slowest=[copy=25698 secrets=26954 ]
after run 1 [test] deadline=100_000 secrets=green copy=green slowest=[copy=36150 secrets=39634 ]
after run 2 [test typecheck lint] deadline=100_000 secrets=green copy=green slowest=[secrets=47493 copy=53506 ]
after run 3 [test] deadline=100_000 secrets=green copy=green slowest=[secrets=12502 copy=15275 ]
after run 4 [test typecheck lint] deadline=100_000 secrets=green copy=green slowest=[secrets=20134 copy=21117 ]
after run 5 [test] deadline=100_000 secrets=green copy=green slowest=[copy=14771 secrets=14982 ]
```

At 30 s: `secrets` red 4/5, `copy` red 3/5. At 100 s: both green 5/5 (slowest hook 53.5 s).

### Phase 7: one unidentified `@ansari/auth#test` failure inside porch's check (not reproduced)

After review iteration 1 (docs and apps/api tests only; no packages/auth file changed), porch's `tests` check failed once with `@ansari/auth#test ... exited (1)` after 78.9 s, and porch's truncated output did not name the test. The suite passed alone right after (246 passed, 1 skipped), and the full root command, rerun with its log kept, passed (`@ansari/auth` 246 + 1 skipped, `ansari-api` 1132 + 3 skipped, exit 0). Load averages at the rerun's start: 134 (1 min), 280 (5 min), 252 (15 min). That is consistent with the load timeouts below, but I am not naming a cause I did not see. Nothing was skipped or changed to get past it.

### Other files that tripped 30 s timeouts in the same runs (evidence for main; not fixed here)

On the same shared machine, with no harness, **other files hit the 30 s hook or test deadline in 5 of the 6 timing runs** (runs 1, 2, 4, 5 and 6; only run 3 was clean). Extracted from the vitest failure summaries of each run's output (`<package> <file> :: <error>`):

```
== timing run 1
@ansari/auth tests/auth.http.test.ts :: Hook timed out in 30000ms
@ansari/auth tests/auth.integration.test.ts :: Hook timed out in 30000ms
@ansari/auth tests/config/api-key.test.ts :: Hook timed out in 30000ms
@ansari/auth tests/config/credentials.test.ts :: Hook timed out in 30000ms
@ansari/auth tests/config/options.test.ts :: Hook timed out in 30000ms
@ansari/auth tests/config/rate-limit-store.test.ts :: Hook timed out in 30000ms
@ansari/auth tests/config/rate-limit.test.ts :: Hook timed out in 30000ms
@ansari/auth tests/config/sign-up.test.ts :: Hook timed out in 30000ms
@ansari/auth tests/config/tokens.test.ts :: Hook timed out in 30000ms
@ansari/auth tests/migration/auth-journal-parity.test.ts :: Hook timed out in 30000ms
@ansari/auth tests/schema/auth-schema.test.ts :: Hook timed out in 30000ms
ansari-api tests/contract/legacy-users-contract.test.ts :: Hook timed out in 30000ms
ansari-api tests/feedback-upsert.test.ts :: Hook timed out in 30000ms
ansari-api tests/toolcalls-persistence.test.ts :: Hook timed out in 30000ms
ansari-auth tests/account.test.ts :: Hook timed out in 30000ms
ansari-auth tests/blocked-paths.test.ts :: Hook timed out in 30000ms
ansari-auth tests/client-ip.test.ts :: Hook timed out in 30000ms
ansari-auth tests/frontend-client.test.ts :: Hook timed out in 30000ms
ansari-auth tests/grant-admin.test.ts :: Hook timed out in 30000ms
ansari-auth tests/limits.test.ts :: Hook timed out in 30000ms
ansari-auth tests/public-face.test.ts :: Hook timed out in 30000ms
ansari-auth tests/reset.test.ts :: Hook timed out in 30000ms
== timing run 2
@ansari/auth tests/schema/auth-schema.test.ts :: Hook timed out in 30000ms
ansari-api tests/feedback-upsert.test.ts :: Hook timed out in 30000ms
ansari-api tests/migration/migration-schema-parity.test.ts :: Test timed out in 30000ms
ansari-auth tests/frontend-client.test.ts :: Hook timed out in 30000ms
ansari-auth tests/public-face.test.ts :: Hook timed out in 30000ms
== timing run 3
== timing run 4
@ansari/auth tests/auth.http.test.ts :: Hook timed out in 30000ms
@ansari/auth tests/auth.integration.test.ts :: Hook timed out in 30000ms
@ansari/auth tests/config/api-key.test.ts :: Hook timed out in 30000ms
@ansari/auth tests/config/credentials.test.ts :: Hook timed out in 30000ms
@ansari/auth tests/config/options.test.ts :: Hook timed out in 30000ms
@ansari/auth tests/config/rate-limit-store.test.ts :: Hook timed out in 30000ms
@ansari/auth tests/config/rate-limit.test.ts :: Hook timed out in 30000ms
@ansari/auth tests/config/sign-up.test.ts :: Hook timed out in 30000ms
@ansari/auth tests/config/tokens.test.ts :: Hook timed out in 30000ms
@ansari/auth tests/migration/auth-journal-parity.test.ts :: Hook timed out in 30000ms
@ansari/auth tests/schema/auth-schema.test.ts :: Hook timed out in 30000ms
@ansari/auth tests/unit/logger.test.ts :: Hook timed out in 30000ms
ansari-api tests/auth/layer.test.ts :: Hook timed out in 30000ms
ansari-api tests/auth/require-user.test.ts :: Hook timed out in 30000ms
ansari-api tests/auth/resolve-user.test.ts :: Hook timed out in 30000ms
ansari-api tests/contract/legacy-users-contract.test.ts :: Hook timed out in 30000ms
ansari-api tests/feedback-upsert.test.ts :: Hook timed out in 30000ms
ansari-api tests/migration/migration-schema-parity.test.ts :: Test timed out in 30000ms
ansari-api tests/migration/window-migration.test.ts :: Hook timed out in 30000ms
ansari-api tests/thread-get-contract.test.ts :: Hook timed out in 30000ms
ansari-api tests/toolcalls-persistence.test.ts :: Hook timed out in 30000ms
ansari-auth tests/account.test.ts :: Hook timed out in 30000ms
ansari-auth tests/blocked-paths.test.ts :: Hook timed out in 30000ms
ansari-auth tests/client-ip.test.ts :: Hook timed out in 30000ms
ansari-auth tests/frontend-client.test.ts :: Hook timed out in 30000ms
ansari-auth tests/grant-admin.test.ts :: Hook timed out in 30000ms
ansari-auth tests/limits.test.ts :: Hook timed out in 30000ms
ansari-auth tests/public-face.test.ts :: Hook timed out in 30000ms
ansari-auth tests/reset.test.ts :: Hook timed out in 30000ms
== timing run 5
@ansari/auth tests/config/rate-limit.test.ts :: Test timed out in 30000ms
ansari-api tests/migration/window-migration.test.ts :: Test timed out in 30000ms
== timing run 6
@ansari/auth tests/auth.http.test.ts :: Hook timed out in 30000ms
@ansari/auth tests/auth.integration.test.ts :: Hook timed out in 30000ms
@ansari/auth tests/config/api-key.test.ts :: Hook timed out in 30000ms
@ansari/auth tests/config/credentials.test.ts :: Hook timed out in 30000ms
@ansari/auth tests/config/options.test.ts :: Hook timed out in 30000ms
@ansari/auth tests/config/rate-limit-store.test.ts :: Hook timed out in 30000ms
@ansari/auth tests/config/rate-limit.test.ts :: Hook timed out in 30000ms
@ansari/auth tests/config/sign-up.test.ts :: Hook timed out in 30000ms
@ansari/auth tests/config/tokens.test.ts :: Hook timed out in 30000ms
@ansari/auth tests/migration/auth-journal-parity.test.ts :: Hook timed out in 30000ms
@ansari/auth tests/schema/auth-schema.test.ts :: Hook timed out in 30000ms
@ansari/auth tests/unit/logger.test.ts :: Hook timed out in 30000ms
ansari-api tests/auth/layer.test.ts :: Hook timed out in 30000ms
ansari-api tests/auth/require-user.test.ts :: Hook timed out in 30000ms
ansari-api tests/auth/resolve-user.test.ts :: Hook timed out in 30000ms
ansari-api tests/contract/legacy-users-contract.test.ts :: Hook timed out in 30000ms
ansari-api tests/feedback-upsert.test.ts :: Hook timed out in 30000ms
ansari-api tests/migration/migration-schema-parity.test.ts :: Test timed out in 30000ms
ansari-api tests/toolcalls-persistence.test.ts :: Hook timed out in 30000ms
ansari-auth tests/account.test.ts :: Hook timed out in 30000ms
ansari-auth tests/blocked-paths.test.ts :: Hook timed out in 30000ms
ansari-auth tests/client-ip.test.ts :: Hook timed out in 30000ms
ansari-auth tests/frontend-client.test.ts :: Hook timed out in 30000ms
ansari-auth tests/grant-admin.test.ts :: Hook timed out in 30000ms
ansari-auth tests/limits.test.ts :: Hook timed out in 30000ms
ansari-auth tests/public-face.test.ts :: Hook timed out in 30000ms
ansari-auth tests/reset.test.ts :: Hook timed out in 30000ms
```

### Under #301's artificial load (28 busy loops on 14 cores), 3 runs, for comparison

Without `--continue`, turbo stops at the first failing package, so each run shows only the first package to fail: run 1 the frontend (`lib/worklets.test.ts`, `Test timed out in 5000ms`); run 2 apps/api (`tests/migration/window-migration.test.ts`, `Test timed out in 30000ms`); run 3 twelve `packages/auth` files. Hook times there: `secrets` 37 s, `copy` 36 s and 55 s.

```
timing run 1 exit=1 fails=[] times=[]
timing run 2 exit=1 fails=[] times=[copy=5644 copy=5992 copy=6557 copy=6943 copy=7109 copy=7159 copy=7191 copy=7625 copy=7780 copy=7803 copy=7888 copy=8016 copy=8298 copy=8468 copy=8672 copy=9121 copy=10567 copy=11835 copy=11842 copy=14900 copy=15385 copy=36043 secrets=37399 ]
timing run 3 exit=1 fails=[@ansari/auth:test:  FAIL  tests/auth.http.test.ts [ tests/auth.http.test.ts ];@ansari/auth:test:  FAIL  tests/auth.integration.test.ts [ tests/auth.integration.test.ts ];@ansari/auth:test:  FAIL  tests/config/api-key.test.ts [ tests/config/api-key.test.ts ];@ansari/auth:test:  FAIL  tests/config/credentials.test.ts [ tests/config/credentials.test.ts ];@ansari/auth:test:  FAIL  tests/config/options.test.ts [ tests/config/options.test.ts ];@ansari/auth:test:  FAIL  tests/config/rate-limit-store.test.ts [ tests/config/rate-limit-store.test.ts ];@ansari/auth:test:  FAIL  tests/config/rate-limit.test.ts [ tests/config/rate-limit.test.ts ];@ansari/auth:test:  FAIL  tests/config/sign-up.test.ts [ tests/config/sign-up.test.ts ];@ansari/auth:test:  FAIL  tests/config/tokens.test.ts [ tests/config/tokens.test.ts ];@ansari/auth:test:  FAIL  tests/migration/auth-journal-parity.test.ts > Drizzle schema vs the auth journal;@ansari/auth:test:  FAIL  tests/schema/auth-schema.test.ts [ tests/schema/auth-schema.test.ts ];@ansari/auth:test:  FAIL  tests/unit/logger.test.ts > createAuth uses the redacted logger > a non-error log survives with its level and message (a disabled logger fails this);] times=[copy=55167 ]
```

This is a monorepo-wide matter (pglite cold starts against 30 s deadlines under contention), passed to the main architect as a follow-up; this PR fixes only the two files that blocked its own green runs.

## Follow-up Items

- **Migration `0001` (owner decision, 2026-10-28).** **Staging, before the merge:** the duplicate check on `auth.account (provider_id, account_id)`, then `0001` applied with `psql -X -v ON_ERROR_STOP=1 --single-transaction` and verified with the runbook's bound query. apps/auth refuses to boot without it, so the apply precedes the merge. **Production:** at the production cutover, the full auth journal as it stands then (`0000`, `0001` and any later migration) is applied in order before the promoted code deploys, owned by `docs/cutover/better-auth-cutover.md`. `develop` is not frozen. `AUTH_DEPLOYED_THROUGH` stays `null`, with no `auth-journal-applied` record in this PR (security architect; main to confirm): it is production truth, and main sets it at the cutover. apps/api's `DEPLOYED_THROUGH` is not touched.
- **Staging smoke** (#327's builder): a phone-visible user, a phone-hidden user, and 5 messages in 1 s, using a key from the script. Expected: 5 answers, 1 user, 1 session. Recorded as a comment on PR #327. #327 also switches to `Authorization: Bearer` and the error shapes in the contract summary, and carries spec 321's amendment.
- ~~**Pre-existing Sentry request-data leak** on apps/auth's other paths~~ **Fixed by #334** (merged to develop 2026-10-29). When develop was merged into this branch, `alerts.ts` was resolved as the security architect specified: one `SERVICE_SENTRY_OPTIONS` whose `beforeSend` is #334's unconditional `scrubRequestEvent`, a superset of this PR's exchange-only `scrubExchangeEvent`, which was deleted. `WHATSAPP_SESSION_PATH` and the breadcrumb reasons were kept. The 'another path is left as it is' test is inverted (every path is now scrubbed), and `SCRIPT_SENTRY_OPTIONS` notes that a CLI needs no `beforeSend`. Both apps' Sentry suites pass (apps/auth 90, apps/api 4). Removing `beforeSend` turns 3 red, including this PR's exchange case.
- **#327 stops sending `phone_number`** (the security architect asks its author through the community architect); then a later PR removes the field from the exchange's contract, and spec 321's "never sent on" rule applies again.
- **Monorepo-wide pglite 30 s timeouts under load** (evidence under Flaky Tests), for main.
- **#314 (MCP):** the verify route at the public origin, the apps/api client, and its own key bounds (`ansari-mcp` borrows `WHATSAPP_KEY_BOUNDS` until then).
- **Plugin upgrade:** `@better-auth/api-key` past 1.7.7 needs core ≥ 1.7.14; bump them together and rerun the pinning probes.
- **Leaderboard** keeps its static secret for now (owner decision 4: migrate later).

## Appendix: verification evidence

Probe outputs, per-phase notes and the pre-existing Sentry reproduction, recorded as each phase ran.

### Merge precondition: `0001_api_key` applied to staging, 2026-10-30

The owner applied `packages/auth/drizzle/0001_api_key.sql` to the staging auth database through the staging Tailscale forwarder, with `psql -X -v ON_ERROR_STOP=1 --single-transaction`, and pasted the output:

```
CREATE TABLE
ALTER TABLE
CREATE INDEX
CREATE INDEX
CREATE INDEX
ALTER TABLE
t|t
```

`t|t` is the runbook's bound verification query: `auth.apikey` exists, and `account_provider_id_account_id_unique` is a unique constraint on `auth.account` over `(provider_id, account_id)`, in order. The duplicate check's own output was not pasted. Its question is answered by the apply itself: adding that constraint inside the single transaction would have failed, and rolled everything back, on any duplicate pair. The precondition for merging PR #331 is met. Production gets the whole auth journal at its cutover (`docs/cutover/better-auth-cutover.md`).

### Phase 8: remove the phone number (owner amendment 2) (notes)

- **Source.** `schema.ts` drops `users.phoneNumber` and `createAuth` drops the `phone_number` additional field. In `whatsapp.ts`, `resolveOrCreateWhatsappUser` and `issueWhatsappToken` take no phone, and the update under the lock is gone. The route reads `bsuid` only: a `phone_number` in any shape is accepted and never read. `EXCHANGE_BODY_LIMIT` is unchanged, with room for the field until #327 stops sending it.
- **Migration.** `0001` was regenerated in place as `0001_api_key` (`drizzle-kit generate --name api_key`, after removing the old entry and snapshot). Its diff from the old `0001_api_key_phone.sql` is exactly one line, the removed `ALTER TABLE "auth"."users" ADD COLUMN "phone_number" text`. The tag is renamed in every test and doc. Historical outputs quoted in this review keep the old name. `AUTH_DEPLOYED_THROUGH` stays `null`.
- **New tests:**
  - `packages/auth/tests/schema/better-auth-model.test.ts`: `getAuthTables` with the configured options, against the journal-built database. It covers all models (`apikey`'s 21 fields included), with one documented deviation, `apikey.referenceId` as uuid with a foreign key. Its negative control, a dropped `key` column and a retyped `name`, reports both.
  - `apps/auth/tests/no-phone-source.test.ts`: 0 hits in 28 files, comments excluded. Its negatives: a planted read and a string are caught; comments are not.
  - The route's accept-and-ignore cases: digits, a leading `+`, a JSON number, `null`, empty, 33 characters, letters and spaces. Each gets a 200, and an all-tables scan of `auth` then finds the value in no row; the scan also asserts that its own BSUID is present, so it cannot pass vacuously. The end-to-end test scans the auth side too.
- **Kept as needles:** the never-log capture, the Sentry scrub test, the raw-response-bytes assertion, `/me` and the rate-limit key test.
- **Mutation checks** on the route, each reverted:
  - a 400 on a numeric `phone_number` turns the accept test and the source check red (2 failed);
  - logging the field turns the log-capture test and the source check red (2 failed).
- **Probes** after the edits, on Postgres 18 (throwaway container): library probes 3/3, the lock probe 12/12.

```
Probes 2 and session token against Postgres 18.6 (Debian 18.6-1.pgdg13+2) at 127.0.0.1 (2026-10-29T23:43:07.444Z)
PASS  2 signJWT({sub, sid, iat, exp}) matches a /api/auth/token JWT; the passed exp is honoured
PASS  2 without iat the claim set differs (why the exchange passes it)
PASS  session token: generateRandomString(32, a-z, A-Z, 0-9) has the shape createSession writes
3/3 steps as expected.
Probe 4 against Postgres 18.6 (Debian 18.6-1.pgdg13+2) at 127.0.0.1 (2026-10-29T23:43:08.485Z)
PASS  A same-transaction session insert under FOR NO KEY UPDATE: committed without waiting; 1 session
PASS  B concurrent ban waits for the exchange, then deletes its session: ban waited: true; ban finished after exchange commit: true; sessions left: 0
PASS  C session insert from another connection does not wait on FOR NO KEY UPDATE: insert completed while the lock was held
PASS  C' contrast: FOR UPDATE blocks another connection's session insert (the hazard): other connection's insert: 57014 (57014 = cancelled by statement_timeout, i.e. it waited)
PASS  D lock_timeout turns a held lock into 55P03: waiting exchange got: 55P03
PASS  E1 signing AFTER commit, pool max 2: 10/10 finished
PASS  E2 signing INSIDE the transaction, pool max 2, no connect timeout: deadline: the run HUNG (10000 ms), as expected for signing inside
PASS  E2 signing INSIDE the transaction, pool max 2, connect timeout 2000 ms: 0/10 finished; failures: Error (loud failure, no hang)
PASS  F1 real functions: 10 concurrent exchanges for one new BSUID: distinct users: 1; distinct sids: 1; whatsapp rows: 1; sessions: 1
PASS  F2 real functions: another connection's open session insert does not block the exchange: exchange outcome while the insert was open: issued
PASS  F3 real functions: a held ban update fails the exchange with 55P03 within its lock_timeout: exchange got 55P03 after 2014 ms (lock_timeout 2000 ms); after the ban committed: banned
PASS  F4 real functions: 10 concurrent new users on a pool of 2 (sign after commit): 10/10 issued
12/12 steps as expected.
```

- **Verified:** typecheck and lint 13/13; `@ansari/auth` 254 + 1 skipped; `ansari-auth` 472; `ansari-api` 1139 + 3 skipped.

### Re-walk of phases 1 to 7 after the porch rollback to plan, 2026-10-30

`porch rollback 329 plan` re-extracts the plan and resets every plan phase to pending, so after the plan gate porch required phases 1 to 7 to be walked again. Parent mode and `none` mode both dead-end for plan phases in this codev version (`dist/commands/porch/next.js`), so, with the security architect's agreement, the re-walk used normal mode: porch replayed the recorded review files of 2026-10-28, iteration by iteration. It ran no new consult (none was emitted), and each step ran the build and test checks, all green. The phase 8 work was stashed so the checks ran on the committed code only.

- phase_1: re-walked after the porch rollback; code unchanged since a2a16745; recorded reviews replayed (iter 1 REQUEST_CHANGES + rebuttal, iter 2 APPROVE).
- phase_2: re-walked after the porch rollback; code unchanged since a2a16745; recorded reviews replayed (iter 1 APPROVE).
- phase_3: re-walked after the porch rollback; code unchanged since a2a16745; recorded reviews replayed (iter 1 REQUEST_CHANGES + rebuttal, iter 2 APPROVE).
- phase_4: re-walked after the porch rollback; code unchanged since a2a16745; recorded reviews replayed (iters 1 and 2 REQUEST_CHANGES + rebuttal, iter 3 APPROVE).
- phase_5: re-walked after the porch rollback; code unchanged since a2a16745; recorded reviews replayed (iter 1 REQUEST_CHANGES + rebuttal, iter 2 APPROVE).
- phase_6: re-walked after the porch rollback; code unchanged since a2a16745; recorded reviews replayed (iter 1 REQUEST_CHANGES + rebuttal, iter 2 APPROVE).
- phase_7: re-walked after the porch rollback; code unchanged since a2a16745; recorded reviews replayed (iter 1 REQUEST_CHANGES + rebuttal, iter 2 APPROVE).

The consultation override used along the way (`modelsByType`) was removed before phase 8; `.codev/config.json` is untracked and back to `models: codex, gemini`.

### Phase 8, step 1: `0001` applied nowhere (T12), 2026-10-30

The owner, who operates staging, wrote (relayed verbatim by the security architect on 2026-10-30): "nothing has been executed against staging as we didn't merge yet."

Applying `0001` to staging is the pre-merge step, and the merge has not happened, so `0001` was never applied to staging. Production has nothing applied (its cutover has not run). The two read-only queries main asked for (`auth-journal.mjs check` against staging, and a direct look for `auth.apikey` and `auth.users.phone_number`) were **not run**, because the apply step itself never ran; the security architect accepted the owner's record on that basis. Decision: `0001` is regenerated in place as `0001_api_key`, with no `phone_number`. The `0002` fallback is not needed.

### Owner amendment 1 (phone-number plugin, claiming by number): withdrawn, the record

On 2026-10-30 the owner folded better-auth's phone-number plugin and claiming an account by phone number into this project (spec amendment 1, commits 1d84f91d and ca1452db; plan phase 8, d3b92b00). Porch rolled back from review to plan. Codex's plan consult (iteration 2) and the security architect's own review and external round (Codex and Claude, both REQUEST CHANGES) then found that the plan could not be built safely as asked. The security architect's 20 findings are in `codev/projects/329-*/329-plan-iter2-input-security-T1-T20.md`, the external texts in `329-plan-iter2-input-s5-{codex,claude}.md`.

The blocking one, T1, was confirmed by probe before anything was built. With the plugin enabled and a placeholder sender that throws:
- `send-otp` stores a live code before the sender fails;
- `verify` with that code creates a session;
- phone sign-in never calls the sender;
- reset-by-phone stores a code without the sender, and with it creates a password on an account that had none.

A before hook on the five paths closes all of them. The owner then withdrew the amendment: "we don't need to deal with this complexity for now, change of plans, drop phone number entirely, whatsapp id is enough". That became amendment 2 (spec §5): no phone number stored at all, `phone_number` accepted and ignored. Of the 20 findings only T12 carries into it (verify that `0001` is applied nowhere, with `0002` as the fallback).

Probe output (`packages/auth/scripts/probes/phone-plugin-probe.ts`, better-auth 1.7.7, in-memory adapter, run 2026-10-30; the session token in `verify`'s body is redacted; the script itself is not committed, since amendment 2 has no plugin):

```
== A: plugin enabled, no short-circuit
send-otp (known): 500  | writes: user.create.before,sendOTP called | rows before {"user":1,"session":0,"account":1,"verification":0} after {"user":1,"session":0,"account":1,"verification":1}
  a verification row for the number exists after the sender threw: true
verify (known, the stored code): 200 {"status":true,"token":"<redacted>","u | set-cookie: true | sessions 0 -> 1 | hooks: user.update.before
sign-in/phone-number (known, right password): 200 | set-cookie: true | sendOTP called: false
sign-in/phone-number (unknown): 401 {"message":"Invalid phone number or password","code":"INVALID_PHONE_NUMBER_OR_PASSWORD"}
sign-in/phone-number (known, wrong password): 401 {"message":"Invalid phone number or password","code":"INVALID_PHONE_NUMBER_OR_PASSWORD"}
request-password-reset known: 200 {"status":true} | unknown: 200 {"status":true} | verification rows 0 -> 2 | sendOTP called: false
send-otp unknown: 500  | known was: 500 
== A2: reset-password on a user with no credential row
reset-password with the stored code: 200 {"status":true} | accounts whatsapp -> whatsapp,credential
== B: a before hook that throws on the five paths
/phone-number/send-otp: known 400 {"message":"Invalid request"} | unknown 400 {"message":"Invalid request"} | set-cookie false
/phone-number/verify: known 400 {"message":"Invalid request"} | unknown 400 {"message":"Invalid request"} | set-cookie false
/sign-in/phone-number: known 400 {"message":"Invalid request"} | unknown 400 {"message":"Invalid request"} | set-cookie false
/phone-number/request-password-reset: known 400 {"message":"Invalid request"} | unknown 400 {"message":"Invalid request"} | set-cookie false
/phone-number/reset-password: known 400 {"message":"Invalid request"} | unknown 400 {"message":"Invalid request"} | set-cookie false
rows before {"user":1,"session":0,"account":1,"verification":1} after {"user":1,"session":0,"account":1,"verification":1} | sendOTP called: false | hooks: user.create.before
== C: plugin endpoints
signInPhoneNumber:/sign-in/phone-number sendPhoneNumberOTP:/phone-number/send-otp consumePhoneNumberOTP:(no path) verifyPhoneNumber:/phone-number/verify requestPasswordResetPhoneNumber:/phone-number/request-password-reset resetPasswordPhoneNumber:/phone-number/reset-password
```

### Main's item B: `copy.sh --dry-run` against an empty auth database (real Postgres 18), 2026-10-28

Two throwaway `postgres:18` containers on loopback: the app database migrated through apps/api's `0010` with two seeded legacy users, and an empty auth database. `copy.sh --dry-run --allow-local` was run under a pseudo-terminal (it refuses a redirected stdout). The notice comes from inside the rolled-back transaction. `0001_api_key_phone` is reported applied only when every object its SQL creates exists, and that includes `auth.apikey` and `auth.users.phone_number` (the generated check names `to_regclass('"auth"."apikey"')` and `column_name = 'phone_number'`). After the run, the auth database has no `auth` schema and no tables.

```
== auth database before: schemas named auth = 0
== copy.sh --dry-run --allow-local
copy.sh: LOCAL TEST RUN (--allow-local): loopback databases only; the Tailscale forwarder host check is skipped
copy.sh: WARNING: APP_DATABASE_URL carries no sslmode=require (runbook step 1 records whether TLS is offered through the forwarder)
copy.sh: WARNING: AUTH_DATABASE_URL carries no sslmode=require (runbook step 1 records whether TLS is offered through the forwarder)
copy.sh: DRY RUN: the copy runs in one transaction and is rolled back; nothing is committed
copy.sh: DRY RUN: the auth database has no schema; the whole auth journal (_journal.json order) is applied inside the transaction and rolled back with it
copy.sh: dry run: copying 2 non-system user(s) (app → auth)
psql:/dev/fd/9:149: NOTICE:  auth journal check: applied inside this transaction: 0000_auth_schema, 0001_api_key_phone
copy.sh: dry run: rolled back; the auth database is as it was
copy.sh: auditing
-- app
rows|2
id_checksum|e455da112cf76f48cf8a3955e023acfc
email_checksum|d747e16f0846f0586fb4ea0bf2ac688c
hash_checksum|12acf6c898b966091e96498568cb87e6
credentials|2
system_domain_rows|0
-- auth
rows|2
id_checksum|e455da112cf76f48cf8a3955e023acfc
email_checksum|d747e16f0846f0586fb4ea0bf2ac688c
hash_checksum|12acf6c898b966091e96498568cb87e6
credentials|2
system_domain_rows|0
copy.sh: dry run audit OK (nothing committed)
copy.sh exit=0
== auth database after: schemas named auth = 0, tables outside the catalogs = 0
```

### Main's item A: the runbook's journal apply and check (real Postgres 18), 2026-10-28

The two commands from `better-auth-cutover.md` step 5 and `deploy-guide.md` step 3, against a fresh empty auth database, then a negative (the objects of `0001` dropped):

```
$ (empty auth database) tables outside the catalogs: 0
$ for f in $(node apps/auth/scripts/cutover/auth-journal.mjs files); do psql ... --single-transaction -f "$f" || break; done
  applying packages/auth/drizzle/0000_auth_schema.sql
  applying packages/auth/drizzle/0001_api_key_phone.sql
$ node apps/auth/scripts/cutover/auth-journal.mjs check | psql "$AUTH_DATABASE_URL" -X -q -At -v ON_ERROR_STOP=1
0000_auth_schema|t
0001_api_key_phone|t
exit=0
$ (negative) drop auth.apikey and auth.users.phone_number, then the same check
0000_auth_schema|t
0001_api_key_phone|f
ERROR:  auth journal check: not applied: 0001_api_key_phone
exit=3
```

### Secret scan (gitleaks), review phase, 2026-10-28

Pinned gitleaks 8.24.3, the repo's `.gitleaks.toml`, over the branch's history at 5ce51d8:
`gitleaks git --log-opts=origin/develop..HEAD --config <worktree>/.gitleaks.toml --redact=90 <worktree>`.

```
8.24.3
INF 94 commits scanned.
INF scanned ~767236 bytes (767.24 KB) in 444ms
INF no leaks found
exit=0
```

Negative control: the same scan with only the two spec 329 allowlist entries removed exits 1 with exactly the four
findings CI reported, all in history and none at the tip (`grep` for either literal over `packages`, `apps`, `docs`
and `codev` at the tip: 0 hits):

```
generic-api-key packages/auth/scripts/probes/probe-db.ts 69 90aff8c
generic-api-key packages/auth/scripts/probes/probe-db.ts 76 90aff8c
generic-api-key packages/auth/scripts/probes/exchange-lock-probe.ts 240 427f8fd
generic-api-key packages/auth/scripts/probes/exchange-lock-probe.ts 247 427f8fd
```

The probes were rerun after `setProbeEnv` moved to `setAuthEnv`: `library-probes.ts` on Postgres 18, 5/5 steps as expected.

### Probe outputs

#### Phase 1: probe 4 (real Postgres), 2026-10-28

Run against a throwaway `postgres:18` container on 127.0.0.1 with
`packages/auth/scripts/probes/exchange-lock-probe.ts` (moved from the plan's
`apps/auth/scripts/probes/` because apps/auth has no direct `pg` / `drizzle-orm`
dependency). The `pg` deprecation warning comes from clients left checked out by
the deliberately hung E2 run.

```
Probe 4 against Postgres 18.6 (Debian 18.6-1.pgdg13+2) at 127.0.0.1 (2026-10-28T06:04:19.563Z)
PASS  A same-transaction session insert under FOR NO KEY UPDATE: committed without waiting; 1 session
PASS  B concurrent ban waits for the exchange, then deletes its session: ban waited: true; ban finished after exchange commit: true; sessions left: 0
PASS  C session insert from another connection does not wait on FOR NO KEY UPDATE: insert completed while the lock was held
PASS  C' contrast: FOR UPDATE blocks another connection's session insert (the hazard): other connection's insert: 57014 (57014 = cancelled by statement_timeout, i.e. it waited)
PASS  D lock_timeout turns a held lock into 55P03: waiting exchange got: 55P03
(node:76887) DeprecationWarning: Calling client.query() when the client is already executing a query is deprecated and will be removed in pg@9.0. Use async/await or an external async flow control mechanism instead.
(Use `node --trace-deprecation ...` to show where the warning was created)
PASS  E1 signing AFTER commit, pool max 2: 10/10 finished
PASS  E2 signing INSIDE the transaction, pool max 2, no connect timeout: deadline: the run HUNG (10000 ms), as expected for signing inside
PASS  E2 signing INSIDE the transaction, pool max 2, connect timeout 2000 ms: 1/10 finished; failures: Error (loud failure, no hang)
8/8 steps as expected.
```

#### Phase 1: pinning probes (pglite, `packages/auth/tests/config/api-key.test.ts`)

All green (16 tests):
- Probe 1: a script-created key verifies; the raw key appears in no column; `start` is null; `key` equals `defaultKeyHasher(raw)`; permissions and metadata round-trip; no expiry.
- Probe 1b: `auth.api.updateApiKey` server-side changes `rateLimitMax`, the window and the refill, enforced at the next verify.
- Probe 2: `auth.api.signJWT` with explicit `{sub, sid, iat, exp}` has the same claim keys, `alg`, `iss`, `aud` and lifetime as a `/api/auth/token` JWT, and honours the passed `exp`. Without `iat`, the claim set lacks `iat`.
- Probe 4a: `phone_number` is absent from the sign-in and get-session responses. Sign-up with `phone_number` is **refused** with 400 `{"message":"phone_number is not allowed to be set","code":"FIELD_NOT_ALLOWED"}` and nothing is stored (the spec allowed refused or ignored).
- Session-token probe: `internalAdapter.createSession` writes a 32-character `[A-Za-z0-9]` token; `generateRandomString(32, 'a-z', 'A-Z', '0-9')` from `better-auth/crypto` produces the same shape (without the explicit alphabet it also emits `-` and `_`).
- Plugin behaviours: no-refill exhaustion deletes the key; refilled exhaustion refuses and keeps it, and verifies after the interval (both cycles); the window limit refuses and keeps; disabled is refused and kept; expired is refused and deleted; a wrong permission spends no budget; a key is never a session at `/get-session` or `/token`.

**Gates:** before phase 4 (probes 1, 1b) and before phase 5 (probes 2, 4a, session token, probe 4): all match the plan.

#### Gate before phase 5: rerun on real Postgres, 2026-10-28

At the security architect's request, every gate-before-phase-5 probe was rerun
on real Postgres (a fresh `postgres:18` container on 127.0.0.1) before any phase 5
code, with the output pasted verbatim. Probes 2, 4a and the session-token probe
had only run on pglite; `packages/auth/scripts/probes/library-probes.ts` now runs them
against Postgres too. It prints claim names, headers and shapes, never a token.
The setup shared with probe 4 (URL guard, schema reset, env) moved to
`packages/auth/scripts/probes/probe-db.ts`. Both scripts are run as
`pnpm --filter ansari-auth exec tsx ../../packages/auth/scripts/probes/<script>.ts postgres://postgres:probe@127.0.0.1:55432/postgres`.

Probes 2, 4a and session token:

```
Probes 2, 4a and session token against Postgres 18.6 (Debian 18.6-1.pgdg13+2) at 127.0.0.1 (2026-10-28T08:12:18.312Z)
PASS  2 signJWT({sub, sid, iat, exp}) matches a /api/auth/token JWT; the passed exp is honoured
      /token  header {"alg":"EdDSA","kid":"5dcdae02-16d0-45b1-ae45-a4a5f2bc2ce4"}  claims [aud,exp,iat,iss,sid,sub]
      signJWT header {"alg":"EdDSA","kid":"5dcdae02-16d0-45b1-ae45-a4a5f2bc2ce4"}  claims [aud,exp,iat,iss,sid,sub]
      iss: /token https://auth.probe.example | signJWT https://auth.probe.example
      aud: /token ansari-api-probe | signJWT ansari-api-probe
      exp - iat: /token 900 s | signJWT 900 s
      sub = user id: true; sid = session id: true
      passed exp 1793176038 -> signed exp 1793176038; passed iat 1793175138 -> signed iat 1793175138
PASS  2 without iat the claim set differs (why the exchange passes it)
      signJWT({sub, sid}) claims [aud,exp,iss,sid,sub]
PASS  4a sign-up with phone_number is refused or ignored, and nothing is stored
      sign-up status 400, body {"message":"phone_number is not allowed to be set","code":"FIELD_NOT_ALLOWED"}
      users rows for the email: 0; phone_number stored: null
PASS  4a with phone_number set in the row, it is absent from sign-in and get-session
      sign-in 200: user keys [banExpires,banReason,banned,createdAt,email,emailVerified,first_name,id,image,last_name,name,registered_via,role,updatedAt]; contains the number: false; contains "phone": false
      get-session 200: user keys [banExpires,banReason,banned,createdAt,email,emailVerified,first_name,id,image,last_name,name,registered_via,role,updatedAt]; contains the number: false; contains "phone": false
PASS  session token: generateRandomString(32, a-z, A-Z, 0-9) has the shape createSession writes
      createSession row token: length 32, matches ^[A-Za-z0-9]{32}$: true
      generator, 1000 samples: all match: true; distinct characters seen: 62 of 62
      without the explicit alphabet, 200 samples contain '-' or '_': true

5/5 steps as expected.
```

Probe 4 (the refactored script, same steps as the phase 1 run):

```
Probe 4 against Postgres 18.6 (Debian 18.6-1.pgdg13+2) at 127.0.0.1 (2026-10-28T08:12:23.915Z)
PASS  A same-transaction session insert under FOR NO KEY UPDATE: committed without waiting; 1 session
PASS  B concurrent ban waits for the exchange, then deletes its session: ban waited: true; ban finished after exchange commit: true; sessions left: 0
PASS  C session insert from another connection does not wait on FOR NO KEY UPDATE: insert completed while the lock was held
PASS  C' contrast: FOR UPDATE blocks another connection's session insert (the hazard): other connection's insert: 57014 (57014 = cancelled by statement_timeout, i.e. it waited)
PASS  D lock_timeout turns a held lock into 55P03: waiting exchange got: 55P03
(node:5862) DeprecationWarning: Calling client.query() when the client is already executing a query is deprecated and will be removed in pg@9.0. Use async/await or an external async flow control mechanism instead.
(Use `node --trace-deprecation ...` to show where the warning was created)
PASS  E1 signing AFTER commit, pool max 2: 10/10 finished
PASS  E2 signing INSIDE the transaction, pool max 2, no connect timeout: deadline: the run HUNG (10000 ms), as expected for signing inside
PASS  E2 signing INSIDE the transaction, pool max 2, connect timeout 2000 ms: 1/10 finished; failures: Error (loud failure, no hang)

8/8 steps as expected.
```

The pglite pinning tests for the same probes, run in the same session:
`tests/config/api-key.test.ts` 16/16 passed.

**Gate before phase 5:** probe 2 (claim set, `alg`, `iss`, `aud` and the 900 s lifetime equal
`/api/auth/token`'s; the passed `exp` and `iat` are honoured; without `iat` the claim set lacks it),
probe 4a (refused 400 `FIELD_NOT_ALLOWED`, nothing stored, absent from sign-in and get-session),
the session-token probe, and every step of probe 4 (A, B, C, C', D, E1, E2 ×2) match the plan.

#### Phase 1: blocked-path prefix proven load-bearing

With `API_KEY_PREFIX` removed from the middleware, the variant and absolute-form tests fail (2 failed); restored, all pass.

#### Phase 1: green command, and a pre-existing timeout under combined load

The plan's green command, run in sequence (`pnpm turbo run test --force`, then `typecheck --force`, then `lint --force`), passes. Running all three as **one** parallel turbo invocation (`turbo run test typecheck lint --force`, 15 tasks at once) times out pglite `beforeAll` hooks at 30 s. It happened twice on this branch, both times in `@ansari/auth`. It also happens on a clean baseline worktree of this branch's HEAD (no code changes), there in `ansari-auth` (`secrets.test.ts`, `cutover/copy.test.ts`). It is the load-induced class `vitest.config.ts` already records (#290/#292), not something this change introduced. This phase's extra pglite file adds load, so CI's task grouping is worth watching.

#### Phase 2: redacted logger

- The logger probe matches the plan (gate before phase 6). With `auth.apikey` dropped, `verifyApiKey` returns `valid: false` with `INVALID_API_KEY`, the same code as an unknown key, and the logged arguments contain no Error object, include the code `42P01`, and never carry the driver message ("does not exist") or the key.
- Proven both ways: with `logger: { disabled: true }` the non-error survival test and the outage test fail; with better-auth's default (unredacted) logger they fail too; with the redacted logger they pass.
- Real pg server errors carry `name: 'error'` (node-postgres sets it from the protocol message type), so a raw pg error is logged as `{ name: 'error', code }`.
- Residual: messages are not rewritten. The better-auth paths this service runs pass errors as arguments; the few that interpolate an error into the message string (OAuth discovery, token introspection) are not configured.
- No existing test asserted better-auth log output, so none needed editing.

#### Phase 5: probe 4 rerun against the real functions (real Postgres), 2026-10-28

Steps A to E unchanged; F1 to F4 drive `resolveOrCreateWhatsappUser` and
`issueWhatsappToken` themselves, on a pool of 2 with a 2 s connect timeout, against a fresh
`postgres:18` container. The first run showed F3 as `Error` after 2017 ms: the
probe's own reader took the top-level code, and drizzle wraps the driver error, so
the SQLSTATE is on `cause`. The reader was fixed (the route in phase 6 reads it the same
way, as `redactError` does) and the run repeated:

```
Probe 4 against Postgres 18.6 (Debian 18.6-1.pgdg13+2) at 127.0.0.1 (2026-10-28T08:29:35.379Z)
PASS  A same-transaction session insert under FOR NO KEY UPDATE: committed without waiting; 1 session
PASS  B concurrent ban waits for the exchange, then deletes its session: ban waited: true; ban finished after exchange commit: true; sessions left: 0
PASS  C session insert from another connection does not wait on FOR NO KEY UPDATE: insert completed while the lock was held
PASS  C' contrast: FOR UPDATE blocks another connection's session insert (the hazard): other connection's insert: 57014 (57014 = cancelled by statement_timeout, i.e. it waited)
PASS  D lock_timeout turns a held lock into 55P03: waiting exchange got: 55P03
(node:45541) DeprecationWarning: Calling client.query() when the client is already executing a query is deprecated and will be removed in pg@9.0. Use async/await or an external async flow control mechanism instead.
(Use `node --trace-deprecation ...` to show where the warning was created)
PASS  E1 signing AFTER commit, pool max 2: 10/10 finished
PASS  E2 signing INSIDE the transaction, pool max 2, no connect timeout: deadline: the run HUNG (10000 ms), as expected for signing inside
PASS  E2 signing INSIDE the transaction, pool max 2, connect timeout 2000 ms: 1/10 finished; failures: Error (loud failure, no hang)
PASS  F1 real functions: 10 concurrent exchanges for one new BSUID: distinct users: 1; distinct sids: 1; whatsapp rows: 1; sessions: 1
PASS  F2 real functions: another connection's open session insert does not block the exchange: exchange outcome while the insert was open: issued
PASS  F3 real functions: a held ban update fails the exchange with 55P03 within its lock_timeout: exchange got 55P03 after 2013 ms (lock_timeout 2000 ms); after the ban committed: banned
PASS  F4 real functions: 10 concurrent new users on a pool of 2 (sign after commit): 10/10 issued

12/12 steps as expected.
```

#### Phase 6: production-shaped outage run (real Postgres), 2026-10-28

`apps/auth/scripts/probes/exchange-outage-probe.ts`: apps/auth's real app with `NODE_ENV=production` and the real node-postgres pool (`AUTH_POOL_MAX` 10, 5 s connect timeout) against a `postgres:18` container started without `--rm`, which the probe stops and starts under the running service. Command:

```
docker run -d --name probe-pg-329-outage -e POSTGRES_PASSWORD=probe -p 55433:5432 postgres:18
pnpm --filter ansari-auth exec tsx scripts/probes/exchange-outage-probe.ts postgres://postgres:probe@127.0.0.1:55433/postgres probe-pg-329-outage
docker rm -f probe-pg-329-outage
```

Output, verbatim:

```
Postgres 18.6 (Debian 18.6-1.pgdg13+2); container probe-pg-329-outage
PASS  1a boot assertion, schema present: assertSchema → true
PASS  1b new BSUID, valid key: 200 in 80 ms (expected 200)
whatsapp exchange failed: { name: 'Error', code: '55P03' }
PASS  2  user row held FOR UPDATE elsewhere: 500 in 2027 ms (expected 500 within lock_timeout 2000 ms + slack)
[Better Auth] ERROR: Failed to validate API key: { name: 'APIError' }
PASS  3a unknown key, database up (primes the relation check): 401 in 9 ms (expected 401)
      docker stop probe-pg-329-outage
auth database: idle client error { name: 'error', code: '57P01' }
auth database: idle client error { name: 'error', code: '57P01' }
[Better Auth] ERROR: Failed to validate API key: { name: 'Error', code: 'ECONNREFUSED' }
PASS  3b unknown key inside APIKEY_RELATION_CHECK_TTL (stated residual): 401 in 7 ms (expected 401 or 500)
[Better Auth] ERROR: Failed to validate API key: { name: 'Error', code: 'ECONNREFUSED' }
whatsapp exchange failed: { name: 'Error', code: 'ECONNREFUSED' }
PASS  3c valid key after the TTL: 500 in 5 ms (expected 500)
[Better Auth] ERROR: Failed to validate API key: { name: 'Error', code: 'ECONNREFUSED' }
whatsapp exchange failed: { name: 'Error', code: 'ECONNREFUSED' }
PASS  3d unknown key after the TTL: 500 in 5 ms (expected 500)
auth boot: schema check failed, starting anyway { name: 'Error', code: 'ECONNREFUSED' }
PASS  4  boot assertion, database down: assertSchema → true (expected true: start, /health reports)
health: auth database unreachable Error
PASS  4b /health with the database down: 503
      docker start probe-pg-329-outage
health: auth database unreachable Error
PASS  5a /health recovers without a restart: 200
PASS  5b valid key after recovery: 200 in 31 ms (expected 200)
[Better Auth] ERROR: Failed to validate API key: { name: 'APIError' }
PASS  5c unknown key after recovery: 401 in 5 ms (expected 401)
ALL PASS
```

Read: after `APIKEY_RELATION_CHECK_TTL` both keys get 500, never 401 (3c, 3d); inside it the unknown key gets the stated 401 residual (3b). A user row held `FOR UPDATE` from another connection is a 500 at 2027 ms (`55P03`, the 2 s `lock_timeout`), not a hang (2). Every log line is `{name, code}`. Boot with the database down starts (4) and `/health` recovers without a restart (5a). The plan's "a lock held from another connection → 500 within the timeout" is owned by this run, since pglite has one connection.

### Phase 3: reserved noreply domain (notes)

- **Spec wording versus the guard order:** the spec's "sign-up with a noreply address (any case, surrounding spaces) returns the 409 body". Validation runs first in `signUpGuard`, so an address with surrounding spaces is an invalid email (400) for every address, reserved or not. The test asserts what holds: a noreply address and a taken address answer identically, padded or not (409 unpadded, 400 padded). There is still no oracle.
- Negative-tested: with the noreply domain removed from `isReservedAddress`, 8 tests go red.
- Green per package (`@ansari/auth` 220, `ansari-auth` 263, `ansari-api` 1113 + 3 skipped); typecheck and lint pass at the root. The root test run on the shared machine (load average 92/74/60 at the time) failed only with timeouts (27 hook, 6 test), across all four packages including the untouched frontend: the monorepo-wide matter recorded under Flaky Tests.

### Phase 4: service users and key operator scripts (notes)

- **Design decisions within the plan:**
  - `create-service` has no user yet, so its `--confirm` takes the service name (`--confirm whatsapp`). Every other write confirms with the service user's id.
  - The window flag is in seconds (as every rule in `limits.ts` is) and stored in milliseconds (as the plugin stores it). The budget is `--daily` and always refills every 24 h. A bare budget cannot be expressed: `--remaining` is refused at the command line, and `checkKeyLimits` refuses a budget without `KEY_REFILL_INTERVAL` before the plugin is called.
  - `update-limits` also sets `remaining` to the new daily budget: the new budget starts now.
  - `rotate` refuses when the service has no live key (use `create-key`). It prints the old key ids and the exact revoke commands.
  - `create-service` also sends a Sentry event. The spec names create, rotate and revoke, and the plan adds update-limits. A service user is a durable change too, so every write is recorded.
  - Exit codes: 0 done, 1 refused or failed, 2 nothing written (show step, confirm mismatch), 3 written but its Sentry record not sent (banner). Without `SENTRY_DSN`, `Sentry.flush` has no client and returns false, so every write exits 3 with the banner. That is loud on purpose.
  - The script prints `Auth database: <hostname>:<port>` first on every subcommand, list included. `urlHost` moved to `apps/auth/scripts/url-host.ts` beside the new `urlHostPort`.
  - `ansari-mcp` borrows `WHATSAPP_KEY_BOUNDS` until #314 sizes its own.
- **The plan's leak test, adjusted:** the plan's URL `postgres://user:secret@db.example:6543/auth?sslmode=require` asks that the output contain none of `user`, `secret` and `sslmode`. The script's own words say "user" ("Service user for whatsapp"), so the test asserts `user:secret`, `secret`, `sslmode`, `/auth?` and `postgres://` absent. A second URL with distinctive userinfo, path and query (`opsname-zq`, `pw-zq-9`, `authdb-zq`, `verify-full`) shows that none of them is echoed. "secret" did catch one real wording problem: the handoff line said "secret store", and now says "credential store".
- **apps/api's source scan (scan 2) caught a literal database URL** in the first draft of the demo harness. The harness now uses the placeholder URL `setAuthEnv` puts in `DATABASE_URL`, and derives its leak checks from the parsed URL. The scan's exclusion list is unchanged.
- **Negative-tested** (`apps/auth/tests/service-keys.test.ts`, 73 tests). Each mutation was applied to the script alone and then reverted:

  | Mutation | Tests red |
  |---|---|
  | raw key printed twice | 3 |
  | database URL appended to the host line | 6 |
  | Sentry flush not awaited | 3 |
  | revoke leaves `enabled = true` | 1 |
  | refill interval not checked | 1 |

- **Runnable harness** (`pnpm --filter ansari-auth exec tsx scripts/probes/service-keys-demo.ts`, pglite from the journal). It runs every subcommand in the runbook's order, including a confirm mismatch, an out-of-bounds update and an expiry flag. Run 2026-10-28, summary of its 13 steps:

  ```
     7 (exit 0)
     2 (exit 1)
     4 (exit 2)
    13 Auth database: localhost:5432
     1 CHECK database printed as hostname:port only: PASS
     1 CHECK two keys created, each printed once: PASS
  ```

- **Review iteration 1 (Codex, REQUEST_CHANGES):** the first version buffered every line and printed them after the run, so the database host reached the screen only after the write. Each line is now printed as it is produced, and the host line is printed before the script connects. The per-subcommand host test asserts the call order (`print` before `connect`). Restoring the buffered printing turns 6 tests red. The Gemini lane was skipped (its CLI exited 3).
- **Review iteration 2 (Codex, REQUEST_CHANGES): the raw key could reach Sentry as a breadcrumb.** The script used `initSentry` with Sentry's default integrations and printed with `console.log`. The Console integration records every console line as a breadcrumb, and the breadcrumb trail rides on the next event. The line printed just before the operator event is the raw key. The original test turned default integrations off, and that hid the leak.
  - Fixed two ways, each enough on its own. The script now has its own Sentry options (`SCRIPT_SENTRY_OPTIONS`: `maxBreadcrumbs: 0`, `beforeBreadcrumb` returns null), and it prints through `process.stdout.write`, which Sentry does not instrument.
  - New test, `apps/auth/tests/service-keys-sentry.test.ts`. Default integrations stay ON; only the transport is a spy. The test runs create-key once with the script's printer and once printing through `console.log`.
  - Negative test: with the breadcrumb options removed, the `console.log` case leaks the key and goes red, and the stdout case still passes. So Codex's leak was real, and either guard alone stops it.
  - Lesson: a Sentry test with `defaultIntegrations: false` cannot show what production Sentry sends.
- Green per package: `@ansari/auth` 220 + 1 skipped (the `DEPLOYED_THROUGH` parity check, `null` until the production cutover), `ansari-auth` 338 (after iteration 2), `ansari-api` 1113 + 3 skipped. Root typecheck and lint pass.

### Phase 5: WhatsApp identity and session core (notes)

- `packages/auth/src/whatsapp.ts`: `resolveOrCreateWhatsappUser` (fixed-provider lookup; user and `whatsapp` row in one transaction; a unique violation on `account_provider_id_account_id_unique`, read from the error or its cause, rolls back and returns the winner) and `issueWhatsappToken` (`decideUnderLock` in one transaction, then `signJWT` after the commit). Outcomes are typed: `issued`, `banned`, `ineligible` (with a reason: `accounts`, `address`, `registered_via`, `admin`), `user-gone`. Timeouts, outages and signing failures throw (the route answers 500).
- **Stricter than the spec, recorded:** eligibility requires the address to be exactly `whatsapp-<this user's id>@noreply.askansari.ai`, not just any address under the domain. Nothing legitimate writes another noreply address for a WhatsApp user.
- Lifetimes moved to `src/lifetimes.ts` (`JWT_LIFETIME_SECONDS`, `SESSION_LIFETIME_SECONDS`, `SESSION_UPDATE_AGE_SECONDS`), so `createAuth` and the exchange read one source; `JWT_EXPIRATION` is still `'15m'`, derived. `limits.ts` gains `WHATSAPP_EXCHANGE_PER_USER` (6 per 15 min, in `LONGEST_WINDOW`) and, in ms, `SESSION_MARGIN`, `EXCHANGE_LOCK_TIMEOUT`, `EXCHANGE_STATEMENT_TIMEOUT`.
- `tests/whatsapp.test.ts`, 26 tests on pglite. The session-token pin checks 20 written tokens, not one: a single token from the unrestricted generator lacks `-`/`_` about a third of the time.
- **Mutation-tested**, each red, then restored (26/26 green): dropping the BSUID re-check, dropping the ban's session delete, the unrestricted generator, no margin, no admin check, clearing the phone when absent, and signing inside the transaction. The last one hangs pglite outright (one connection: signJWT waits on the open transaction, the pool-starvation hazard in miniature). It was run again against the source-level block alone, which goes red both for a wrapper that signs inside `db.transaction` and for a `signJWT` inside `decideUnderLock`.
- Verified: @ansari/auth 246 + 1 skipped, ansari-auth 338, root typecheck and lint pass.

### Pre-existing: Sentry request data

Found in phase 6, 2026-10-28; reported to the security architect, who owns the fix as a separate develop PR (not widened here). apps/auth's `Sentry.init` on develop sets only `sendDefaultPii: false`, with default integrations. Sentry's HTTP/request-data integration still attaches the in-flight request to any event raised while a request is handled: its headers, `Authorization` included, and its body.

**Reproduction** (pglite through `startService`, a spy transport, `SERVICE_SENTRY_OPTIONS` as `initSentry` uses them, 40 failed sign-ins so `SIGN_IN_FAILED_ALERT` (30/min) fires once). The test, verbatim, to drop into `apps/auth/tests/` (its own file: the Console integration patches `console` process-wide). `SERVICE_SENTRY_OPTIONS` is new in phase 6; on develop, spread `{ sendDefaultPii: false }` instead:

```ts
// Pre-existing (spec 300): Sentry's request-data integration attaches the
// in-flight request's body and headers to an alert event raised during sign-in.
import * as Sentry from '@sentry/node';
import { afterAll, expect, it } from 'vitest';

import { SERVICE_SENTRY_OPTIONS, sendFailedSignInAlert } from '../src/alerts';
import { signIn, signUp, startService, type Service } from './helpers/service';

const envelopes: unknown[] = [];
let service: Service | undefined;

afterAll(async () => {
  await service?.close();
  await Sentry.close();
});

it('a failed-sign-in alert event carries no password and no Authorization header', async () => {
  Sentry.init({
    dsn: 'https://public@o0.ingest.sentry.io/0',
    environment: 'test',
    ...SERVICE_SENTRY_OPTIONS,
    transport: () => ({
      send: async (envelope) => {
        envelopes.push(envelope);
        return {};
      },
      flush: async () => true,
    }),
  });
  service = await startService({ failedSignInAlert: sendFailedSignInAlert });
  await signUp(service, 'probe@example.com');
  // SIGN_IN_FAILED_ALERT is 30 per minute: 40 failures cross it once.
  for (let i = 0; i < 40; i++) {
    await signIn(service, `probe${i}@example.com`, 'ProbePasswordMarker-123', {
      headers: { authorization: 'Bearer SESSIONTOKENMARKER' },
    });
  }
  await Sentry.flush(2000);
  const events = envelopes.map((e) => (e as [unknown, [unknown, { request?: Record<string, unknown> }][]])[1][0][1]);
  process.stdout.write(`EVENTS ${events.length}\n`);
  for (const event of events) process.stdout.write(`REQUEST ${JSON.stringify(event.request)}\n`);
  const text = JSON.stringify(envelopes);
  expect(text).not.toContain('ProbePasswordMarker');
  expect(text).not.toContain('SESSIONTOKENMARKER');
}, 60_000);
```

**Output** (run 2026-10-28 on this branch; `sentry-trace` and `baggage` values elided). One event, and the assertion fails:

```
EVENTS 1
REQUEST {"headers":{"host":"127.0.0.1:53108","connection":"keep-alive","origin":"http://localhost:3100","authorization":"Bearer SESSIONTOKENMARKER","content-type":"application/json","accept":"*/*","accept-language":"*","sec-fetch-mode":"cors","user-agent":"node","accept-encoding":"gzip, deflate","sentry-trace":"…","baggage":"…","content-length":"68"},"method":"POST","url":"http://127.0.0.1:53108/api/auth/sign-in/email","cookies":{},"data":"{\"email\":\"probe29@example.com\",\"password\":\"ProbePasswordMarker-123\"}"}
   × a failed-sign-in alert event carries no password and no Authorization header 5307ms
AssertionError: expected '[[{"event_id":"33cc86cf54ef4943a92f1a…' not to contain 'ProbePasswordMarker'
```

Fields found: `event.request.data`, the whole sign-in body (the **email and the password** of the request that crossed the threshold); `event.request.headers.authorization`, the bearer as sent. The list-walk alert is raised in the same request context, so the same applies to it.

**The exchange's scrub and its negative control** (phase 6, in this PR): `scrubExchangeEvent` (`beforeSend`) reduces an event from `/api/whatsapp/session` to its method and path. `apps/auth/tests/whatsapp-session-sentry.test.ts`, "carry no body, Authorization header, BSUID, phone number or key", passes with it. With `beforeSend` removed from `SERVICE_SENTRY_OPTIONS`, the same test fails: the envelope's `request.headers.authorization` held `Bearer wa_<the raw key>`. The exchange's body was not attached in that run, because the alert fires during the key check, before the body is read; the scrub drops `data` anyway.

### Phase 6: the exchange route, boot assertion and alerts (notes)

- **Route** `apps/auth/src/routes/whatsapp.ts`, mounted ahead of `corsFor`; it answers every request to its path (other methods, `OPTIONS` and sub-paths get a bare 404), so nothing reaches `corsFor`. Order: bearer (missing or malformed → 401 with no query), `verifyApiKey` with `whatsapp: mint`, the relation check on every plugin refusal (cached for `APIKEY_RELATION_CHECK_TTL`), the service-user owner binding, `Content-Type`, `express.json` with `EXCHANGE_BODY_LIMIT` and a route-local error handler, the sanity bounds, resolve, `consumeWindow` on the pool, `issueWhatsappToken`.
- **Boot** `apps/auth/src/boot.ts`, `assertSchema` before `listen()`: refuses only on `42P01` or an empty catalog result. The catalog lookup lives in packages/auth (`hasAuthUniqueConstraint`), because apps/auth has no `drizzle-orm` dependency.
- **Alerts** in `alerts.ts`: per-key window and daily volume read from the verified key row (`requestCount`; `refillAmount − remaining` since `lastRefillAt`). `USAGE_EXCEEDED` / `RATE_LIMITED`, 401 volume, ineligible user and unresolvable service user count in in-process windows of `EXCHANGE_ALERT_WINDOW` (5 min). Events carry numbers, the refusal code and an 8-character sha256 prefix of the key id; the ineligible user's id goes to one `console.warn` line. One constant beyond the plan's list, `EXCHANGE_ALERT_WINDOW`, names that window. The plugin's rate-limit window resets after a gap longer than the window, not on a fixed clock, so the window alert is deduplicated by time since it last fired (one key window).
- **Sentry**: `beforeSend: scrubExchangeEvent`, through the new `SERVICE_SENTRY_OPTIONS` that `initSentry` spreads. The scrub is exchange-only, as planned; the pre-existing leak on other paths is recorded above and owned by the security architect.
- **Tests**: `whatsapp-session.test.ts` (75), `whatsapp-session-sentry.test.ts` (1, with the negative control above), `boot.test.ts` (6), and a route inventory plus a `ROUTER_RULES` pin in `public-face.test.ts`. "User deleted between resolve and lock" over HTTP uses a pglite trigger on the user's `rate_limit` row, which is written after the resolve and before the lock. The lock timeout and the stopped database are the real-Postgres run above.
- **Mutation testing** (12 mutants on the route, app and alerts): 11 red. M2 (relation check before the bearer check) first survived, because a cached check from earlier tests hid the query; the zero-query test now moves the clock past the TTL first, and M2 is red. M7 (no explicit `Content-Type` check) is an equivalent mutant: body-parser 2.x skips a non-JSON body, and the bounds then answer the same 400. The check stays as the plan's explicit guard.
- **Review iteration 1** (Codex, REQUEST_CHANGES): the boot check matched the constraint by name only, and Postgres allows that name on another table. It now binds the table and the exact column order, with three spoofed-constraint tests (red against the old query) and a rerun of the production-shaped probe (13/13). Response in `codev/projects/329-*/329-phase_6-iter1-rebuttals.md`.
- **Verified**: `ansari-auth` 433 tests (430 before review iteration 1), `@ansari/auth` 246 + 1 skipped, root `pnpm typecheck` and `pnpm lint`, `npm run build`. `ansari-api`'s full run had 12 files fail on 30 s hook timeouts at load average about 65; all 12 pass in isolation (95 + 94 tests). Nothing in apps/api changed.

### Phase 7: end-to-end contract test, source scan and documentation (notes)

- **End to end** `apps/api/tests/contract/whatsapp-exchange.test.ts`: the real apps/auth over pglite, a service user and a `wa_` key created in process, an exchange with a BSUID and a phone number, then apps/api's real `GET /api/v2/threads` with the token. 200; the first-use `GET /api/account/me` created `public.users` under the token's `sub` with `whatsapp-<sub>@noreply.askansari.ai` and `registered_via = 'whatsapp'`; a second exchange for the same BSUID reaches the same single row. A dump of every app-database table and both responses contains neither the phone number nor the BSUID. Only the app `db` handle and Sentry are mocked.
- **First-use refusal is system-only** `apps/api/tests/auth/resolve-user.test.ts`: a profile planted as `whatsapp-<id>@noreply.askansari.ai` with `registered_via = 'whatsapp'` is accepted and its row created, with no alert. Mutation: `resolve-user.ts` tightened to also refuse `@noreply.askansari.ai` → this test red (1 failed, 16 passed); restored → 17 passed.
- **Source scan 5** (`apps/api/tests/source-scan/`): `whatsapp`, case-insensitive, comments included, over `apps/api/src/**` and `apps/api/lib/**` by path, tests excluded. Hit count: **0 hits in 65 files**. Negative tests: `if (registeredVia === 'whatsapp') return;` in a fixture path under each scanned directory is caught; the same line at `apps/api/tests/…`, `apps/api/db/…`, `apps/api/library/…`, `apps/auth/src/…` and `apps/whatsapp/lib/…` is not. A real planted file (`apps/api/lib/zz-planted.ts`, one comment line) turned the tree test red (1 hit in 66 files); removed → green.
- **Docs**: `docs/cutover/service-keys-runbook.md` (new), `docs/self-hosting.md` (new section; its Boot checks paragraph corrected: the boot now also checks the schema), `codev/resources/arch.md` (a service-keys paragraph; the first-use refusal stated as system-domain only, with why), `packages/auth/README.md` (`auth.apikey`, `phone_number`, the new constraint, `0001`). Fixed everywhere, as found: `grant-admin.ts` was described as refusing only the system domain in `arch.md` and `RELEASE.md`; it refuses both reserved domains since phase 3.
- **Doc tests**: `cutover-docs.test.ts` gains 10 runbook tests, each reading the code it describes: the script's six subcommands (from `USAGE`), the issuance flags (from `WHATSAPP_KEY_INITIAL`), the six alert kinds (from the `ExchangeAlert` union), the ineligible-user log line verbatim (from `INELIGIBLE_USER_MESSAGE`), the secret-scanning table equal to `SECRET_SCANNING_PATTERNS` `.source`, the key log the script's banner names, and no bare `auth-journal-applied:` line. Negative run: a 63-letter pattern and a deleted `unauthorized-volume` row → 2 red; restored → green. `self-hosting-docs.test.ts` gains 3 (route, script, runbook, `limits.ts` values, migration before code).
- **Key log location** (the spec named it, the plan did not place it): a table at the end of the runbook, appended by PR. Ids are not secrets; the section forbids keys, hashes, BSUIDs and phone numbers.
- **No new environment variable**, four ways: no Zod schema field, no static `process.env.X`, no dynamic `process.env[` and no documented variable were added in this phase (the diff touches tests and docs only). `turbo.json` is unchanged: apps/api's test task already hashes `packages/auth/src/**` (global), `apps/auth/src/**`, `apps/auth/scripts/**` and `docs/**`, which is everything the new tests read.
- **Contract summary** sent to the security architect for the #327 builder (2026-10-28): header, body and bounds, every status and what the consumer does with it, no per-message retry on 500, re-exchange once on an apps/api 401, the spec 321 amendment on #327's branch, and the staging smoke recorded as a comment on PR #327.
- **Green command** (2026-10-28, root `npm test -- --exclude='**/e2e/**'`, exit 0): `ansari-api` 83 files, 1131 passed + 3 skipped (cache miss, executed); `@ansari/auth` 17 files, 246 passed + 1 skipped (`AUTH_DEPLOYED_THROUGH` still `null`, by design; cache miss); `ansari-auth` 16 files, 433 passed (cache hit: no apps/auth or packages/auth source changed this phase); `ansari-frontend` 60 files, 774 passed (cache hit). This time apps/api's full suite ran with no 30 s timeouts. Also: `npm run build` green; apps/api `typecheck` clean and `lint` 0 errors (5 pre-existing warnings).
- **Review iteration 1** (Codex, REQUEST_CHANGES): the docs named `WHATSAPP_KEY_BOUNDS` without its ranges. Both docs now state them, and the tests compute the expected text from the constant (a negative run with a wrong bound in each doc → 2 red). Response in `codev/projects/329-*/329-phase_7-iter1-rebuttals.md`.
- **Review iteration 2**: Codex APPROVE, no issues; the Gemini lane was skipped (agy exit 3, non-blocking).
