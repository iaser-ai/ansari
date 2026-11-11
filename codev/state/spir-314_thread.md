# spir-314 thread — protect /v2/mcp-complete with service API keys

## 2026-11-11 — specify
- Read the security architect's briefing; it is consistent with the tree (SERVICES['ansari-mcp'] already reserved by 329 with WHATSAPP_KEY_BOUNDS; apps/mcp already forwards ANSARI_API_AUTHORIZATION verbatim).
- Spec drafted: public `POST /api/service/verify-key` modelled on the WhatsApp exchange (ahead of corsFor, relation check for outage vs refusal, alerts); per-request verify in apps/api, 401 one body, 503 fail closed, no verdict cache.
- Design calls made in the spec (reviewers may push back): permissions are a closed set (anything but {mcp:['complete']} → 400, so the route cannot spend a WhatsApp key); `--client-id` required for ansari-mcp keys; rollout mode defaults to ENFORCE when unset (log-only must be explicit).
- Open for owner: close vs keep the ?src= open tier — needs the threads.client query (builder has no prod access). Asked architect where the published snippet / MCP setup page live (not in this repo).
