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

Spec approved (Waleed via architect). Merged develop (PR #76 timeout retry)
into branch before planning.

## 2026-08-30 — Plan phase

Plan drafted: 3 phases (schema/migration/helpers → facilitator accumulation →
route wiring + contract tests). Big design choice: error-turn records go to a
separate `tool_call_orphans` table, NOT invisible message rows — invisibility
by construction (no existing query reads it), avoids filters in 5+ messages
consumers and admin-stats skew. PR #76 coherence: ToolResult gains optional
`degradation` ({errorClass?, attempts?, status?}) so persisted records carry
attempts=2 on retried timeouts (today that detail dies at reportDegradedTool).

3-way plan review: gemini APPROVE, claude+codex COMMENT. All folded in:
read-path projection omitting tool_calls (findMessagesByThread /
getThreadWithMessages / createThreadSnapshot — structural contract safety,
avoids ~7KB/row detoast per turn; raw_payload kept for replay);
createToolCallOrphan must NOT bump threads.updatedAt (createMessage does —
verified); mcp-complete facilitator-error 500 contract pinned across the
throw→return refactor; skip_trigger T1/T2 field; degradation fields optional
even when degraded; orphan writes after safeClose(); ToolFetchErrorClass via
type-only import (resilience already type-imports types.ts).

Plan approved (Waleed via architect, 2026-08-31). Coordination note: PR #88
took journal idx 5 / file 0006 — my migration is idx 6, named 0007_*.

## 2026-08-31 — Implement Phase 1 (schema, migration, helpers)

Done: messages.tool_calls + ToolCallRecord types/status taxonomy;
tool_call_orphans table; createToolCallOrphan (no updatedAt bump);
read-path projections (findMessagesByThread/getThreadWithMessages via a
shared column map; createThreadSnapshot selects only role/content/createdAt);
5 test DDLs updated; toolcalls-persistence.test.ts (8 tests).

Merged develop (PR #88) BEFORE generating the migration. drizzle-kit produced
`0006_tool_calls_persistence` (idx 6) — renamed file + journal tag to
`0007_tool_calls_persistence`; snapshot stays `0006_snapshot.json` (snapshots
are idx-named). SQL reviewed: additive only.

Surprise worth knowing: PR #88's new `feedback-upsert.test.ts` carried its own
messages DDL without tool_calls — post-merge, `findMessageInOwnedThread`'s
whole-row select failed with unknown column → 11 tests 500'd. Fixed by adding
the column (now 6 DDL sites). Re-grep DDL sites AFTER every develop merge, not
just once — the issue #70 lesson has a merge-timing corollary.

Full suite: 70 files / 667 pass / 3 pre-existing skips; typecheck clean.
