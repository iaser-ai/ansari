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
