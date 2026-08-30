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

3-way consultation: gemini APPROVE; claude + codex REQUEST_CHANGES. All
points verified against code and accepted (no contest): error-path turns
persist no assistant row so the degradation rate is a floor over persisted
turns (now stated explicitly, error-path capture flagged as architect
follow-on); ids must be minted at loop level (tracker misses limit-refusals
and T1/T2 skips); status taxonomy (success/degraded/budget-skipped/
limit-refused/unknown-tool) promoted to success criterion; duration is new
instrumentation, ms, NULL for never-executed calls; share snapshot
(`lib/db/shares.ts`) added as second leak-test surface; SSE route added to
integration tests. Rebuttal at
`codev/projects/73-persist-tool-use-and-tool-resu/73-specify-iter1-rebuttals.md`.

Spec-review feedback from Waleed (via architect): (1) error turns are IN
scope — every completed tool dispatch must be recorded regardless of turn
outcome, invisible to GET/replay (mechanism left to the plan); (2) storage
estimate added (~4.2–4.4 GB/yr raw, ~1.5–2.5 GB/yr after TOAST, vs 47 GB
headroom). Spec updated accordingly.

Status: at spec-approval gate, updates sent back to architect, waiting.
