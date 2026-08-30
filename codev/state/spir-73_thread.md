# spir-73 thread — persist tool_use and tool_result

## 2026-08-30 — Specify phase

Spawned in strict mode. No pre-existing spec; drafted
`codev/specs/73-persist-tool-use-and-tool-resu.md` from issue #73 after code
exploration.

Key findings that shaped the spec:

- Three persist sites write assistant messages: `v2/threads/[id]` POST (web),
  `v2/threads/[id]/chat` (SSE), `v2/mcp-complete` (ai-skill). All included in
  scope; `v1/chat/completions` doesn't persist and stays out.
- Facilitator already has all the data in-process: `tracker.callsWithArgs`
  ({tool, args, generated id}) and `processToolCall`'s full `ToolResult`
  (content, documents, `isDegraded`). The streamed events are deliberately
  lossy ({name} / {tool, query, resultCount}) and the SSE route forwards them
  to clients — so enriching events would risk a wire leak. Recommended design:
  accumulate records in the loop and deliver on the `done` event + `onMessage`,
  mirroring how `usage`/`rawPayload` already travel.
- Completeness trap identified: T1/T2 short-circuit skipped calls and
  tool-limit refusals never reach `processToolCall`'s tracker push — they must
  be recorded at the loop level or the denominator undercounts (the exact bug
  class this issue exists to fix). Spec makes distinguishable recording of
  those a success criterion.
- Issue's "Required design" treated as baked (separate nullable `tool_calls`
  jsonb column, migration 0005 via drizzle-kit generate, NOT in `content`).
  No contradictions found.
- pglite test DDL (`CREATE TABLE messages` in ~5 test files) must gain the
  column in the same change — lesson from issue #70.

Status: spec drafted, awaiting porch 3-way consultation then spec-approval gate.
