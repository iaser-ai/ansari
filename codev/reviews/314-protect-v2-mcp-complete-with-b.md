# Review: Protect `/v2/mcp-complete` with Better Auth API keys issued by apps/auth

## Summary

`POST/GET /api/v2/mcp-complete` now requires `Authorization: Bearer <ansari-mcp key>`. apps/api checks the key on every request at a new public apps/auth route, `POST /api/service/verify-key`. That route is the second consumer of spec 329's api-key plugin. It answers `{valid, client_id, key_id}` or a byte-identical `{valid:false}`. The thread's `client` comes from the key's metadata. A missing or refused key gets 401. An apps/auth outage gets 503: fail closed, nothing persisted, no Gemini call. `MCP_COMPLETE_KEY_MODE=log-only` gives a one-week transition in which every verdict is recorded and every request is served. The work shipped in five plan phases, all on one branch: key rules, verify route, apps/api client and mode, route gate, docs. During the PR review the owner widened the scope (spec Amendments 2 and 3):

- every service key's prefix now names its environment (`ansari_<service>_<ENVIRONMENT>_`);
- apps/api and apps/auth gain an `ENVIRONMENT` variable, which becomes their Sentry environment and is required in production;
- each key route refuses a key labelled for another environment.

## Spec Compliance

- [x] No `Authorization` → 401, no apps/auth call, no thread, no Gemini call, in enforce mode, POST and GET (Phase 4; `apps/api/tests/mcp-complete-key.test.ts` scenario 1).
- [x] Revoked, disabled, expired, exhausted, rate-limited, wrong-permission (WhatsApp) and unknown keys → the same 401 body, no thread, no Gemini call (Phase 2 at the route, Phase 4 through apps/api).
- [x] A valid `ansari-mcp` key → today's behaviour. The thread and its messages carry `client` = the key's `client_id` (Phase 4).
- [x] Forged `X-Ansari-Client` with a valid key → the key's client, one `mcp-complete client mismatch` Sentry warning carrying ids only, request served (Phase 4).
- [x] apps/auth unreachable, timing out (`AUTH_SERVICE_TIMEOUT_MS` 3000), 5xx or a malformed body → 503 within the timeout, nothing persisted, no Gemini call (Phase 3 client, Phase 4 route).
- [x] The verify route answers `{valid:true, client_id, key_id}` or a byte-identical `{"valid":false}`. Any other permission set → 400, with a body that names no permission. A missing `auth.apikey`, a DB outage or an unresolvable service user → 500 (Phase 2).
- [x] A WhatsApp key is refused by permission and by owner, and its `remaining` is not spent, at the route and through apps/api (Phases 2 and 4).
- [x] A key owned by another user that carries `mcp: complete` is refused (Phase 2).
- [x] An `ansari-mcp` key whose `client_id` is missing or not `ansari-mcp*` is refused and raises `client-id-invalid`. The script refuses to create one, and `list` prints each key's `client_id` (Phases 1 and 2).
- [x] `MCP_COMPLETE_KEY_MODE` accepts exactly `log-only` and `enforce`, means `enforce` when absent, and is rejected at production boot for any other value (Phase 3).
- [x] Log-only with apps/auth unreachable → served, verdict `unverified`, Sentry warning (Phase 4).
- [x] Each verify spends one unit of budget. An exhausted key is refused until its daily refill, and the row is kept (Phase 2).
- [x] No CORS headers on any verify response, preflight included (Phase 2: mounted ahead of `corsFor`).
- [x] No raw key, and no substring of its random part, in any response, log line, Sentry event or DB column, in either app. Leak scans cover logs, Sentry transport events and the `apikey` row, using 16-char windows with the prefix exempt (Phases 2 and 4; mutation-checked).
- [x] Log-only records every verdict and serves. Enforce is the behaviour when the setting is absent (Phases 3 and 4).
- [x] pglite tests for the verify route (real plugin, real `auth.apikey`) and for the apps/api route (real app DB, apps/auth answered by a `fetch` stub of the verify contract, real `verifyServiceKey`), including the forged-header and WhatsApp-key cases (Phases 2 and 4).
- [x] Docs (§5): `docs/self-hosting.md`, `docs/cutover/service-keys-runbook.md` (issuance per deployment, Bearer hand-off, rollout, limits, alerts, rotation, plugin-upgrade check), `apps/api/README.md`, `apps/mcp/README.md`, `apps/mcp/.env.example`, the RELEASE.md staging row (Phase 5).
- [x] Amendment 2: one prefix table derives the prefixes, the accepted set, the scanning patterns and the pasted-key check. Existing keys are unchanged; unlabelled keys are accepted during a compatibility window (review phase).
- [x] Amendment 3: `ENVIRONMENT` in both schemas, required in production. Both services refuse to boot without it, shown in tests and in recorded runs:
  - apps/auth exits with "env validation failed for: ENVIRONMENT";
  - apps/api's boot check logs the rule and `/api/health` answers 500.
  `next build` and the auth build pass with it unset. It is the Sentry environment of both services and the prefix segment. Both routes refuse another environment's label, including a staging key presented to a production-configured app (review phase).
- [ ] **Operator steps, outside the repository. Not done by this PR; the owner must do them before enforce:**
  1. Create one key per MCP deployment with `apps/auth/scripts/service-keys.ts` and `--client-id`. That means production `mcp.ansari.chat` (`ansari-mcp`) and `mcp-staging.askansari.ai` (`--client-id ansari-mcp-staging`). The staging key must exist **before apps/api staging deploys this change**, because the default mode is enforce.
  2. Set each Worker's/service's `ANSARI_API_AUTHORIZATION` to `Bearer ansari_mcp_<64 letters>`, prefix included.
  3. Update the published integration snippet and the MCP setup page on the public site. Their locations are still pending from the owner, via the security architect.
  0. Set `ENVIRONMENT=staging` / `ENVIRONMENT=production` on `backend` and auth in each environment **before** this deploys (RELEASE.md), or both services refuse to boot.
  4. Run the rollout: deploy with `MCP_COMPLETE_KEY_MODE=log-only`, watch the `mcp_key_verdict` tag for a week, then remove the variable (enforce). At enforce, open the follow-up that removes log-only and the `turbo.json` hunk one week later.

## Deviations from Plan

- **Phase 1:** none.
- **Phase 2:**
  - The plan named `createKeyAlerts({ service, thresholds, message, tagPrefix, send, now })`. It was built as `createKeyAlerts({ thresholds, keyWindowFloorMs, send, now })` plus `keyAlertSender(message, tagPrefix)`. The behaviour is the same. `keyWindowFloorMs` came from codex iter 2 (MCP window alerts at most once per alert window).
  - Extra file `apps/auth/src/routes/apikey-relation.ts`: the shared `auth.apikey` relation check, now also used by the WhatsApp exchange.
  - **Spec Amendment 1:** the plugin deletes an expired key's row when the key is presented (`validateApiKey`, `@better-auth/api-key` 1.7.7). Spec scenario 2 was amended with the security architect's approval, and the test asserts that the row is gone.
  - Plugin fact: in 1.7.7, `verifyApiKey` returns `metadata` as an object, although it is stored as JSON text. `clientIdOf` handles both forms and is pinned for both.
- **Phase 3:** none in code. The removal follow-up is undated. It opens at enforce (rollout step 6), per the security architect.
- **Phase 4:**
  - The plan named 7 suites to move onto a key. Only 3 call the route: `mcp-complete`, `route-persistence-rollback` and `toolcalls-routes`. `attribution.test.ts`, `rate-limit.test.ts`, `facilitator-empty-final.test.ts` and `tests/sentry/request-envelopes.ts` test helpers directly and were left unchanged. The plan placed the MCP attribution cases in `attribution.test.ts`, but they lived in `mcp-complete.test.ts` and were rewritten there.
  - The Bearer scheme is case-insensitive, as the plan says. apps/auth's account `bearerOf` is case-sensitive. The two differ deliberately and are not unified here.
  - Scenario 11 (mode parsing, boot refusal) is covered by Phase 3's config and boot-check tests. Scenario 13 is covered at the seam.
  - Security architect order (04:10Z): `alerts.keyVerified()` moved after the owner and client-id checks in `service-verify.ts`, so only a served key counts toward the volume alerts. A test pins the order and fails under the old one. The WhatsApp exchange order is unchanged.
- **Phase 5:** rebased onto develop (#365, #368, #370) first. #366 had changed the attribution link to `askansari.ai`, so scenario 4's expectation followed it in its own commit. Architect orders added the `mcp-staging` key, the `Bearer` form in all three apps/mcp docs, and the RELEASE.md staging row.
- **Review (PR consult):** the route checks the bearer token's shape (printable ASCII, 1–256 characters, apps/auth's bound) before calling apps/auth. The plan's bearer rule (one token, no whitespace) let an over-long or non-ASCII token through, and apps/auth's 400 turned it into a 503.
- **Owner directive (2026-11-12, via main): no code reads `RAILWAY_*` variables, only our own names.** `RAILWAY_ENVIRONMENT` is gone from `turbo.json` `globalEnv` and from its comment, and nothing in apps/api, apps/auth or packages reads `RAILWAY_*`. (apps/mcp's `RAILWAY_GIT_COMMIT_SHA` fallback belongs to main. The `RAILWAY_ENVIRONMENT_NAME` fixture in `apps/auth/tests/cutover/copy.test.ts` checks that the cutover script ignores Railway's variables.)
- **Review phase, Amendments 2 and 3 (owner, 2026-11-12):** the owner asked on the PR why the MCP client needed special handling, then directed that every service key's prefix carry its environment.
  - The first design took the environment from an `--env` flag, with routes that would never compare the label to their own environment.
  - The owner then directed an `ENVIRONMENT` variable (Amendment 3). With it, the script reads the environment from its process env, the label is the environment's own name, and each route compares the prefix to its own environment. That turns the label into real hardening.
  - Built as review-phase commits on #372, on the security architect's porch route; the plan addendum lists the steps.
- **`turbo.json`:** this PR carries the `MCP_COMPLETE_KEY_MODE` `globalEnv` hunk, on main's instruction. Main reviews it on the PR.

## Consultation Feedback

### Specify (Round 1)

#### Codex (REQUEST_CHANGES)
- **Concern**: open-tier decision unresolved → **Addressed**: the spec proceeds on (a) "close", with (b) still specified. The owner approved (a) at the spec gate.
- **Concern**: `key_id` missing in apps/api test 4 → **Addressed**: both fields are always present. A `valid:true` that lacks one is malformed (503).
- **Concern**: service-user lookup order → **Addressed**: the lookup runs only after the plugin accepts the key.
- **Concern**: the "no prefix in any column" rule conflicted with `apikey.prefix` → **Addressed**: the rule now covers the random part only, and the prefix is exempt.
- **Concern**: byte and key bounds, and the `client_id` alert contract → **Addressed**: 1 KiB body, 1–256 printable ASCII key, `client-id-invalid` alert.

#### Gemini (COMMENT)
- **Concern**: `list` does not print `client_id` → **Addressed**.
- **Concern**: semantics of the client-mismatch warning → **Addressed**: the header is parsed alone, one warning, ids only.
- **Concern**: error envelope → **Addressed**: `{error:'Unauthorized'}` and `{error:'Authentication service unavailable'}`.
- **Concern**: runtime type of `metadata` → **Addressed**: apps/auth test 15.
- **Concern**: log-only latency on an apps/auth timeout → **Addressed**: noted in §3 as accepted for the transition week.

### Plan (Round 1)

#### Codex (REQUEST_CHANGES)
- **Concern**: apps/auth has no `@ansari/types` dependency → **Addressed**: re-exported through `@ansari/auth`.
- **Concern**: `packages/types` has no test runner → **Addressed**: tested in `packages/auth` and again in apps/api.
- **Concern**: Phase 4 must stub `fetch`, not mock `verifyServiceKey` → **Addressed**.

#### Gemini (APPROVE, with notes)
- **Concern**: `service-keys.test.ts` `ansari-mcp` call sites need `--client-id` → **Addressed** in Phase 1.
- **Concern**: the `cutover-docs.test.ts` section scans → **Addressed**: the MCP material sits under its own `##` heading with `###` subsections.
- **Concern**: Sentry `client` tag parity on a valid key → **Addressed**.

### Phase 1 (Round 1)
No concerns raised. Codex and Gemini approved.

### Phase 2 (Rounds 1–3)

#### Codex
- **Round 1, REQUEST_CHANGES**: an expired key's row is deleted, but scenario 2 said it is kept → **Addressed** by spec Amendment 1. This is a plugin fact. The test asserts the deletion, so a plugin change in either direction fails loudly.
- **Round 2, REQUEST_CHANGES**: `key-window-volume` can fire every 60 s key window, up to 5× per alert window → **Addressed**: `keyWindowFloorMs` = `EXCHANGE_ALERT_WINDOW` for MCP, with a mutation-checked unit test.
- **Round 3**: APPROVE.

#### Gemini
No concerns raised. Approved in all three rounds.

### Phase 3 (Rounds 1–2)

#### Codex
- **Round 1, REQUEST_CHANGES**: `docs/self-hosting.md` said that an unreachable apps/auth gives 503 in both modes → **Addressed**: log-only serves and records `unverified`.
- **Round 2**: APPROVE.

#### Gemini
- **Round 1, APPROVE with note**: the same docs sentence → **Addressed** by the same commit. Round 2: APPROVE.

### Phase 4 (Round 1)
- **Codex**: APPROVE, no concerns.
- **Gemini**: APPROVE. Nit: a stale "does not require authentication" test → **Addressed**: replaced with "requires a key → 401".

### Phase 5 (Rounds 1–2)

#### Codex
- **Round 1, REQUEST_CHANGES**: the runbook listed "a key without `Bearer `" as a cause of apps/auth's `unauthorized-volume` alert. It cannot be one, because apps/api classes such a value as `missing` and never calls verify → **Addressed**: the cause was removed and operators are pointed at the apps/api `missing` verdict.
- **Round 2**: APPROVE.

#### Gemini
No concerns raised. Approved in both rounds.

### Review / PR #372 (Round 1)

#### Codex (REQUEST_CHANGES)
- **Concern**: a bearer token over 256 characters, or containing non-ASCII, was sent to apps/auth. apps/auth answered 400, which apps/api reported as a 503 outage instead of a 401 → **Addressed**: apps/api now refuses a token outside apps/auth's `[\x21-\x7E]{1,256}` envelope locally, as `missing` (401, no call). POST and GET tests cover it, including the 256-character bound, and a mutation check confirms the tests catch the old behaviour.
- **Concern**: the phase consultation outputs were untracked → **Addressed**: committed, as other projects do.

#### Gemini
No concerns raised. Approved.

### Review / PR #372 (Round 2)
Codex and Gemini approved with no issues.

### Review / PR #372 (Round 3, after Amendments 2 and 3; run by hand on the security architect's porch route)

#### Codex (REQUEST_CHANGES)
- **Concern**: keys from before the 2026-10-30 prefix rename (`wa_`) would now be refused with 401, although the runbook says they still verify → **Addressed**: `wa_` joins the compatibility window (`LEGACY_PREFIXES`), with an explicit test written independently of the list and both runbook passages updated.
- **Concern**: the branch was 9 commits behind `develop` → **Addressed**: rebased with no conflicts; develop's changes touch only `apps/mcp/test/*`. Everything passes after the rebase.

#### Gemini
- First run: **CONSULT_ERROR** (the `agy` CLI exited with code 3; the lane was skipped). Re-run against the pushed branch; its outcome is in `314-review-iter3-gemini.txt`.

### Review / PR #372 (Round 4, codex only)

#### Codex (REQUEST_CHANGES)
- **Concern**: the scanning patterns ignored the accepted `wa_` prefix → **Addressed**: `LEGACY_SCANNING_PATTERNS` is derived from `LEGACY_PREFIXES`. Tests check that every accepted prefix is caught and that the runbook names each legacy source.
- **Concern**: `develop` advanced again (PR #376) → **Addressed**: rebased.
- **Concern**: the iteration-3 review record was uncommitted → **Addressed**: committed.
- **Concern**: the key script's Sentry still used `NODE_ENV` → **Addressed**: `scriptSentryInit` uses `ENVIRONMENT`, pinned by a test.

#### Gemini
- **CONSULT_ERROR** in rounds 3 and 4: the `agy` CLI exits with code 3, so the lane is skipped. The owner can restore it by running `agy` once to sign in.

### Review / PR #372 (Round 5, codex only)
Codex: **APPROVE**, no issues. It confirmed all four round-4 fixes.

### Second external review (security architect's reviewer, Claude; over 0798cfce..b9391cc7)

REQUEST_CHANGES: eleven required fixes and one coverage item. The architect agreed with every one. All were **Addressed** in 1f936578:

1. **The MCP legacy window protected no key, but kept a cross-environment prefix class open.** `LEGACY_PREFIXES['ansari-mcp'] = []`, so the bare `ansari_mcp_` prefix is now refused (tested), and the MCP scanning pattern has no optional segment.
2. **The window's closed state was unreachable and untested.** The flag is now a parameter of `acceptedKeyPrefixesFor`, `scanningPatternFor` and `legacyScanningPatternsFor`, with both states tested and no pin on the flag's value. The runbook's post-window table is asserted against `scanningPatternFor(s, false)`. WhatsApp tests use a labelled key by default.
3. **The no-`RAILWAY_*` rule was unguarded.** Source-scan 6 covers apps/api, apps/auth, packages/auth and apps/mcp/src (planted lines, near-misses, exact allowlist: apps/mcp's `RAILWAY_GIT_COMMIT_SHA`, #377). Main's requirement: `apps/mcp/src/**` is now an `ansari-api#test` input. Negative test: clean `6f4ceeadd09c4cad`, planted `f8a848194d5da3e2` (and scan 6 failed), restored byte-identically to `6f4ceeadd09c4cad`.
4. **apps/api's Sentry environment was unasserted.** `tests/sentry-environment.test.ts` now checks it.
5. **The label binds key to auth, not api to auth.** Recorded as an accepted residual in the runbook; a boot assertion pairing the two is a possible follow-up.
6. **The exchange counted `keyVerified` before the owner and prefix gates.** Moved after them; a spy test proves it doesn't fire for refused prefixes, and it fails under the old order.
7. **Two environment knobs.** The route options no longer take one; `createApp` passes it.
8. **The script initialised Sentry before validating `ENVIRONMENT`.** It validates first now, and the hardcoded `'development'` is gone.
9. **The api test key had a shape no script can issue.** It is now `ansari_mcp_staging_…`.
10. **Docs named `EXPO_PUBLIC_ENVIRONMENT` as the frontend's.** Corrected to the legacy frontend's, in all three places.
11. **Minor:** leak-scan includes `LEGACY_PREFIXES`; boot-check deletes `NEXT_PHASE` instead of setting it to undefined.
12. **Spawned production boots.** Probes `apps/{auth,api}/scripts/probes/environment-boot-probe.ts`, output below.

Apart from those Gemini skips, no `CONSULT_ERROR` occurred.

## Production boot probes (finding 12)

apps/auth (built `dist/index.mjs`, `NODE_ENV=production`, unreachable database):
```
PASS  NODE_ENV=production ENVIRONMENT=(absent) → refused (names: ENVIRONMENT)
PASS  NODE_ENV=production ENVIRONMENT=development → refused (names: ENVIRONMENT)
PASS  NODE_ENV=production ENVIRONMENT=prod → refused (names: ENVIRONMENT)
PASS  NODE_ENV=production ENVIRONMENT=staging → listened
PASS  NODE_ENV=production ENVIRONMENT=production → listened
```
apps/api (`next start` on the built app, `NODE_ENV=production`, unreachable database):
```
PASS  NODE_ENV=production ENVIRONMENT=(absent) → /api/health 500, ENVIRONMENT rule logged
PASS  NODE_ENV=production ENVIRONMENT=development → /api/health 500, ENVIRONMENT rule logged
PASS  NODE_ENV=production ENVIRONMENT=prod → /api/health 500, ENVIRONMENT rule logged
PASS  NODE_ENV=production ENVIRONMENT=staging → /api/health 503
PASS  NODE_ENV=production ENVIRONMENT=production → /api/health 503
```

## Lessons Learned

### What Went Well

- **Reusing spec 329's machinery kept the surface small.** The plugin, the script, the alert pattern, the leak scans and the blocked `/api-key/*` paths were already there. This spec added one route and one consumer.
- **Two-sided pins on the refusal shape.** apps/auth asserts a byte-identical `{"valid":false}`. apps/api accepts only that shape and treats anything else as 503. Neither side can drift silently.
- **Mutation checks on every guard.** Each was removed in turn and failed tests: client-id rule, owner bind, relation check, permission check, missing-user 500, alert order, enforce, logging the token.
- **Testing through the real client.** apps/api tests stub `fetch` at the apps/auth boundary rather than mocking `verifyServiceKey`, so the timeout, the malformed-body and the shape checks run in every route test.

### Challenges Encountered

- **Plugin behaviour differs from its docs and from the spec's assumption.** An expired key is deleted when presented, and there is no routed `/api-key/verify` endpoint in 1.7.7, 1.7.20 or 1.8.0-beta.7: the docs' path comes from a JSDoc comment only. Both were settled by reading the published package. The first needed a spec amendment.
- **Alert ordering.** Counting `keyVerified` before the owner and client-id checks let a refused key inflate the volume alerts. The security architect caught it after the phase consults had approved it.
- **The doc path scan.** The `namedRepoPaths` regex in `cutover-docs.test.ts` has no end anchor, so `apps/mcp/wrangler.jsonc` reads as `apps/mcp/wrangler.json`, which does not exist. The doc was reworded rather than the scan changed (follow-up below).
- **Flakes under full parallel load.** Two pre-existing apps/auth-in-process tests failed once each, in the #330 lineage (see Flaky Tests).

### What Would Be Done Differently

- When one service validates an input that another forwards, give the caller the same bound. Otherwise the callee's 400 surfaces as the caller's outage. The apps/auth key bound was specified, but nobody mirrored it in apps/api until the PR consult.

- Grep a route's real callers before a plan names the suites a change touches. Four of the seven named suites never called the route.
- Put every "count this as success" side effect after the last check in a verify path from the start, and pin the order with a test.

- The env-label design went through two shapes in an hour: a `--env` flag, then `ENVIRONMENT`. The first was built because apps/auth had no environment discriminator; the owner's answer was to add one. Next time, when a design needs a fact the system lacks, ask whether to add that fact before designing around its absence.

### Methodology Improvements

- A plan that names existing test files to change should list how each one calls the code under change (route vs helper), so the count is checked at plan review.
- Doc-scan regexes in `cutover-docs.test.ts` should be negative-tested against near-miss paths (`.jsonc` vs `.json`) like any other verification pattern.

## Architecture Updates

- Routed: hot — `arch-critical.md` JWT fact — amended in place (Phase 5): apps/api accepts only apps/auth's JWT **except** `/v2/mcp-complete`, which takes an `ansari-mcp` service key verified on every request at `/api/service/verify-key` (401 refused, 503 outage). The map's Authentication line now names "service keys (WhatsApp exchange, MCP verify)". No fact was added, so no demotion was needed.
- Routed: cold — `arch.md` service-keys paragraph — key prefixes name `ENVIRONMENT`, routes refuse another environment's label, `LEGACY_UNLABELLED_KEYS` window (Amendments 2 and 3). The verify-route paragraph also records the bearer envelope (401, no call). No hot change: `arch-critical.md` is at its 10-fact cap, and `ENVIRONMENT` is a deployment setting documented in self-hosting and RELEASE.md.
- Routed: cold — `arch.md` Authentication & Authorization — new verify-route paragraph (Phase 5): the closed permission set, owner and client-id binding, refusal shape, no CORS, no per-IP rule, `MCP_COMPLETE_KEY_MODE`.

## Lessons Learned Updates

- Routed: cold — `lessons-learned.md` "Service API keys and the WhatsApp exchange (spec 329)" section, extended with spec 314 bullets:
  - an expired service key leaves no row behind, because the plugin deletes it on presentation, so never put an expiry on a key whose audit trail matters;
  - `verifyApiKey` has no HTTP route in any published version checked; read the published package, not the docs, and re-run the upgrade guard on any bump;
  - count a success only after the last check in a verify path;
  - pin a remote verdict's refusal shape on both sides.
- Routed: hot — `lessons-critical.md` map line for spec 329 extended to "+ MCP key verify (spec 314)", with a consult trigger for gating a route on a remote verify. No lesson was added: the hot file is at its cap, and none of these is cross-cutting enough to displace an entry.

## Sentry environment continuity (Amendment 3)

- **apps/api** sent `RAILWAY_ENVIRONMENT || NODE_ENV`, and now sends `ENVIRONMENT`. The owner set `ENVIRONMENT` on `backend` and auth in staging and production (2026-11-12), so checking it against Railway's environment names no longer matters.
- **apps/auth** sent `NODE_ENV`, which is `production` on both staging and production. Today its staging events are therefore labelled `production`. After this change they are labelled `staging`. This is a deliberate correction, and the owner should check the auth Sentry project's alert rules and filters.

## Flaky Tests

Neither test was skipped. Both are pre-existing, outside this change, and passed in isolation and on a full rerun. The security architect owns this class (#330 lineage) and ordered that it not be chased here.

- `apps/api/tests/auth/require-user.test.ts`: all 13 tests failed once in Phase 3 with `sign-up failed: 404` from the in-process apps/auth (`signUpTokens`, `apps/auth/tests/helpers/service.ts:166`). The run was a full `npm test -- --exclude='**/e2e/**'`: 4 packages in parallel, 4 workers each. The file passed 18/18 alone and on a full rerun.
- `apps/auth/tests/whatsapp-session.test.ts` > "auth.apikey dropped under the running service → 500 …": got 404 where it expected 401, once, in Phase 4 under the same full parallel run. It passed 3/3 alone and on a full rerun.

## Follow-up Items

- **Close the legacy-key compatibility window (WhatsApp only):** once `list` shows no live unlabelled key (`ansari_wa_` or pre-rename `wa_`) on any database, set `LEGACY_UNLABELLED_KEYS = false` and re-register the scanning patterns. The issue is opened at enforce, like the log-only removal.

- **Remove log-only:** open the issue at enforce (rollout step 6). It removes `MCP_COMPLETE_KEY_MODE` from `config.ts` and the `turbo.json` `globalEnv` hunk one week after enforcement. The issue number is to be recorded when it exists.
- **Limit sizing:** `MCP_KEY_INITIAL` (120/60 s, 5,000/day) and the alert thresholds are judgement values. The owner should resize them with `update-limits` (no deploy) once the `threads.client` query numbers are in.
- **Boot assertion pairing `ENVIRONMENT` with the `AUTH_URL` host:** closes the residual in the runbook (a production apps/api pointed at staging auth). This was not built in this PR.
- **`ENVIRONMENT` parity in apps/frontend:** it has no such variable today; only the legacy frontend has `EXPO_PUBLIC_ENVIRONMENT`. That parity is app's lane, on the owner's word.
- **Owner steps outside the repository:** listed under Spec Compliance. The published snippet and MCP setup page locations are pending from the owner.
- **`@better-auth/api-key` upgrade to 1.7.20:** out of scope. On any bump, re-run the upgrade guard in `apps/auth/tests/blocked-paths.test.ts` and the runbook's plugin-upgrade check.
- **`cutover-docs.test.ts` `namedRepoPaths`:** add an end boundary after the extension so `.jsonc` is not read as `.json`. This is main's test infrastructure.
- **Flaky in-process apps/auth tests under parallel load:** security owns them (#330 lineage).
