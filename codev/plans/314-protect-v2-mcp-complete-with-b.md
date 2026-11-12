# Plan: Protect `/v2/mcp-complete` with Better Auth API keys issued by apps/auth

**Specification**: [codev/specs/314-protect-v2-mcp-complete-with-b.md](../specs/314-protect-v2-mcp-complete-with-b.md)

## Executive Summary

This implements the spec's **Approach 1**: a per-request key check at a public apps/auth route. The open tier is closed (option (a)), as the owner approved on 2026-11-11.

The work runs from the key's issuer outward:

1. the shared rules: `ansari-mcp` limits, the client-id rule, and the script's constraints;
2. the apps/auth verify route;
3. apps/api's client for that route and its rollout setting;
4. the `mcp-complete` gate itself;
5. the docs and runbook.

Each phase is one commit. The tests for each phase pass on their own.

The apps/auth side reuses the WhatsApp exchange's proven parts:
- the mount ahead of `corsFor`;
- the route-local byte-limited JSON parser;
- the `auth.apikey` relation check;
- the alert dedup machinery.

What is new on that side is generalized out of the exchange, not copied.

The apps/api side reuses `authServiceFetch` (3 s timeout, `AuthServiceUnavailableError`) and the `requireAdmin` fail-closed posture.

No migration: `auth.apikey` exists (`0001`), and no app-DB column is added. One new env var, `MCP_COMPLETE_KEY_MODE`. Its `turbo.json` `globalEnv` hunk belongs to main and is requested in Phase 3.

## Phases (Machine Readable)

```json
{
  "phases": [
    {"id": "phase_1", "title": "ansari-mcp key rules: limits, client-id rule, script constraints"},
    {"id": "phase_2", "title": "apps/auth verify route POST /api/service/verify-key"},
    {"id": "phase_3", "title": "apps/api verify client and MCP_COMPLETE_KEY_MODE setting"},
    {"id": "phase_4", "title": "mcp-complete key gate, key attribution and log-only mode"},
    {"id": "phase_5", "title": "Docs, runbook and architecture notes"}
  ]
}
```

## Phase Breakdown

### Phase 1: ansari-mcp key rules: limits, client-id rule, script constraints

**Dependencies**: None

#### Objective

Fix the `ansari-mcp` service's rules in one place before anything consumes them: its own key bounds, initial limits and alert thresholds; the client-id rule shared by apps/auth and apps/api; and the operator script's enforcement of that rule.

#### Files to Create / Modify

- `packages/types/src/attribution.ts`: add `MCP_CLIENT_ID_PATTERN` (`/^ansari-mcp(-[a-z0-9._-]+)?$/`, at most 64 characters, a subset of `CLIENT_ID_PATTERN`) and `isMcpClientId()`. This lives in `@ansari/types` because both apps/auth (the script and the verify route) and apps/api (the response check) need it.
  - apps/api already depends on `@ansari/types`.
  - apps/auth does **not**. It reaches the rule through `@ansari/auth`, which re-exports `isMcpClientId` from `packages/auth/src/index.ts` (the existing pattern for `CLIENT_HEADER`). `apps/auth/package.json` is unchanged.
- `packages/auth/src/index.ts`: re-export `isMcpClientId` and `MCP_CLIENT_ID_PATTERN`.
- `packages/auth/src/limits.ts`:
  - `MCP_KEY_BOUNDS`, its own constant, with the same wide values as `WHATSAPP_KEY_BOUNDS` so raising a limit never needs a code change;
  - `MCP_KEY_INITIAL`;
  - `MCP_VERIFY_KEY_ALERT` and `MCP_VERIFY_DAILY_ALERT`, each one third of the initial caps;
  - `MCP_VERIFY_UNAUTHORIZED_ALERT`;
  - `VERIFY_BODY_LIMIT` (1024);
  - `VERIFY_KEY_MAX_LENGTH` (256).
- `packages/auth/src/service-users.ts`:
  - `SERVICES['ansari-mcp'].bounds` becomes `MCP_KEY_BOUNDS`; the "#314 reserved" comment is updated;
  - `ServiceKey` and `listServiceKeys` select `metadata`;
  - a `clientIdOf(metadata)` helper accepts the metadata as JSON text **or** an object (the 1.7.7 → 1.7.20 plugin change) and returns `string | null`.
- `apps/auth/scripts/service-keys.ts`: for `ansari-mcp`, `create-key` and `rotate` require `--client-id`, and the value must pass `isMcpClientId`. Otherwise the script stops with a `RefusedError` and writes nothing. The value is never echoed back, as `label()` already does. The default `clientId: service` fallback no longer applies to `ansari-mcp`. `list` prints a `client_id` line per key.
- Tests:
  - `packages/types` has no test runner, and none is added. The pattern is tested in `packages/auth/tests/unit/helpers.test.ts`, which already tests `@ansari/types/attribution` through `@ansari/auth`, and again from apps/api in Phase 3;
  - `packages/auth/tests/unit/helpers.test.ts` for `clientIdOf`, both shapes plus garbage;
  - `apps/auth/tests/service-keys.test.ts`. The existing `ansari-mcp` `create-key` call sites (around lines 626 and 693) gain a valid `--client-id`;
  - `apps/auth/tests/limits.test.ts`.

**Initial values (judgement, pending the owner's `threads.client` numbers; changeable with `update-limits`, no deploy):**

| Value | Initial | Reason |
|---|---|---|
| `rateLimitMax` / window | 120 per 60 s | Equals apps/api's per-IP cap. The key's window is global, so this is the aggregate MCP burst ceiling. |
| `refillAmount` (daily) | 5,000 | A daily Gemini ceiling for all MCP traffic, with room for growth. Revisited when the owner's numbers land. |
| Window alert | 40 | One third of the window cap. |
| Daily alert | 1,666 | One third of the daily budget. |
| Unauthorized alert | 20 per `EXCHANGE_ALERT_WINDOW` | Same as the exchange. A healthy MCP server sees none outside a rotation. |

#### Deliverables

- [ ] `MCP_CLIENT_ID_PATTERN` / `isMcpClientId` in `@ansari/types`.
- [ ] `ansari-mcp` bounds, initial limits and thresholds in `limits.ts`.
- [ ] `listServiceKeys` returns `metadata`; `clientIdOf` handles both shapes.
- [ ] Script: `--client-id` required and constrained for `ansari-mcp`; `list` prints `client_id`.
- [ ] Tests for this phase.

#### Acceptance Criteria

- [ ] `create-key ansari-mcp` without `--client-id`, or with `claude-skill`, `ANSARI-MCP`, `ansari-mcp_x`, `ansari-mcpx` or a key-shaped value, is refused, and no `apikey` row is written (spec apps/auth scenario 14).
- [ ] `create-key ansari-mcp --client-id ansari-mcp-production` stores `metadata.clientId = 'ansari-mcp-production'`, and `list` shows it.
- [ ] `whatsapp` key creation is unchanged (its existing tests pass untouched).
- [ ] `pnpm typecheck` and `pnpm test` pass for `packages/types`, `packages/auth` and `apps/auth`.

#### Test Plan

- Unit tests for the pattern (good ids and near misses) and `clientIdOf` (string, object, null, malformed JSON, non-string `clientId`).
- Script tests through the existing pglite harness in `service-keys.test.ts`.

---

### Phase 2: apps/auth verify route `POST /api/service/verify-key`

**Dependencies**: Phase 1

#### Objective

Give apps/api a way to check an `ansari-mcp` key: a public route at apps/auth's origin that runs `verifyApiKey` in process, binds the key to the `ansari-mcp` service user, tells an outage from a refusal, and alerts. This is spec §1.

#### Files to Create / Modify

- `apps/auth/src/routes/service-verify.ts` (new): `serviceVerifyRouter({ auth, db }, options)`.
  - **Order:**
    1. `requireJson`;
    2. `express.json({ limit: VERIFY_BODY_LIMIT })`;
    3. `parseFailure` (any parse failure is the one 400);
    4. body validation. `key` is a string of 1 to 256 characters matching `/^[\x21-\x7E]+$/`. `permissions` must deep-equal `{ mcp: ['complete'] }`. Anything else is a 400 with `{ message: 'Invalid request' }`, before any key is touched;
    5. `verifyApiKey({ body: { key, permissions } })`;
    6. on refusal, the relation check, then `{ valid: false }`;
    7. on acceptance, `findServiceUser(db, 'ansari-mcp')`. If it is not exactly one user, 500 and an alert. If `referenceId` is not that user, `{ valid: false }`;
    8. `clientIdOf(key.metadata)` must pass `isMcpClientId`. If not, a `client-id-invalid` alert and `{ valid: false }`;
    9. `{ valid: true, client_id, key_id }`.
  - Every other method and sub-path is a bare 404, as in the exchange.
  - Errors are logged as `redactError` `{name, code}` only.
  - The key is never logged, echoed or sent to Sentry.
- `apps/auth/src/alerts.ts`: generalize `createExchangeAlerts` into a per-service factory, `createKeyAlerts({ service, thresholds, message, tagPrefix, send, now })`.
  - The WhatsApp exchange keeps its exact message, tags and thresholds through a thin `createExchangeAlerts` wrapper, so its tests and runbook stay true.
  - **Source-scan coupling.** `apps/api/tests/cutover-docs.test.ts` slices `alerts.ts` from `export type ExchangeAlert =` to `export type KeyRefusalCode` and expects exactly six kinds that match the runbook's `## Alerts` table. `ExchangeAlert` therefore keeps its six WhatsApp kinds, still immediately above `KeyRefusalCode`. The MCP union (`McpVerifyAlert`, which adds `client-id-invalid`) is a separate type declared after them.
  - Add the `client-id-invalid` kind, carrying `keyId`, at most once per window.
  - MCP alerts use the message `auth: MCP key verify alert` and tags `mcp-verify-<kind>`.
- `apps/auth/src/app.ts`: mount `SERVICE_VERIFY_PATH` (`/api/service/verify-key`) **ahead of `corsFor`**, beside the exchange, and update the header comment's route list. Add `verify?: VerifyOptions` to `AppOptions` (alerts and clock for tests).
- Tests:
  - `apps/auth/tests/service-verify.test.ts` (new; pglite; real plugin; keys made through the script's `createKey` path; the `startService` helper);
  - `apps/auth/tests/service-verify-sentry.test.ts` (new; the leak scan over captured Sentry envelopes and console output, modelled on `whatsapp-session-sentry.test.ts`);
  - `apps/auth/tests/blocked-paths.test.ts`: the plugin-upgrade guard;
  - the existing `apps/auth/tests/whatsapp-session*.test.ts` must pass unchanged, which is the regression proof for the alert refactor.

**Plugin-upgrade guard (owner request, 2026-11-11).** The current docs advertise `POST /api-key/verify`. No published version routes it: 1.7.7, 1.7.20 and 1.8.0-beta.7 all have `serverOnly`, checked against the packages. The guard:
- asserts that `apiKey().endpoints.verifyApiKey` has no `path` (it is server-only);
- asserts that `POST /api/auth/api-key/verify` (and case and trailing-slash variants) is refused by `blockedPaths` today;
- keeps the 7-endpoint and 5-routed count assertions.

A plugin bump that routes `verify` fails these tests loudly. The blocked-path prefix rule already covers the new path, which the second assertion proves. A comment beside the assertions records this, and the review records it for future upgrades.

#### Deliverables

- [ ] The verify router, mounted ahead of `corsFor`.
- [ ] The alerts generalized; the `client-id-invalid` kind; MCP thresholds.
- [ ] The plugin-upgrade guard tests.
- [ ] Tests for this phase.

#### Acceptance Criteria

The spec's apps/auth scenarios 1–15 all pass against pglite. In particular:
- [ ] a valid key gives `{ valid: true, client_id, key_id }`, and `remaining` drops by 1;
- [ ] every refusal body is byte-identical (`{"valid":false}`);
- [ ] a WhatsApp key gives `valid: false`, with `remaining`, `requestCount` and `lastRequest` as the plugin leaves them (pinned untouched);
- [ ] a disallowed permission set gives a 400 that names no permission, with no plugin call (spied) and the presented key's row unchanged;
- [ ] a dropped `auth.apikey` or a stopped DB gives a 500;
- [ ] the service-user faults behave per spec scenario 7, in both directions;
- [ ] no `Access-Control-*` header on any response, preflight included;
- [ ] the leak scan finds neither the key nor any 16-character window of its random part (the prefix exempt) in responses, console output or Sentry envelopes, and finds no random-part substring in the `apikey` row except the hash;
- [ ] the WhatsApp exchange suite is unchanged and green;
- [ ] `pnpm typecheck` and `pnpm test` pass for `apps/auth`.

#### Test Plan

- Integration over HTTP against `startService` (pglite, the real Better Auth instance).
- An alert dedup unit test with an injected clock.
- The leak scan uses a negative control: a known-bad log line that contains a 16-character window must be caught, and the bare `ansari_mcp_` prefix must not be flagged. This follows the lesson "a verification pattern is code".

---

### Phase 3: apps/api verify client and `MCP_COMPLETE_KEY_MODE` setting

**Dependencies**: Phase 2 (the contract it consumes)

#### Objective

Give apps/api a typed, fail-closed client for the verify contract, and the rollout setting, before the route uses either.

#### Files to Create / Modify

- `apps/api/lib/auth-service/client.ts`: `verifyServiceKey(key): Promise<{ valid: true; clientId: string; keyId: string } | { valid: false }>`, with the path `SERVICE_VERIFY_PATH`.
  - It POSTs `{ key, permissions: { mcp: ['complete'] } }` through `authServiceFetch`, with no bearer.
  - A 200 is parsed with Zod: `valid: true` with a string `key_id` and a `client_id` passing `isMcpClientId`, or exactly `valid: false`.
  - Anything else (any non-200, a parse failure, an off-pattern `client_id`) throws `AuthServiceUnavailableError`.
  - Nothing is logged here (the file's rule).
- `apps/api/lib/config.ts`: `MCP_COMPLETE_KEY_MODE: z.enum(['log-only', 'enforce']).optional()`, exposed as `config.mcpCompleteKeyMode` (`'enforce'` when absent). Any other value fails `getEnv()`, so `validateEnvAtBoot` refuses a production boot.
- **Four-way derivation** (arch-critical):
  - the Zod schema;
  - the static read through `config`;
  - `apps/api/.env.example` (a commented line). It is tracked. If the read-deny rule blocks editing it, the line is appended from the shell;
  - `docs/self-hosting.md`, under "Optional / defaulted", which the `self-hosting-docs.test.ts` documented-surface check must see;
  - the dynamic-read scan (`eslint-env-guard.test.ts`) must stay green, so no `process.env[...]` read is added.
- **`turbo.json` `globalEnv`**: not edited here. It is the only hunk needed: `packages/types/src/**` is already in `globalDependencies`. Send `afx send architect:main` asking for the `MCP_COMPLETE_KEY_MODE` hunk, naming the variable and why. Record the request and the outcome in the thread. Without it, strict env mode hides the var from tasks and the cache key, but the absent default (enforce) is the safe one.
- Tests: `apps/api/tests/auth/verify-service-key.test.ts` (new) and `apps/api/tests/config.test.ts`.

#### Deliverables

- [ ] `verifyServiceKey` with strict response parsing.
- [ ] `MCP_COMPLETE_KEY_MODE` in config, its docs line, and the `.env.example` line.
- [ ] The main architect asked for the `turbo.json` hunk.
- [ ] Tests for this phase.

#### Acceptance Criteria

- [ ] `verifyServiceKey` maps each case correctly:
  - a 200 valid response → `{ valid: true, clientId, keyId }`;
  - a 200 `{ valid: false }` → `{ valid: false }`;
  - each of the following → `AuthServiceUnavailableError`: a network error, an abort past 3 s (fake timers), a 500, a 429, a 404 (an apps/auth that predates the route), non-JSON, `valid: true` without `key_id`, `valid: true` without `client_id`, a `client_id` of `claude-skill`, and `valid: "true"`.
- [ ] The request body sent is exactly `{ key, permissions: { mcp: ['complete'] } }`, with no `Authorization` header.
- [ ] Config: absent → `enforce`; `enforce` → `enforce`; `log-only` → `log-only`; `log_only`, `LOG-ONLY` and `''` each throw; `validateEnvAtBoot` throws in a production env carrying a bad value.
- [ ] `pnpm typecheck` and `pnpm test` pass for `apps/api`.

#### Test Plan

Unit tests with a stubbed `fetch`, and config tests in the style of the existing `config.test.ts` and `boot-check.test.ts`.

---

### Phase 4: mcp-complete key gate, key attribution and log-only mode

**Dependencies**: Phase 3

#### Objective

Require a valid key on `POST` and `GET /api/v2/mcp-complete`. Attribute each call to the key's client, fail closed when apps/auth cannot answer, and support log-only mode for the rollout week. This is spec §2–§3.

#### Files to Create / Modify

- `apps/api/src/app/api/v2/mcp-complete/route.ts`:
  - **Order, for both methods:**
    1. per-IP cap (unchanged);
    2. `authorizeMcpRequest(request)`;
    3. body or query validation;
    4. `handleMcpComplete(messages, client)`.
  - **`authorizeMcpRequest`** returns either `{ client }` or `{ response }`:
    - **Bearer:** case-insensitive `Bearer <token>`, matching apps/auth's `bearerOf`. Missing or malformed is the verdict `missing`, with no fetch.
    - **Verify:** `verifyServiceKey(token)` gives `valid` or `refused`. `AuthServiceUnavailableError` gives `unverified`.
    - **Enforce mode:** `missing` and `refused` get 401 `{ error: 'Unauthorized' }`. `unverified` gets 503 `{ error: 'Authentication service unavailable' }` plus a `console.warn` with the status only.
    - **Log-only mode:** every verdict is served. `unverified` raises a Sentry warning, `mcp-complete key unverified (log-only)`.
    - **Recording:** every verdict is recorded as a Sentry tag (`mcp_key_verdict`) and one structured `console.log` line, `[ai-skill] mcp-complete key verdict`, carrying `{ verdict, keyId? }`. Never the key.
    - **Sentry tags on a valid key:** the gate sets `client` to the key's client id, keeping tag parity with what `getClientId` would have set.
  - **Attribution with a valid key:**
    - `client = clientId`;
    - `parseClientId(header, null)` is run on the header alone;
    - if the header is present and either malformed or a different valid id, one Sentry warning, `mcp-complete client mismatch`, tagged with the key's client and the header's id or `invalid` (never the raw value);
    - `?src=` is ignored;
    - `getClientId` is **not** called, so the existing invalid-header warning does not fire as well.
  - **Attribution without a valid key (log-only only):** `getClientId(request)` as today.
  - A non-`AuthServiceUnavailableError` thrown by the gate falls into the route's existing catch (500). Before persisting, the gate must never leave a thread behind.
- **Existing suites that call the route** must present a key through a shared stub:
  - `apps/api/tests/mcp-complete.test.ts`;
  - `attribution.test.ts`;
  - `rate-limit.test.ts`;
  - `route-persistence-rollback.test.ts`;
  - `toolcalls-routes.test.ts`;
  - `facilitator-empty-final.test.ts`;
  - `tests/sentry/request-envelopes.ts`.

  The stub is a new helper, `apps/api/tests/helpers/mcp-key.ts`. It:
  - stubs global `fetch` for `<AUTH_URL>/api/service/verify-key` with a valid response, and passes any other URL through to the original;
  - sets the `AUTH_*` variables with `vi.stubEnv` when the suite has none, so `config.authService` resolves;
  - adds the `Authorization` header. Each suite's assertions are otherwise unchanged. `attribution.test.ts`'s `mcp-complete` cases are rewritten for key attribution, because the header no longer decides there. `?src=` attribution stays tested on the routes that still use it (threads, register).
- `apps/api/tests/mcp-complete-key.test.ts` (new) covers the spec's apps/api scenarios 1–12:
  - the thread, messages and orphan rows are checked on **pglite** (the `route-persistence-rollback.test.ts` setup);
  - the facilitator is mocked (a spy proves "no Gemini call");
  - the apps/auth boundary is a stubbed global `fetch` speaking the Phase 3 contract on the wire, so the real `verifyServiceKey` and `authServiceFetch` run. `verifyServiceKey` is **not** mocked here;
  - Sentry is captured;
  - the leak scan runs over the console and Sentry captures, with a negative control.
- Spec scenario 13 (a WhatsApp key end to end) is covered at the seam:
  - Phase 2 proves apps/auth answers `{ valid: false }` for a WhatsApp key;
  - this phase proves `{ valid: false }` gets 401.

  A cross-app harness, with apps/api calling a live apps/auth, is not built. The review records this, as the spec allows.

#### Deliverables

- [ ] The key gate on both methods, with enforce and log-only modes.
- [ ] Key-first attribution and the single mismatch warning.
- [ ] Existing suites moved onto the shared key stub.
- [ ] Tests for this phase.

#### Acceptance Criteria

- [ ] Spec apps/api scenarios 1–12 pass. In particular, in enforce mode no thread, message or orphan row exists after any 401 or 503 (checked on pglite), and the facilitator spy is never called.
- [ ] The 503 arrives within `AUTH_SERVICE_TIMEOUT_MS` plus a margin (fake timers).
- [ ] Log-only mode serves `missing`, `refused` and `unverified`, records each verdict, and attributes by key when valid.
- [ ] A forged `X-Ansari-Client` with a valid key gives `client` = the key's, and exactly one mismatch warning. A matching header gives no event. `?src=` gives no event.
- [ ] All existing apps/api suites are green.
- [ ] `pnpm typecheck` and `pnpm test` pass (the full apps/api suite, with the CI env).

#### Test Plan

- Route-level tests on pglite with mocked facilitator and Sentry, as above.
- **Manual staging smoke** after deploy (Rollout, below): a valid beta-Worker key answers; a revoked key gets 401; the verdict appears in the logs. The result is recorded in the review with no key material.

---

### Phase 5: Docs, runbook and architecture notes

**Dependencies**: Phases 1–4

#### Objective

Make the new credential operable and the architecture docs true again.

#### Files to Create / Modify

- `docs/cutover/service-keys-runbook.md`: an `ansari-mcp` section, under its **own `##` heading**, so that `cutover-docs.test.ts`'s `section('Limits')` and `section('Alerts')` still match only the WhatsApp tables. It covers:
  - issuance (`create-service ansari-mcp`, then `create-key` with the required `ansari-mcp*` `--client-id`, one key per MCP deployment);
  - the Worker-secret handoff (`wrangler secret put ANSARI_API_AUTHORIZATION --env <env>`, value `Bearer <key>`, pasted straight from the shell; the owner's variable for `mcp.ansari.chat`);
  - the limits table, global for all MCP traffic;
  - the alerts table for `auth: MCP key verify alert`, including `client-id-invalid`;
  - rotation (two keys, a doubled ceiling, keep the overlap short);
  - the plugin-upgrade check.
- `docs/self-hosting.md`:
  - `mcp-complete` needs a key;
  - the verify route;
  - `MCP_COMPLETE_KEY_MODE` (if not already added in Phase 3);
  - the service-keys section mentions `ansari-mcp`.
- `apps/mcp/README.md`: the `ANSARI_API_AUTHORIZATION` row gives the `Bearer ansari_mcp_…` form and notes that the route refuses calls without it. No code change.
- `apps/api/README.md`: the MCP-style row notes that a key is required.
- `codev/resources/arch-critical.md`:
  - the fact "apps/api accepts only apps/auth's EdDSA JWT" becomes untrue as written. Amend it in place (it stays one line): "…except `/v2/mcp-complete`, which takes an `ansari-mcp` service key verified per request at apps/auth's `/api/service/verify-key` (401 refused / 503 outage)";
  - adjust the "Authentication & Authorization" map line to mention service keys.
- `codev/resources/arch.md`, under "Authentication & Authorization": a short subsection on the verify route, its closed permission set, fail-closed posture, log-only transition and removal follow-up.
- `codev/resources/lessons-learned.md` is left to the review phase.

#### Deliverables

- [ ] Runbook, self-hosting doc, READMEs and arch docs updated.
- [ ] Doc tests (`self-hosting-docs.test.ts`, `cutover-docs.test.ts`, `contributor-docs.test.ts`) green.

#### Acceptance Criteria

- [ ] Every statement in the docs matches the code: route path, env var values, alert names, limit values.
- [ ] No key, hash or key-shaped string appears in any doc. Examples use `ansari_mcp_<64 letters>` as a placeholder.
- [ ] Doc tests pass.

#### Test Plan

The existing doc-scan tests, plus a read-through against the Phase 1–4 constants.

---

## Rollout (operator and owner steps; recorded in the review, not code)

The order is the real protection: every MCP caller holds its key **before** apps/api can enforce. Today's route ignores `Authorization`, so issuing keys and setting the secrets early is harmless. A deploy that then lands without `MCP_COMPLETE_KEY_MODE` enforces only against callers that already present valid keys, which is a non-event. Log-only is the safety net, not the only guard (security architect, 2026-11-11).

1. **Main:** the `turbo.json` `globalEnv` entry for `MCP_COMPLETE_KEY_MODE`. It is the only hunk needed: `packages/types/src/**` is already in `globalDependencies` (spec 300). Requested in Phase 3.
2. **apps/auth first:** deploy apps/auth with the verify route, on staging and then in production.
3. **Keys before apps/api:**
   1. `create-service ansari-mcp`.
   2. Issue one key per MCP deployment, each with its `ansari-mcp*` client id.
   3. Set each MCP server's upstream `Authorization`: `apps/mcp` Workers through `wrangler secret`; `mcp.ansari.chat` by the owner.
   4. Confirm with `list` that each key's last request is still `never`. It cannot move yet, because nothing calls the verify route until apps/api deploys.
4. **Then apps/api, with `MCP_COMPLETE_KEY_MODE=log-only` set on Railway before the deploy.** **Still in bold: absent means enforce.** Because step 3 is done first, a deploy that lands without the variable enforces only against callers that already hold keys. Even so, setting log-only is the plan.
5. **Staging smoke** (Phase 4 test plan), recorded in the review.
6. **One week of log-only in production.** Expect zero `missing` or `refused` verdicts from the MCP servers.
7. **Enforce:** remove `MCP_COMPLETE_KEY_MODE`. Open the dated follow-up issue (due one week after enforcement) to delete log-only mode, the variable and its `turbo.json` entry. The review records the issue number.
8. **Owner, out of repository:** update the published integration snippet and the MCP setup page on the public site, at the locations the owner names through the security architect.

## Risks and Mitigation

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| apps/api deploys without `MCP_COMPLETE_KEY_MODE=log-only` and enforces | Low | Low | Keys and MCP secrets are in place before apps/api deploys (Rollout step 3), so enforcement only meets keyed callers; the bold warning stays in the runbook and the PR |
| Generalizing the alerts breaks the WhatsApp exchange's alerts | Low | Medium | The exchange keeps its message, tags and thresholds through a wrapper; its suites must pass unchanged |
| Updating the existing suites to present a key weakens what they assert | Medium | Medium | The stub only adds the key; diffs are limited to request setup; reviewers check that no assertion was removed |
| The leak scan passes by not running (an empty capture) | Medium | High | Negative controls: a planted 16-character window must be caught, and the bare prefix must not be |
| `metadata` arrives in a shape the parser misses after a plugin bump | Low | Medium | `clientIdOf` handles text and object, with tests for both; an off-pattern or absent client gives `valid: false` plus an alert (loud) |
| A plugin bump routes `/api-key/verify` | Low | High | The upgrade guard fails the build; the prefix block already refuses the path |
| The initial limits are mis-sized for real MCP traffic | Medium | Medium | Alerts at one third; `update-limits` without a deploy; revisit when the owner's numbers land |
| No `.env*` read access from this session | High | Low | `apps/api/.env.example` is tracked: append the line from the shell in Phase 3 (architect, 2026-11-11), not through main |

## Documentation Updates

- `docs/cutover/service-keys-runbook.md`, `docs/self-hosting.md`, `apps/mcp/README.md`, `apps/api/README.md` (Phase 5; the env line may land in Phase 3).
- `codev/resources/arch-critical.md` (the amended JWT-only fact and its map line) and `codev/resources/arch.md` (Phase 5).
- `codev/resources/lessons-learned.md` in the review phase.
- Out of repository, as owner steps: the published snippet, the MCP setup page, and `mcp.ansari.chat`'s variable.

## Addendum: Amendments 2 and 3 (2026-11-12, review phase, on PR #372)

The owner expanded the scope after the PR consult. Following the security architect's porch route,
this addendum is built as review-phase commits on #372 (no rollback), then the PR consult is re-run
and the `pr` gate re-requested.

1. **`ENVIRONMENT`** (`packages/types/src/environment.ts`: `ENVIRONMENTS`, `environmentIssue`),
   re-exported by `@ansari/auth`. Added to `packages/auth/src/env.ts` and `apps/api/lib/config.ts`
   (required everywhere with no default, owner 2026-11-12; under `NODE_ENV=production` only `staging` or `production`).
   Enforced only where each schema is already enforced: apps/api's `validateEnvAtBoot` (never
   during `next build`), apps/auth's `getEnv()` at the top of `src/index.ts` (never at image build).
2. **Sentry:** apps/auth `initSentry(env.SENTRY_DSN, env.ENVIRONMENT)`; apps/api
   `sentry.server.config.ts` `environment: process.env.ENVIRONMENT || "development"`.
3. **Prefixes:** `keyPrefix(service, environment)`, `acceptedKeyPrefixes`/`isAcceptedKeyPrefix`
   (own environment, plus the bare prefix while `LEGACY_UNLABELLED_KEYS`), and the scanning
   patterns derived from the same table.
4. **Script:** reads `ENVIRONMENT` from its process env (no flag); refuses without it; prints it
   under the database line; new keys carry it.
5. **Routes:** the exchange and the verify route refuse a key whose stored prefix is not theirs
   (`environment` option, default `getEnv().ENVIRONMENT`; `createApp` passes `options.environment`).
6. **Tests:** schema and boot (both services), the script, both routes (own label served, legacy
   served, other environments, foreign and absent prefixes refused, a staging key refused by a
   production-configured app), the longest prefix created through the plugin, the derived scanning
   sources. Mutation-checked: dropping the environment comparison fails 5 tests.
7. **Surfaces:** `turbo.json` `globalEnv` (main's hunk), `.env.example` and `.env.ci` of apps/api
   and apps/auth, `docs/self-hosting.md`, `docs/cutover/deploy-guide.md`, RELEASE.md (rows and a
   deploy-order line), the runbook (scanning table, environment labels, existing keys unchanged,
   rotate legacy keys), apps/mcp README and `.env.example`, `arch.md`.

