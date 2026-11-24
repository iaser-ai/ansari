# task-W2Vc — Ansari agent skill into the monorepo (#409)

Brief from the security architect, 2026-11-25: move ansari-project/ansari-skill into `skills/ansari`, make it call the MCP server (`https://mcp.askansari.ai/mcp`) instead of apps/api's `/api/v2/mcp-complete`, and open a deprecation-notice PR in the old repository.

## What I found

- The old skill is one file (`ansari/SKILL.md`, v3.4.1). It curls `api.askansari.ai/api/v2/mcp-complete` with no key, which stops working once that route enforces the `ansari-mcp` key (#314). The release asset `ansari-skill.zip` holds `ansari/` and `ansari/SKILL.md` only.
- The MCP server is stateless. One `tools/call` works with no `initialize`. `Accept` must list both `application/json` and `text/event-stream`, or the server answers 406.
- A request without the 2026-07-28 `_meta` envelope is classified LEGACY by the MCP SDK and is answered as SSE even when `MCP_RESPONSE_MODE=json`. A plain JSON body comes back only for a modern-envelope request in json mode (proven against a local server). The parser handles both shapes.
- Tool failures come back as `result.isError: true` with text (`Ansari could not complete this request.`, or the Zod validation text). An unknown tool comes back as a JSON-RPC `error`.
- Attribution: through the MCP server, apps/api stores `threads.client` = the key's `client_id` (source stays `ai-skill`). The separate `ansari-skill` label is gone. The skill's own `X-Ansari-Client` never reaches apps/api, so it was dropped.

## Decisions

- Test placement (option A, approved by security and main): `apps/api/tests/skill-docs.test.ts`, with `$TURBO_ROOT$/skills/**` added to both `test` and `test:coverage` inputs in apps/api/turbo.json. Without it a skill edit left the hash unchanged (proven). Merging triggers one api redeploy; later edits under skills/ match no watch path.
- Owner, 2026-11-25: askansari.ai only. There is no ansari.chat in the new skill, and the test pins that.
- The original MIT notice (Ansari Project) is kept in `skills/LICENSE`. The zip layout is unchanged, so the notice is not inside the zip, the same as the old release.
- ClawHub registry and `npx openskills install ansari-project/ansari-skill` were dropped from the install steps. Both point at the old repository. Flagged in the PR.
