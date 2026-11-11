# Specification: Protect `/v2/mcp-complete` with Better Auth API keys issued by apps/auth

## Problem Statement

`/api/v2/mcp-complete` (POST, and GET `?q=`) answers anyone who can reach it. It takes no credential. What limits it today:

- a per-IP cap of 120 requests a minute;
- body limits (20 messages of 4,000 characters; `q` ≤ 2,000);
- an `X-Ansari-Client` header (or `?src=`) that only labels the call.

Every call runs the Gemini facilitator and writes a thread under the `ai-skill` system identity. Anyone with the URL can spend Ansari's Gemini budget and fill the `ai-skill` thread history. The `client` column on those threads holds whatever the caller claimed, so the traffic attribution cannot be trusted either.

Who is affected:

- the owner, who pays for Gemini;
- the analytics that read `threads.client`;
- the Ansari MCP server (`apps/mcp`, a Cloudflare Worker), which is the route's intended caller and will have to present a key;
- browsing AIs that follow the published `?src=` prompt (#87). They cannot hold a secret, so a key requirement shuts them out unless the owner keeps an open tier (see Open Questions, Critical 1).

Spec 329 already built the credential: the `@better-auth/api-key` plugin, the `auth.apikey` table, service users resolved by their `service` account row, operator scripts, blocked `/api-key/*` paths and `enableSessionForAPIKeys = false`. It reserved an `ansari-mcp` service with permission `{ mcp: ['complete'] }` and prefix `ansari_mcp_`. Two things are missing: a consumer for that service, and a way for apps/api to verify a key. apps/api has no access to the auth database and no shared secret with apps/auth.

## Current State

**The route** (`apps/api` `v2/mcp-complete`):

1. The per-IP cap (`X-Real-IP`, 120/min) runs first, then body or query validation.
2. The `client` comes from `getClientId` (header, then `?src=`; a malformed value becomes the `invalid` sentinel and raises a Sentry warning).
3. One transaction writes the thread and the inbound messages under the `ai-skill` system user (resolved by `system_key`).
4. The facilitator runs to completion. Its result is persisted as an assistant message, or as orphan tool calls on an error or empty final turn.
5. The route answers `text/plain` 200, 400, 429, 500, or 502 (empty answer).

**The MCP server** (`apps/mcp`) POSTs to the route.

- It already sends an optional `Authorization` header taken verbatim from its `ANSARI_API_AUTHORIZATION` Worker secret, which is unset today.
- It sends `X-Ansari-Client` from `ANSARI_CLIENT`, set per Worker environment: `ansari-mcp-dev`, `ansari-mcp-beta`, `ansari-mcp-production`.
- A non-200 from the route becomes the tool's "could not complete" text.
- No code change is needed there: the secret's value becomes `Bearer ansari_mcp_<64 letters>`.

**Other callers.**

- The `?src=` fallback (#87) lets a browsing AI GET the route with no headers at all.
- The published integration snippet and the MCP setup page describe how to call it.

**apps/auth after spec 329:**

- `SERVICES['ansari-mcp']` exists with `{ mcp: ['complete'] }` and prefix `ansari_mcp_`. Its bounds borrow `WHATSAPP_KEY_BOUNDS`, pending #314.
- `service-keys.ts` can already create the service user and its keys.
- `auth.api.verifyApiKey` is `serverOnly`; the only route that calls it is the WhatsApp exchange.

How that exchange behaves today:

- It is mounted ahead of `corsFor`, outside Better Auth's handler, with no per-IP rule.
- It verifies with the route's permission and binds `referenceId` to the service user.
- On a plugin refusal it runs the `auth.apikey` relation check, so an outage is reported as 500 rather than 401.
- Its alerts (`createExchangeAlerts`) have WhatsApp thresholds hard-coded.

**apps/api ↔ apps/auth.** `lib/auth-service/client.ts` is the one HTTP client. It calls apps/auth's public origin (`AUTH_URL`) with a 3 s timeout. When apps/auth gives no usable answer, it throws `AuthServiceUnavailableError`, and callers fail closed with 503 (`requireAdmin` is the precedent). apps/api's Sentry scrubber already drops the `authorization` header and the request body.

**Plugin behaviour on verify** (spec 329, probed against pglite):

- The order is: hash lookup → enabled → expiry → permissions → budget, then it consumes one unit of `remaining` and one rate-limit slot, atomically.
- A refusal is `{ valid: false, error }`.
- A database fault comes back as `INVALID_API_KEY`, the same code as an unknown key.
- The plugin logs caught errors through better-auth's logger, which apps/auth reduces to `{name, code}`.

## Desired State

### 1. The verify route on apps/auth: `POST /api/service/verify-key`

It is a public route at apps/auth's public origin, built like the WhatsApp exchange:

- mounted outside Better Auth's handler path and ahead of `corsFor`, so no response carries CORS headers;
- with no per-IP rule (`ROUTER_RULES` stays all `false`, since apps/api calls from its egress IP);
- with no credential other than the key in the body. There is no internal listener and no shared secret: the key is the only secret, and it belongs to the caller.

| | |
|---|---|
| Request | JSON `{ "key": "<api key>", "permissions": { "mcp": ["complete"] } }`, parsed by the route itself with a strict byte limit |
| 200 valid | `{ "valid": true, "client_id": "<key metadata clientId>", "key_id": "<apikey.id>" }` |
| 200 refused | `{ "valid": false }`, byte-identical for every refusal: unknown, revoked, disabled, expired, budget exhausted, rate limited, wrong permission, owned by another service |
| 400 | `{ "message": "Invalid request" }`: not JSON, over the byte limit, `key` not a bounded string, or `permissions` not exactly a set the route serves |
| 500 | `{ "message": "Internal error" }`: database outage, `auth.apikey` missing, service user unresolvable or not unique |

How the route reaches a verdict:

- **Permissions are a closed set, not caller-chosen.** The route serves exactly `{ mcp: ['complete'] }` and binds it to the `ansari-mcp` service user. Any other permission set is a 400 and never reaches the plugin. So the route cannot be used to verify, or spend, a WhatsApp key under the WhatsApp permission. The field stays in the contract so a later consumer can be added as a new, explicit entry.
- **Verification** is `auth.api.verifyApiKey({ key, permissions })` in process.
  - On success, the key's `referenceId` must equal the `ansari-mcp` service user's id, found by its `service` account row (`findServiceUser`). A key owned by anyone else is refused.
  - If that service user cannot be resolved, or resolves to more than one user, the route answers 500 and alerts. It never answers `valid: false` for this.
- **Outage versus refusal.** On every plugin refusal, the route runs the same `auth.apikey` relation check as the exchange, with the same cache TTL. A failed check is a 500, never `valid: false`, so apps/api can tell "bad key" from "apps/auth cannot answer". Both routes have the same accepted residuals: an outage that starts inside the check's window is misread as a refusal.
- **The throttle** is the plugin's own: each verify spends one unit of the key's daily budget and one rate-limit slot. apps/api verifies once per request, so the key's limits count MCP requests.
- **Alerts.** The WhatsApp exchange's alert kinds apply here too: per-key window volume, per-key daily volume, `USAGE_EXCEEDED` / `RATE_LIMITED`, refusal volume, service user unresolvable. Each fires once per window, with MCP thresholds and an MCP message, and carries key ids and counts only.
- **No key material out.** No response, log line or Sentry event carries the key, a prefix of it, the hash or the request body. `client_id` and `key_id` are not secrets: `list` already prints them.

**`client_id` is required on an `ansari-mcp` key.** `service-keys.ts create-key ansari-mcp` and `rotate ansari-mcp` refuse without `--client-id`. A key verified without one (one created outside the script) is answered `valid: false` and raises an alert. It is never served with an unattributed client.

**`ansari-mcp` gets its own bounds and initial values in `limits.ts`**, no longer `WHATSAPP_KEY_BOUNDS`. **They are global.** One key serves every Claude, ChatGPT and other user of the MCP server (one key per Worker environment), so its rate limit and daily budget cap the aggregate public MCP traffic, and the daily budget is in effect a daily Gemini spend ceiling for MCP. When that budget is exhausted, every MCP user is refused until the refill. The script already forces a daily refill, so exhaustion throttles the key rather than deleting it. The plan picks the numbers by judgement, from current `ai-skill` volume when available:

- the per-minute cap at or above apps/api's per-IP cap;
- the daily budget with several times today's daily volume as headroom;
- the alerts at one third of each cap.

### 2. apps/api `mcp-complete` requires `Authorization: Bearer <key>`

Per request, after the existing per-IP cap:

1. **Bearer.** A missing or malformed `Authorization` header gets 401, with no call to apps/auth.
2. **Verify.** POST the key to `/api/service/verify-key` through `authServiceFetch`, with its existing 3 s timeout:
   - `valid: true` lets the request through;
   - `valid: false` gets 401;
   - no answer, a timeout, a non-200, or a body of the wrong shape is `AuthServiceUnavailableError` and gets **503**. Nothing is persisted and Gemini is not called (the admin-role posture).
3. **Then** the body or query is validated (400), and the rest of today's behaviour runs unchanged.

A caller without a valid key never learns anything about request validation, and costs no parsing.

**Responses.** Every key refusal gets the same 401: one JSON body, identical for missing, malformed, unknown, revoked, expired, exhausted, rate-limited, wrong-permission and wrong-owner keys. A 503 has its own body. The response shapes otherwise stay as they are (JSON errors, `text/plain` 200).

**Attribution (#320).** On a valid key, the thread's and messages' `client` is the key's `client_id`, never the header or `?src=`.

- If `X-Ansari-Client` is present and disagrees (after the usual normalisation), the route sends a Sentry warning tagged with both ids and ignores the header.
- If they agree, there is no event.
- The thread still belongs to the `ai-skill` system user with `source = 'ai-skill'`. The key identifies the integration, not a user. No session or JWT is ever minted for the service user (spec 329 rule), and the `{sub, sid}` JWT contract is untouched.

**No verdict cache beyond the request.** Each request is verified at apps/auth, so a revocation takes effect on the next request. Nothing caches a verdict in apps/api.

**The per-IP cap stays**, ahead of the key check, as a second layer against a single source hammering the route with bad keys.

**No key is logged or stored raw.** apps/api logs and Sentry already drop `authorization`. The key is not added to any log line, error message, Sentry extra or DB column. Only `key_id` may be recorded.

### 3. Rollout: log-only, then enforce

The mode is an apps/api setting.

- **Enforce** is the default when the setting is absent: a forgotten variable fails safe, as the "loud over quiet" lesson asks.
- **Log-only** must be set explicitly for the transition week.

In log-only mode the route verifies exactly as above, records the verdict, and then serves anyway:

- **What is recorded:** a structured log line and a Sentry breadcrumb or tag naming the verdict (`valid`, `missing`, `refused`, `unavailable`) and the `key_id` when valid. Never the key.
- **Attribution in log-only:** with a valid key, the key's `client_id` wins as in enforce mode. Otherwise the header or `?src=` is used, as today.

Order of operations:

1. Create the `ansari-mcp` service user and one key per Worker environment that calls a deployed apps/api, with `--client-id` set to that environment's `ANSARI_CLIENT`.
2. Set each Worker's `ANSARI_API_AUTHORIZATION`. Today's route ignores the header, so this is safe at any time.
3. Deploy apps/api with the mode set to log-only. The verify route ships with apps/auth before, or with, this deploy.
4. Watch the verdicts for one week. Expect zero `missing` or `refused` from the Worker, and confirm the open-tier traffic the owner decided on.
5. Remove the setting, which enforces.

If the owner keeps an open tier (Open Questions, Critical 1), log-only becomes that tier's behaviour for header-less requests only.

### 4. Rotation

Rotation is the spec 329 runbook unchanged:

1. `rotate ansari-mcp` with the same flags and the same `--client-id`, so two keys are live.
2. Put the new key into the Worker secret and redeploy the Worker.
3. Confirm with `list` that the new key's last request moves and the old one's stops.
4. Revoke the old key.

The runbook gains an `ansari-mcp` section: initial values, the doubled ceiling while two keys are live, and the Worker-secret handoff (`wrangler secret put`, straight from the shell).

### 5. Documentation

These docs change:

- `docs/self-hosting.md`: the route needs a key, and gains the mode setting if it is an env var;
- `docs/cutover/service-keys-runbook.md`: the `ansari-mcp` issuance, limits, alerts and rotation;
- `apps/mcp/README.md`: the `ANSARI_API_AUTHORIZATION` line gives the `Bearer ansari_mcp_…` form;
- `apps/api/README.md`;
- the published integration snippet and the MCP setup page, wherever they live (Open Questions, Important 2).

No `apps/mcp` code changes.

## Success Criteria

- [ ] `mcp-complete` (POST and GET) without `Authorization` → 401, with no call to apps/auth, no thread and no Gemini call (enforce mode).
- [ ] Revoked, disabled, expired, budget-exhausted, rate-limited, wrong-permission (a WhatsApp key) and unknown keys → the **same** 401 body, with no thread and no Gemini call.
- [ ] A valid `ansari-mcp` key → today's behaviour and body. The thread and its messages carry `client` = the key's `client_id`.
- [ ] A forged `X-Ansari-Client` with a valid key → `client` is still the key's; one Sentry warning; the request is served.
- [ ] apps/auth unreachable, timing out (past `AUTH_SERVICE_TIMEOUT_MS`), answering 5xx or answering a malformed body → 503 within the client timeout, with nothing persisted and no Gemini call.
- [ ] The verify route answers `{ valid: true, client_id, key_id }` for a valid `ansari-mcp` key and a byte-identical `{ valid: false }` for every refusal. It answers 400 for any permission set other than `{ mcp: ['complete'] }`, and 500 (not `valid: false`) when `auth.apikey` is missing or the database is down, or when the service user is unresolvable.
- [ ] A WhatsApp key presented to the verify route (and through apps/api) is refused, by permission and by owner, and its `remaining` is not spent.
- [ ] A key owned by a user other than the `ansari-mcp` service user, carrying `mcp: complete`, is refused.
- [ ] An `ansari-mcp` key without a `client_id` is refused and alerts. The script refuses to create one.
- [ ] Each verify spends one unit of the key's budget. An exhausted key is refused until its daily refill, and the row is kept.
- [ ] No response from the verify route carries CORS headers, preflight included.
- [ ] No response, log line, Sentry event or DB column, in either app, contains the raw key or any prefix of it. A test scans the captured logs and Sentry events for the key.
- [ ] Log-only mode: every verdict is recorded and the request is served. Enforce is the behaviour when the setting is absent.
- [ ] Tests run against pglite for the verify route (real plugin, real `auth.apikey`) and for the apps/api route (real app DB, apps/auth answered by a stub of the verify contract), including the forged-header and WhatsApp-key cases.
- [ ] Docs updated (§5). The runbook covers `ansari-mcp` issuance and rotation.
- [ ] The Ansari MCP server's production Worker has its key before the route enforces. This is an operator step, recorded in the review.

## Constraints

- **Settled by the security architect's briefing; not reopened here:**
  - verify at apps/auth's public origin, outside Better Auth's handler, in-process `verifyApiKey`, `referenceId` bound to the `ansari-mcp` service user;
  - no internal listener, no shared secret, no per-IP rule;
  - per-request verification, failing closed: 401 for one body, 503 on outage;
  - no verdict cache longer than the plugin's own window;
  - not the WhatsApp exchange shape: no session and no JWT for the service user, and the `{sub, sid}` contract stays frozen;
  - the key's bounds are global and sized for aggregate traffic;
  - a week of log-only before enforcing;
  - two-key rotation;
  - a WhatsApp key is refused by permission.
- **Two databases, one owner each.** apps/api never reads `auth.apikey`. It learns a verdict only over HTTP.
- **Spec 329 rules hold:** keys are created only by `service-keys.ts`; `/api/auth/api-key/*` stays blocked; `enableSessionForAPIKeys = false`; the better-auth logger stays redacted; errors are logged as `{name, code}` only.
- **Boundaries owned by main:** `turbo.json` / `globalEnv`, `.github`, Dockerfiles, Railway config and migration numbering. A new env var (the rollout mode) needs a `turbo.json` hunk from `architect:main`. No migration is expected: `auth.apikey` already exists.
- **Ships behind the apps/auth production cutover (spec 300).** Build and test against staging.
- **High risk tier:** 3-way review at spec, plan and PR.

## Assumptions

- #329 is merged and `0001_api_key` is applied on staging (security architect, 2026-11-11).
- The Worker's existing `ANSARI_API_AUTHORIZATION` passthrough sends the header verbatim on every upstream call (to be confirmed in the plan by reading `ansari-client.ts` and its tests).
- Each Worker environment calls exactly one apps/api deployment, so one key per environment is enough (production Worker → production apps/api; beta and dev → staging).
- The 3 s `AUTH_SERVICE_TIMEOUT_MS` is acceptable latency on the MCP path. A verify adds one round trip (apps/api → apps/auth → auth DB) ahead of a Gemini call that takes seconds.
- The owner's `threads.client` numbers for `ai-skill` traffic are available before the spec gate (Open Questions, Critical 1).

## Solution Approaches

### Approach 1 (recommended): per-request verify at a public apps/auth route

This is what §1–§3 describe. apps/api posts the key to `/api/service/verify-key` on every request and acts on the verdict.

- **Pros:**
  - Revocation is immediate.
  - The plugin's per-key rate limit and daily budget bind every MCP request.
  - No secret or new database access in apps/api.
  - The route reuses the exchange's proven shape (mount order, relation check, alerts).
  - The JWT contract does not change.
- **Cons:**
  - One extra round trip per request, and MCP availability now depends on apps/auth (503 when it is down).
  - A public verify route is a key-validity oracle for anyone who already holds a key (acceptable: the key is the secret).
  - An unknown-key flood costs one DB lookup each, with no per-IP rule on apps/auth. This is the accepted residual from spec 329, bounded by apps/api's per-IP cap for traffic through apps/api, and surfaced by the refusal-volume alert for direct traffic.
- **Risk:** low to medium. The pieces exist and are tested in spec 329.

### Approach 2: key → short-lived JWT exchange (the #320 sketch)

The Worker trades its key at apps/auth for a JWT carrying `client` and `akid` claims, and apps/api verifies the JWT via JWKS.

- **Pros:** no per-request call to apps/auth; apps/api keeps its JWKS-only model.
- **Cons:**
  - Changes the frozen `{sub, sid}` claim set.
  - Needs a session (or a session-less JWT path) for a service user, which spec 329 forbids.
  - Revocation lags up to 15 minutes.
  - The plugin's per-key budget counts exchanges, not MCP requests, so it no longer caps Gemini spend.
  - Needs code in the Worker (token cache, refresh).
- **Risk:** high. Rejected by the briefing (settled point 3).

### Approach 3: per-request verify with a short verdict cache in apps/api

Approach 1 plus an in-process cache of `valid: true` verdicts keyed by a hash of the key, with a TTL of a few seconds.

- **Pros:** fewer apps/auth calls under burst, and brief apps/auth blips do not 503.
- **Cons:**
  - A revocation lags by the TTL.
  - A cached hit spends none of the key's budget, so the plugin's limits undercount and no longer cap spend exactly.
  - apps/api holds a derived secret (the key hash) in memory.
  - More states to test.
- **Risk:** low, but it buys little: MCP volume is modest, and each request already costs a Gemini call that dwarfs one verify.

Not recommended. If load later demands it, the TTL must stay within the plugin's rate-limit window and the revocation lag must be documented (briefing point 2).

**Recommendation: Approach 1.**

## Open Questions

### Critical (owner decision at the spec gate)

1. **The open tier (#87 `?src=` / header-less GET).**
   - **(a) Close it.** Every call needs a key. Browsing AIs and the published snippet lose direct access and are pointed at the MCP server instead.
   - **(b) Keep an open tier.** Requests with **no** `Authorization` header are served under a tight separate cap (a low per-IP limit and a global per-minute ceiling in apps/api), attributed by header or `?src=` as today. Keyed callers get today's limits. A request that **presents** a key that fails is always 401 and never falls back to the open tier, so a revoked key cannot downgrade itself.
   - The evidence that decides it is `ai-skill` thread volume by `client` over the last 30 days. Worker traffic carries `ansari-mcp-*`; `?src=` and header-less traffic carries other ids or NULL:

     ```sql
     select coalesce(client, '(null)') as client, count(*) as threads
     from threads
     where source = 'ai-skill' and created_at > now() - interval '30 days'
     group by 1 order by 2 desc;
     ```

     The builder has no production access; the owner or an architect runs it.
   - **Recommendation: (a)**, unless the query shows real non-Worker traffic. The security architect agrees.

### Important (shapes design; resolved in the plan unless the reviewers object)

1. **The rollout-mode setting:** an env var (`MCP_COMPLETE_KEY_MODE=log-only`, absent → enforce), or a code constant flipped by a follow-up PR.
   - The env var allows an instant rollback to log-only without a code change, but needs a `turbo.json` / `globalEnv` hunk from main and a `docs/self-hosting.md` entry.
   - The constant needs neither, but a rollback needs a PR.
   - Recommendation: the env var, defaulting to enforce.
2. **Where the published integration snippet and the MCP setup page live.** Neither is in this repository. `apps/mcp/docs/show-me-ansari-mcp.html` is an internal walkthrough. The architect is asked to point to them. If they live in another repo or on a site, this PR updates the in-repo docs and the review records the out-of-repo edits as operator or owner steps.
3. **The `ansari-mcp` numbers.** The initial rate limit, window and daily budget, and the alert thresholds, depend on current `ai-skill` volume (the query above). The plan proposes values by judgement; `update-limits` can change them without a deploy.
4. **One key per Worker environment.** Production gets its own key on the production auth database. Beta and dev share staging; the recommendation is one key per environment so their attribution stays distinct.

### Nice-to-know

1. Whether to surface `key_id` on the thread row (a new column, a migration) for audit. Not proposed: the Sentry tag and log line are enough, and the migration belongs to main.
2. Whether the verify route should later serve the leaderboard's key, if the leaderboard migrates off its static secret. Out of scope; the closed permission map makes that an explicit addition.

## Test Scenarios

**apps/auth verify route** (pglite, real plugin, real `auth.apikey`, keys created through the script's code path):

1. A valid `ansari-mcp` key with `{ mcp: ['complete'] }` → 200 `{ valid: true, client_id, key_id }`, and `remaining` decremented by 1.
2. Unknown key, revoked (`enabled = false`), expired (a row set to expire), budget exhausted, rate-limited → the byte-identical `{ valid: false }`, with each row kept.
3. A WhatsApp key (`ansari_wa_…`, `{ whatsapp: ['mint'] }`) with `{ mcp: ['complete'] }` → `{ valid: false }`, and its `remaining` is untouched.
4. `{ whatsapp: ['mint'] }`, an empty object, an extra permission, or a missing `permissions` field → 400, with the plugin never called.
5. A key carrying `mcp: complete` but owned by a non-service user → `{ valid: false }`.
6. An `ansari-mcp` key without `client_id` metadata → `{ valid: false }` and an alert.
7. Service user missing, or duplicated by a forced second row → 500 and an alert.
8. `auth.apikey` dropped, or the DB stopped under the running app → 500, not `valid: false`.
9. Not JSON, wrong content type, oversized body, `key` not a string or over the bound → 400.
10. `OPTIONS` and POST from a browser origin → no `Access-Control-*` header.
11. No path under `/api/auth/api-key/*` becomes reachable, and the blocked-path assertions still pass.
12. Captured logs and Sentry events across scenarios 1–9 contain neither the key nor its first 12 characters.
13. Alerts: window volume, daily volume, `USAGE_EXCEEDED`, `RATE_LIMITED` and refusal volume each fire once per window, with ids and counts only.
14. Script: `create-key ansari-mcp` and `rotate ansari-mcp` without `--client-id` are refused, with nothing written.

**apps/api route** (pglite app DB; apps/auth's verify endpoint stubbed at the HTTP boundary to the contract above):

1. POST and GET without `Authorization` → 401, with no fetch to apps/auth, no thread row and no facilitator call.
2. `Authorization: Basic …`, `Bearer` with an empty token, or a token containing whitespace → 401, with no fetch.
3. Stub `{ valid: false }` → 401 with the same body as case 1, no thread and no facilitator call.
4. Stub `{ valid: true, client_id: 'ansari-mcp-production' }` → 200 with today's body. The thread and all messages have `client = 'ansari-mcp-production'`, `source = 'ai-skill'`, and belong to the `ai-skill` user.
5. Case 4 with `X-Ansari-Client: claude-skill` → `client` is still the key's, and one Sentry warning carries both ids.
6. Case 4 with `?src=evil` → `client` is the key's.
7. Stub network error, a delay past the 3 s timeout, 500, 429, and a 200 with a malformed body → 503, with no thread, no facilitator call, and the response arriving within the timeout plus a margin.
8. A valid key with an invalid body → 400 (verify happens first). No key with an invalid body → 401.
9. The per-IP cap still answers 429 before any verify.
10. Log-only mode: cases 1, 3 and 7 are served 200 with the verdict recorded. Case 4 attributes by the key.
11. Mode absent → enforce.
12. The captured console output and Sentry envelopes for every case contain no part of the key.
13. A WhatsApp key end to end, through a real apps/auth app on pglite where the test harness allows it, otherwise through the stub contract plus apps/auth scenario 3 → 401.

**Non-functional:** a staging smoke test with a real `ansari-mcp` key from the beta Worker: a valid answer, a revoked key giving 401, and the verdict visible in logs. It is recorded in the review, with no key in the record.

## Risks and Mitigation

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Enforcement before the production Worker has its key takes MCP down | Medium | High | Log-only week; enforcement only after zero `missing` / `refused` verdicts from the Worker; the Worker's secret is set first (harmless today) |
| The global key budget is exhausted by a surge, and every MCP user gets 401 | Medium | Medium | Daily refill; alerts at one third of each cap; `update-limits` without a deploy; budget sized from measured volume |
| An apps/auth outage now takes MCP down (503) | Low | Medium | Accepted fail-closed posture (the admin precedent); apps/auth health is already monitored |
| An outage is misread as a refusal (401) inside the relation-check window | Low | Low | Same accepted residual as spec 329; the 401-volume alert surfaces it |
| The key leaks (Worker secret, log, commit) | Low | High | Secret scanning on `ansari_mcp_`; no logging of the key in either app (tested); rotate and revoke per the runbook |
| An unknown-key flood straight at the verify route loads the auth DB | Low | Medium | One indexed lookup each; refusal-volume alert; Railway edge; accepted in spec 329 |
| The verify route is used to spend or test a WhatsApp key | Low | Medium | Closed permission set (400) and owner binding; tested |
| Closing the open tier cuts off real browsing-AI users | Depends on the data | Medium | Owner decision on evidence (Critical 1); option (b) is specified |
| The rollout env var is forgotten in `turbo.json` and is invisible under strict env mode | Medium | Medium | A missing var means enforce (safe default); main adds the `globalEnv` hunk; a test pins the default |

## References

- Issue #314 (this design); issue #320 (attribution and caller identity with API keys); #87 (`?src=` fallback).
- `codev/specs/329-apps-auth-service-api-keys-bet.md`: service identity, plugin behaviour, the WhatsApp exchange.
- `codev/specs/300-better-auth-migration.md`: two databases, public-origin client, no shared secret.
- `docs/cutover/service-keys-runbook.md`.
- `apps/auth/src/routes/whatsapp.ts`, `apps/auth/src/alerts.ts`, `packages/auth/src/service-users.ts`, `packages/auth/src/limits.ts`.
- `apps/api/src/app/api/v2/mcp-complete/route.ts`, `apps/api/lib/auth-service/client.ts`, `apps/api/lib/auth/require-admin.ts`, `apps/api/lib/attribution.ts`.
- `apps/mcp/src/server/ansari-client.ts`, `apps/mcp/src/server/runtime-config.ts`, `apps/mcp/wrangler.jsonc`.
