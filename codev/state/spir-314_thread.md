# spir-314 thread — protect /v2/mcp-complete with service API keys

## 2026-11-11 — specify
- Read the security architect's briefing; it is consistent with the tree (SERVICES['ansari-mcp'] already reserved by 329 with WHATSAPP_KEY_BOUNDS; apps/mcp already forwards ANSARI_API_AUTHORIZATION verbatim).
- Spec drafted: public `POST /api/service/verify-key` modelled on the WhatsApp exchange (ahead of corsFor, relation check for outage vs refusal, alerts); per-request verify in apps/api, 401 one body, 503 fail closed, no verdict cache.
- Design calls made in the spec (reviewers may push back): permissions are a closed set (anything but {mcp:['complete']} → 400, so the route cannot spend a WhatsApp key); `--client-id` required for ansari-mcp keys; rollout mode defaults to ENFORCE when unset (log-only must be explicit).
- Open for owner: close vs keep the ?src= open tier — needs the threads.client query (builder has no prod access). Asked architect where the published snippet / MCP setup page live (not in this repo).

## 2026-11-11 — spec at gate
- Architect answered: proceed on (a) close the open tier, (b) kept as alternative pending owner's threads.client numbers; snippet/setup page are out of repo (public site; live MCP server is owner-operated mcp.ansari.chat) → owner steps in review.
- Folded in: client_id constrained to ansari-mcp[-suffix]; MCP_COMPLETE_KEY_MODE enum (log-only|enforce, absent=enforce, else boot refuses); log-only serves even when apps/auth unreachable ('unverified'); dated follow-up to delete log-only.
- Consults: codex REQUEST_CHANGES (5 precision points, all fixed), gemini COMMENT (list prints client_id; mismatch-warning semantics; {error} envelope). Rebuttals committed. Gate spec-approval pending.

## 2026-11-11 — plugin upgrade question (owner)
- Owner asked whether to upgrade @better-auth/api-key to 1.7.20 and reuse its `/api-key/verify` HTTP endpoint. Checked the published packages (not the docs): `verifyApiKey` is `createAuthEndpoint.serverOnly` with NO route in 1.7.7, 1.7.20 and 1.8.0-beta.7; the docs' `POST /api-key/verify` comes only from a JSDoc comment. Nothing to reuse; our own verify route stays.
- 1.7.7→1.7.20 plugin diff: metadata parse accepts objects as well as JSON text; `markSessionOutsideStore` for key sessions (we have sessions off); rest cosmetic. 1.7.20 peers better-auth/core ^1.7.20, so it is a whole-apps/auth bump: keep it out of #314, separate issue if wanted.
- PLAN INPUT (owner request): add an upgrade guard. On any api-key plugin bump, re-run the endpoint-shape assertions (today 7 endpoints, 5 routed; verify server-only) and confirm any newly routed path (e.g. `/api-key/verify`) is covered by the `/api/auth/api-key` prefix block, with a test that POST /api/auth/api-key/verify is refused. Also pin `metadata.clientId` extraction for both string and object forms.

## 2026-11-11 — plan at gate
- Spec approved by owner (architect ran approval on their written instruction, 03:09Z). Open tier = (a).
- Plan: 5 phases (key rules → apps/auth verify route + upgrade guard → apps/api client + MCP_COMPLETE_KEY_MODE → route gate → docs/arch). Initial MCP limits 120/60s, 5,000/day (judgement, pending owner numbers).
- Consults: codex REQUEST_CHANGES (apps/auth dep path via @ansari/auth re-export; packages/types has no test runner; stub fetch not verifyServiceKey) — all accepted. gemini APPROVE with notes (cutover-docs source scan of alerts.ts must keep ExchangeAlert's 6 kinds; runbook MCP under own ## heading; Sentry client tag parity) — folded in.
- Deploy-order trap flagged: MCP_COMPLETE_KEY_MODE absent = enforce, so log-only must be set on Railway before the apps/api deploy.

## 2026-11-11 — phase 1 (key rules) built
- `MCP_CLIENT_ID_PATTERN` / `isMcpClientId` in `@ansari/types/attribution`, re-exported via `@ansari/auth`. `isMcpClientId` also re-checks `CLIENT_ID_PATTERN`, so an accepted MCP id is always one `parseClientId` keeps unchanged.
- limits.ts: `MCP_KEY_INITIAL` (120/60 s, 5,000/day), its own `MCP_KEY_BOUNDS` (same wide values as WhatsApp's), alerts 40 / 1,666 / 20 per alert window, `VERIFY_BODY_LIMIT` 1024, `VERIFY_KEY_MAX_LENGTH` 256.
- service-users: `ansari-mcp` uses `MCP_KEY_BOUNDS`; `listServiceKeys` selects `metadata`; `clientIdOf()` reads JSON text or an object, null on anything else.
- Script: `clientIdFor()` enforces the rule in `parseArgs` AND `runServiceKeys` (same double-check as `checkKeyLimits`). The existing key-body guard (32-letter run) still applies, so a 64-char all-letter suffix is refused as key-shaped; that is intended. `list` prints `client_id`.
- Mutation check: with the rule disabled, 8 of the new script tests fail; restored, all pass. Full build + `npm test` green (auth 498, @ansari/auth 289, api 1146, frontend 774).

## 2026-11-11 — phase 2 (apps/auth verify route) built
- `POST /api/service/verify-key` (`apps/auth/src/routes/service-verify.ts`), mounted ahead of `corsFor` beside the exchange. Order: requireJson → `express.json` (1 KiB) → parse failure 400 → key bounds (`[\x21-\x7E]{1,256}`) and the closed permission set (exactly `{mcp:['complete']}`, no repeats/extras) → `verifyApiKey` → on refusal the `auth.apikey` relation check then `{valid:false}` → `findServiceUser('ansari-mcp')` (not one → 500 + alert) → owner bind → `clientIdOf` + `isMcpClientId` (fail → `client-id-invalid` + `{valid:false}`) → `{valid, client_id, key_id}`.
- Alerts: `createKeyAlerts` core (thresholds/send/now) behind `createExchangeAlerts` (WhatsApp, unchanged message/tags/thresholds) and new `createMcpVerifyAlerts` (`auth: MCP key verify alert`, tags `mcp-verify-<kind>`). `ExchangeAlert` keeps its six kinds directly above `KeyRefusalCode` (cutover-docs source scan); `McpVerifyAlert` is declared after. Message/tag sender factored to `keyAlertSender`.
- The relation check moved to `routes/apikey-relation.ts`, shared by both routes (each keeps its own cache).
- Plugin facts pinned: metadata comes back from verify as an object in 1.7.7 (stored as JSON text); an EXPIRED key is deleted by the plugin when presented (so "row kept" holds for disabled/exhausted/rate-limited, not expired); a permission refusal leaves remaining/request_count/last_request untouched.
- Stopped DB tested on pglite by closing the client under the running app → 500.
- Upgrade guard in blocked-paths.test.ts: `auth.api.verifyApiKey` has no path, 7 endpoints / 5 routed, and `/api/auth/api-key/verify` + variants are 404.
- Mutation checks: removing the client-id rule, owner bind, relation check, permission check, missing-user 500 or the client-id alert each fails tests; a 20-char key slice in a log line fails both leak scans.
- Full build + `npm test` green (auth 572, @ansari/auth 289, api 1146, frontend 774). WhatsApp suites unchanged and green.

## 2026-11-11 — phase 2 consults, iteration 2
- Gemini APPROVE; Codex REQUEST_CHANGES: spec scenario 2 said every refused row is kept, but the api-key plugin deletes an expired key on presentation.
- Security architect ruled: amend the spec (Amendment 1, plugin fact, no owner gate; architect informs the owner). Done: scenario 2 wording + dated note under the title + References line. The test now asserts the expired row is GONE (and every other refused row kept), so a plugin bump that changes it fails.
- For the review's lessons (spec 329): an expired service key leaves no row behind, so never use expiry on a key whose audit trail matters.
- Also added a pure MCP alert-dedup unit test with an injected clock (plan test-plan item).
- Iter 2: Gemini APPROVE; Codex REQUEST_CHANGES: MCP key-window-volume could fire once per 60 s key window (5× per 5-min alert window). Fixed with a `keyWindowFloorMs` option (MCP = EXCHANGE_ALERT_WINDOW, WhatsApp = 0, unchanged); unit test mutation-checked.

## 2026-11-11 phase 3 — apps/api verify client + MCP_COMPLETE_KEY_MODE
- `verifyServiceKey(key)` in `apps/api/lib/auth-service/client.ts` (`SERVICE_VERIFY_PATH` defined locally). Only an exact 200 `{valid:false}` is a refusal; any non-200, non-JSON, wrong shape, extra field on a refusal, or a client_id off `isMcpClientId` throws `AuthServiceUnavailableError` (route will 503). Mutation-checked: loosening the schema fails 5 tests.
- `MCP_COMPLETE_KEY_MODE` (`log-only` | `enforce`, absent = enforce) -> `config.mcpCompleteKeyMode`; docs row, `.env.example` line (appended from shell), boot-check test.
- turbo.json: direct `afx send architect:main` was refused by the spoofing check; the security architect relayed. Main's answer: carry the `globalEnv` hunk in this PR (done, with a dated removal follow-up, 2026-12-15); main reviews it on the PR.
- Surprise: the plan assumed `self-hosting-docs.test.ts` already checked the whole env surface. It didn't. Added a check that every key of apps/api's `envSchema` (now exported) appears in docs/self-hosting.md; it fails without the new row and passes with it. All existing vars were already documented.
- Flaky once: `tests/auth/require-user.test.ts` (13 tests, `sign-up failed: 404` from the in-process apps/auth) failed in one full `npm test` run, passed in isolation (18/18) and on a full rerun. The file isn't touched by this phase. I documented it rather than skipping it, because skipping would drop the admin-auth coverage.
- New orders for phase 5 (from main, via security): mcp-staging.askansari.ai needs its own key (`--client-id ansari-mcp-staging`) before apps/api staging deploys #314. The `Bearer ansari_mcp_<64 letters>` form goes in apps/mcp README, apps/mcp/.env.example (required once enforcing) and the RELEASE.md mcp rows. Rebase onto develop before phase 5.
